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
const { requiredText, optionalText, assertUniqueName, assertEnum, requireArray } = require('../util/validate');
const { nowIso } = require('../util/time');
const { fail } = require('../util/errors');

const ROLES = ['通用助理', '数据分析', '内容创作', '研发工程'];
/** 运行环境已收敛为纯本地模式（云端 Worker 已移除）：label 仅保留本地，
 *  旧数据中的 cloud 由 decorateWorker 兜底显示为本地、下次更新时自动改写 */
const ENV_LABEL = { local: '本地' };
const STATUS = { online: 'online', offline: 'offline' };

const AVATAR_COLORS = [
  'linear-gradient(135deg,#6ee7a0,#10a54a)',
  'linear-gradient(135deg,#8fc2ff,#3d7fe0)',
  'linear-gradient(135deg,#ffd28a,#f5a623)',
  'linear-gradient(135deg,#f0a6d8,#d95fb0)',
  'linear-gradient(135deg,#9ae0e8,#22aab5)'
];

/** 运行环境（原 cloud | local 枚举）：云端模式移除后退化为系统固定值 local。
 *  入参不再校验——UI 已删除选择项，外部调用传入任何值（含旧包的 cloud）都收敛为本地 */
function normalizeEnv() {
  return 'local';
}

function normalizeStatus(value) {
  if (value === undefined || value === null || value === '') return null;
  return assertEnum(value, [STATUS.online, STATUS.offline], { label: '运行状态' });
}

/** 附加展示字段（环境中文名、已挂载能力数），保持存储数据与展示解耦 */
function decorateWorker(worker) {
  return {
    ...worker,
    envLabel: ENV_LABEL[worker.env] || ENV_LABEL.local,
    capabilityCount: (worker.capabilityIds || []).length
  };
}

/** 单集合全量读取，命名对齐 capability/automation/flow/share 服务的 listAll 惯例 */
function listAll() {
  return db.all('workers');
}

function getWorker(id) {
  return db.find('workers', id);
}

// ==================== Worker ====================

