/**
 * Worker 与 Group 领域服务（员工资源）
 * 职责：校验入参、维护持久化状态、广播变更事件；不感知 Electron 与 UI。
 */

const db = require('../store/db');
const bus = require('../runtime/event-bus');
const flowService = require('./flow-service');
const automationService = require('./automation-service');
const chatService = require('./chat-service');
const taskService = require('./task-service');
const { createId } = require('../util/id');
const { nowIso } = require('../util/time');
const { fail } = require('../util/errors');

const ROLES = ['通用助理', '数据分析', '内容创作', '研发工程'];
const ENV_LABEL = { cloud: '云端', local: '本地' };
const STATUS = { online: 'online', offline: 'offline' };

const AVATAR_COLORS = [
  'linear-gradient(135deg,#6ee7a0,#10a54a)',
  'linear-gradient(135deg,#8fc2ff,#3d7fe0)',
  'linear-gradient(135deg,#ffd28a,#f5a623)',
  'linear-gradient(135deg,#f0a6d8,#d95fb0)',
  'linear-gradient(135deg,#9ae0e8,#22aab5)'
];

/** 界面上的中文枚举 → 存储枚举 */
function normalizeEnv(value) {
  return value === 'local' || value === '本地' ? 'local' : 'cloud';
}

function normalizeStatus(value) {
  if (value === 'offline' || value === '离线') return STATUS.offline;
  if (value === 'online' || value === '在线') return STATUS.online;
  return null;
}

/** 附加展示字段（环境中文名、已挂载能力数），保持存储数据与展示解耦 */
function decorateWorker(worker) {
  return {
    ...worker,
    envLabel: ENV_LABEL[worker.env] || ENV_LABEL.cloud,
    capabilityCount: (worker.capabilityIds || []).length
  };
}

function allWorkers() {
  return db.all('workers');
}

function getWorker(id) {
  return db.find('workers', id);
}

// ==================== Worker ====================