function listWorkers(filter = {}) {
  let items = listAll();
  const keyword = String(filter.keyword ?? '').trim().toLowerCase();
  if (keyword) {
    items = items.filter((w) =>
      `${w.name} ${w.desc || ''} ${w.role}`.toLowerCase().includes(keyword)
    );
  }
  if (filter.role) {
    items = items.filter((w) => w.role === filter.role);
  }
  if (filter.env) {
    items = items.filter((w) => w.env === normalizeEnv());
  }
  const status = normalizeStatus(filter.status);
  if (status) {
    items = items.filter((w) => w.status === status);
  }

  const sort = filter.sort || '';
  if (sort === 'name') {
    items = [...items].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  } else if (sort === 'newest') {
    items = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return items.map(decorateWorker);
}

function createWorker(params = {}) {
  const name = requiredText(params.name, { label: 'Worker 名称', max: 20 });
  // 免克隆唯一性校验（B1）：existsFn 替代「listAll() 全量深拷贝后 some」
  assertUniqueName((candidate) => db.exists('workers', (w) => w.name === candidate), name, { label: 'Worker' });

  const worker = {
    id: createId('wk'),
    name,
    role: params.role === undefined ? ROLES[0] : assertEnum(params.role, ROLES, { label: '角色' }),
    env: normalizeEnv(), // 入参已废弃（环境收敛为本地），签名不再接收参数
    desc: optionalText(params.desc, 100),
    status: STATUS.online,
    avatarColor: AVATAR_COLORS[db.count('workers') % AVATAR_COLORS.length], // count 免克隆（B1）
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
    const name = requiredText(patch.name, { label: 'Worker 名称', max: 20 });
    assertUniqueName((candidate) => db.exists('workers', (w) => w.name === candidate && w.id !== id), name, {
      label: 'Worker',
      exceptId: id
    });
    next.name = name;
  }
  if (patch.role !== undefined) next.role = assertEnum(patch.role, ROLES, { label: '角色' });
  if (patch.env !== undefined) next.env = normalizeEnv(); // 移除误导性的幽灵第二参数（F4）
  if (patch.desc !== undefined) next.desc = optionalText(patch.desc, 100);
  if (patch.status !== undefined) {
    const status = normalizeStatus(patch.status);
    if (status) next.status = status;
  }
  if (patch.capabilityIds !== undefined) {
    // O12 危险默认值修复：非数组显式报错（原先静默清空 = 一键卸载全部能力）
    const ids = requireArray(patch.capabilityIds, { label: '能力列表' }) ?? [];
    const unique = [...new Set(ids.map(String))];
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

  // 同步从 Group 成员中摘除，避免出现悬空引用（query 只克隆命中项，B1）
  const emptiedGroupIds = [];
  db.query('groups', (group) => group.memberIds.includes(id))
    .map((group) => ({
      ...group,
      memberIds: group.memberIds.filter((memberId) => memberId !== id),
      leadWorkerId: group.leadWorkerId === id ? null : group.leadWorkerId,
      updatedAt: nowIso()
    }))
    .forEach((next) => {
      const emptied = !next.memberIds.length;
      db.update('groups', next.id, next);
      if (emptied) emptiedGroupIds.push(next.id);
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
  // 悬空后事件条件永不命中，自动化会静默失效且无任何提示（query 只克隆事件型，B1）
  db
    .query('automations', (a) => a.trigger.type === 'event' && a.trigger.event?.assigneeId === id)
    .forEach((automation) => {
      automationService.update(automation.id, {
        trigger: { type: 'event', event: { source: automation.trigger.event.source, assigneeId: '' } }
      });
      bus.emit('app:notice', {
        level: 'warning',
        title: `自动任务「${automation.name}」已解除执行者限定`,
        body: '其事件触发器限定的 Worker 已被删除，现在任意执行者的任务都能触发它'
      });
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
  // O12：显式传入但不是数组时抛错；undefined 视为内部缺省（允许显式空组，派发端已拦截）
  if (memberIds !== undefined && !Array.isArray(memberIds)) {
    throw fail.validation('成员列表格式不正确');
  }
  const ids = (memberIds ?? []).map(String);
  const unique = [...new Set(ids)];
  unique.forEach((memberId) => {
    if (!getWorker(memberId)) throw fail.notFound('所选成员中包含不存在的 Worker');
  });
  return unique;
}

function createGroup(params = {}) {
  const name = requiredText(params.name, { label: 'Group 名称', max: 20 });
  assertUniqueName((candidate) => db.exists('groups', (g) => g.name === candidate), name, { label: 'Group' });

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
    const name = requiredText(patch.name, { label: 'Group 名称', max: 20 });
    assertUniqueName((candidate) => db.exists('groups', (g) => g.name === candidate && g.id !== id), name, {
      label: 'Group',
      exceptId: id
    });
    next.name = name;
  }
  if (patch.desc !== undefined) next.desc = optionalText(patch.desc, 100);
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

/**
 * Group 派发的协作语义（E6）：蓝图 §4.2「派发给组长，其余成员记为协作」的落地——
 * 派发时把组长与协作成员写入任务时间线，看板详情可回答「这个组里谁参与了」。
 * 非 Group 执行者返回 null（运行时据此跳过）。
 */
function describeGroupCollaboration(assignee) {
  if (!assignee || assignee.type !== 'group') return null;
  const group = db.find('groups', assignee.id);
  if (!group) return null;
  const leadId = group.leadWorkerId || group.memberIds[0];
  const lead = leadId ? getWorker(leadId) : null;
  if (!lead) return null;
  const collaborators = group.memberIds
    .filter((memberId) => memberId !== lead.id)
    .map((memberId) => getWorker(memberId))
    .filter(Boolean)
    .map((worker) => worker.name);
  return collaborators.length
    ? `Group「${group.name}」由组长「${lead.name}」执行，成员「${collaborators.join('、')}」协作`
    : `Group「${group.name}」由组长「${lead.name}」执行（当前无其他成员协作）`;
}

module.exports = {
  ROLES,
  decorateWorker,
  listWorkers,
  getWorker,
  createWorker,
  updateWorker,
  removeWorker,
  listGroups,
  createGroup,
  updateGroup,
  removeGroup,
  resolveExecutorWorker,
  describeGroupCollaboration
};