function listWorkers(filter = {}) {
  let items = allWorkers();
  const keyword = String(filter.keyword ?? '').trim().toLowerCase();
  if (keyword) {
    items = items.filter((w) =>
      `${w.name} ${w.desc || ''} ${w.role}`.toLowerCase().includes(keyword)
    );
  }
  if (filter.role && filter.role !== '全部角色') {
    items = items.filter((w) => w.role === filter.role);
  }
  if (filter.env && filter.env !== '全部环境') {
    items = items.filter((w) => w.env === normalizeEnv(filter.env));
  }
  const status = normalizeStatus(filter.status);
  if (status) {
    items = items.filter((w) => w.status === status);
  }

  const sort = filter.sort || '默认排序';
  if (sort === '名称') {
    items = [...items].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  } else if (sort === '最近创建') {
    items = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return items.map(decorateWorker);
}

function createWorker(params = {}) {
  const name = String(params.name ?? '').trim();
  if (!name) throw fail.validation('请填写 Worker 名称');
  if (name.length > 20) throw fail.validation('Worker 名称最多 20 个字符');
  if (allWorkers().some((w) => w.name === name)) {
    throw fail.conflict(`已存在同名 Worker「${name}」`);
  }

  const worker = {
    id: createId('wk'),
    name,
    role: ROLES.includes(params.role) ? params.role : ROLES[0],
    env: normalizeEnv(params.env),
    desc: String(params.desc ?? '').trim().slice(0, 100),
    status: STATUS.online,
    avatarColor: AVATAR_COLORS[allWorkers().length % AVATAR_COLORS.length],
    capabilityIds: [],
    groupIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  db.insert('workers', worker);
  bus.emit('worker:created', decorateWorker(worker));
  return decorateWorker(worker);
}

function updateWorker(id, patch = {}) {
  const worker = getWorker(id);
  if (!worker) throw fail.notFound('Worker 不存在');

  const next = { ...worker };
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw fail.validation('请填写 Worker 名称');
    if (name.length > 20) throw fail.validation('Worker 名称最多 20 个字符');
    if (allWorkers().some((w) => w.id !== id && w.name === name)) {
      throw fail.conflict(`已存在同名 Worker「${name}」`);
    }
    next.name = name;
  }
  if (patch.role !== undefined && ROLES.includes(patch.role)) next.role = patch.role;
  if (patch.env !== undefined) next.env = normalizeEnv(patch.env);
  if (patch.desc !== undefined) next.desc = String(patch.desc).trim().slice(0, 100);
  if (patch.status !== undefined) {
    const status = normalizeStatus(patch.status);
    if (status) next.status = status;
  }
  if (patch.capabilityIds !== undefined) {
    const ids = Array.isArray(patch.capabilityIds) ? patch.capabilityIds.map(String) : [];
    const unique = [...new Set(ids)];
    unique.forEach((capabilityId) => {
      if (!db.find('capabilities', capabilityId)) throw fail.notFound('所选能力中包含已卸载的项，请刷新后重试');
    });
    next.capabilityIds = unique;
  }
  next.updatedAt = nowIso();

  db.update('workers', id, next);
  bus.emit('worker:updated', decorateWorker(next));
  return decorateWorker(next);
}

function removeWorker(id) {
  const worker = getWorker(id);
  if (!worker) throw fail.notFound('Worker 不存在');

  // 悬空引用防护：流程依赖该 Worker 时必须先调整流程（自动删节点会静默改变流程语义）
  const usedFlows = flowService.list({ workerId: id }).items;
  if (usedFlows.length) {
    throw fail.validation(
      `该 Worker 正被流程「${usedFlows.map((flow) => flow.name).join('、')}」使用，请先在流程中替换或移除对应步骤`
    );
  }

  // 同步从 Group 成员中摘除，避免出现悬空引用
  const emptiedGroupIds = [];
  db.all('groups')
    .filter((group) => group.memberIds.includes(id))
    .forEach((group) => {
      const next = {
        ...group,
        memberIds: group.memberIds.filter((memberId) => memberId !== id),
        leadWorkerId: group.leadWorkerId === id ? null : group.leadWorkerId,
        updatedAt: nowIso()
      };
      if (!next.memberIds.length) emptiedGroupIds.push(group.id);
      db.update('groups', group.id, next);
      bus.emit('group:updated', decorateGroup(next));
    });

  // 级联：停用执行者已失效的自动任务（直接绑定该 Worker，或绑定删除后成员清空的 Group）
  const disabledAutomations = [
    ...automationService.disableByExecutor(
      { workerId: id },
      '其执行者 Worker 已被删除，请重新指定执行者后再启用'
    ),
    ...automationService.disableByExecutor(
      { groupIds: emptiedGroupIds },
      '其执行者 Group 的成员已被清空，请重新指定执行者后再启用'
    )
  ];

  // 级联：事件触发器里限定执行者指向被删 Worker 时清空限定（变为不限执行者）。
  // 悬空后事件条件永不命中，自动化会静默失效且无任何提示
  automationService.listAll().forEach((automation) => {
    if (automation.trigger.type === 'event' && automation.trigger.event?.assigneeId === id) {
      automationService.update(automation.id, {
        trigger: { type: 'event', event: { source: automation.trigger.event.source, assigneeId: '' } }
      });
      bus.emit('app:notice', {
        level: 'warning',
        title: `自动任务「${automation.name}」已解除执行者限定`,
        body: '其事件触发器限定的 Worker 已被删除，现在任意执行者的任务都能触发它'
      });
    }
  });

  // 级联：取消该 Worker（及其被清空 Group）名下的在途任务。
  // 否则任务要等到槽位释放或离线退避重试才失败，成为"延迟僵尸"，还会以幽灵执行者的名义继续执行
  const canceledTasks = taskService.cancelActiveByAssignees([id, ...emptiedGroupIds], '执行者已被删除，任务自动取消');

  // 级联：清理该 Worker 的聊天绑定，避免 @Worker 入站消息命中悬空 workerId 后每条消息都报错
  const removedBindings = chatService.removeBindingsByWorker(id);

  db.remove('workers', id);
  bus.emit('worker:removed', { id });
  return {
    id,
    disabledAutomations,
    canceledTasks,
    removedBindings
  };
}

// ==================== Group ====================

function decorateGroup(group) {
  const members = group.memberIds
    .map((memberId) => getWorker(memberId))
    .filter(Boolean)
    .map(decorateWorker);
  return { ...group, members, memberCount: members.length };
}

function listGroups() {
  return db.all('groups').map(decorateGroup);
}

function normalizeMemberIds(memberIds) {
  const ids = Array.isArray(memberIds) ? memberIds.map(String) : [];
  const unique = [...new Set(ids)];
  unique.forEach((memberId) => {
    if (!getWorker(memberId)) throw fail.notFound('所选成员中包含不存在的 Worker');
  });
  return unique;
}

function createGroup(params = {}) {
  const name = String(params.name ?? '').trim();
  if (!name) throw fail.validation('请填写 Group 名称');
  if (name.length > 20) throw fail.validation('Group 名称最多 20 个字符');
  if (db.all('groups').some((g) => g.name === name)) {
    throw fail.conflict(`已存在同名 Group「${name}」`);
  }

  const memberIds = normalizeMemberIds(params.memberIds);
  const leadWorkerId = memberIds.includes(params.leadWorkerId) ? params.leadWorkerId : memberIds[0] || null;

  const group = {
    id: createId('gp'),
    name,
    desc: String(params.desc ?? '').trim().slice(0, 100),
    memberIds,
    leadWorkerId,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  db.insert('groups', group);
  memberIds.forEach((memberId) => attachGroup(memberId, group.id));
  bus.emit('group:created', decorateGroup(group));
  return decorateGroup(group);
}

function updateGroup(id, patch = {}) {
  const group = db.find('groups', id);
  if (!group) throw fail.notFound('Group 不存在');

  const next = { ...group };
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw fail.validation('请填写 Group 名称');
    if (db.all('groups').some((g) => g.id !== id && g.name === name)) {
      throw fail.conflict(`已存在同名 Group「${name}」`);
    }
    next.name = name;
  }
  if (patch.desc !== undefined) next.desc = String(patch.desc).trim().slice(0, 100);
  if (patch.memberIds !== undefined) next.memberIds = normalizeMemberIds(patch.memberIds);
  next.leadWorkerId = next.memberIds.includes(patch.leadWorkerId)
    ? patch.leadWorkerId
    : next.memberIds.includes(next.leadWorkerId)
      ? next.leadWorkerId
      : next.memberIds[0] || null;
  next.updatedAt = nowIso();

  // 同步成员的双向引用
  group.memberIds.filter((memberId) => !next.memberIds.includes(memberId)).forEach((memberId) => detachGroup(memberId, id));
  next.memberIds.filter((memberId) => !group.memberIds.includes(memberId)).forEach((memberId) => attachGroup(memberId, id));

  db.update('groups', id, next);

  // 级联：成员被清空的 Group 不再可派发——停用其自动任务并取消在途任务。
  // 与 removeGroup/removeWorker 对称：否则调度器每次触发都因「该 Group 没有成员」失败
  // 且用户无任何通知（fireSafely 只推进计划），自动化成为"启用中却永不成功"的静默故障
  let disabledAutomations = [];
  let canceledTasks = [];
  if (group.memberIds.length && !next.memberIds.length) {
    disabledAutomations = automationService.disableByExecutor(
      { groupId: id },
      '其执行者 Group 的成员已被清空，请重新指定执行者后再启用'
    );
    canceledTasks = taskService.cancelActiveByAssignees([id], '执行者 Group 的成员已被清空，任务自动取消');
  }

  bus.emit('group:updated', decorateGroup(next));
  return { ...decorateGroup(next), disabledAutomations, canceledTasks };
}

function removeGroup(id) {
  const group = db.find('groups', id);
  if (!group) throw fail.notFound('Group 不存在');
  group.memberIds.forEach((memberId) => detachGroup(memberId, id));

  // 级联：停用执行者绑定该 Group 的自动任务（与 removeWorker 对称）。
  // 否则调度器每次触发都会因执行者缺失而失败，interval 模式下还会反复重试刷屏
  const disabledAutomations = automationService.disableByExecutor(
    { groupId: id },
    '其执行者 Group 已被删除，请重新指定执行者后再启用'
  );

  db.remove('groups', id);
  bus.emit('group:removed', { id });
  return { id, disabledAutomations };
}

function attachGroup(workerId, groupId) {
  const worker = getWorker(workerId);
  if (!worker || worker.groupIds.includes(groupId)) return;
  const next = db.update('workers', workerId, { ...worker, groupIds: [...worker.groupIds, groupId] });
  bus.emit('worker:updated', decorateWorker(next));
}

function detachGroup(workerId, groupId) {
  const worker = getWorker(workerId);
  if (!worker) return;
  const next = db.update('workers', workerId, {
    ...worker,
    groupIds: worker.groupIds.filter((gid) => gid !== groupId)
  });
  bus.emit('worker:updated', decorateWorker(next));
}

/** 取执行者对应的 Worker 实体（Group 归一到组长/首个成员），供运行时派发使用 */
function resolveExecutorWorker(assignee) {
  if (!assignee) return null;
  if (assignee.type === 'worker') return getWorker(assignee.id);
  const group = db.find('groups', assignee.id);
  if (!group) return null;
  const leadId = group.leadWorkerId || group.memberIds[0];
  return leadId ? getWorker(leadId) : null;
}

module.exports = {
  ROLES,
  listWorkers,
  getWorker,
  createWorker,
  updateWorker,
  removeWorker,
  listGroups,
  createGroup,
  updateGroup,
  removeGroup,
  resolveExecutorWorker
};