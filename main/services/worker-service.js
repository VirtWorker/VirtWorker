/**
 * Worker 与 Group 领域服务（员工资源）
 * 职责：校验入参、维护持久化状态、广播变更事件；不感知 Electron 与 UI。
 */

const db = require('../store/db');
const bus = require('../runtime/event-bus');
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

/** 附加展示字段（环境中文名），保持存储数据与展示解耦 */
function decorateWorker(worker) {
  return { ...worker, envLabel: ENV_LABEL[worker.env] || ENV_LABEL.cloud };
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
  next.updatedAt = nowIso();

  db.update('workers', id, next);
  bus.emit('worker:updated', decorateWorker(next));
  return decorateWorker(next);
}

function removeWorker(id) {
  const worker = getWorker(id);
  if (!worker) throw fail.notFound('Worker 不存在');

  // 同步从 Group 成员中摘除，避免出现悬空引用
  db.all('groups')
    .filter((group) => group.memberIds.includes(id))
    .forEach((group) => {
      const next = {
        ...group,
        memberIds: group.memberIds.filter((memberId) => memberId !== id),
        leadWorkerId: group.leadWorkerId === id ? null : group.leadWorkerId,
        updatedAt: nowIso()
      };
      db.update('groups', group.id, next);
      bus.emit('group:updated', decorateGroup(next));
    });

  db.remove('workers', id);
  bus.emit('worker:removed', { id });
  return { id };
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
  bus.emit('group:updated', decorateGroup(next));
  return decorateGroup(next);
}

function removeGroup(id) {
  const group = db.find('groups', id);
  if (!group) throw fail.notFound('Group 不存在');
  group.memberIds.forEach((memberId) => detachGroup(memberId, id));
  db.remove('groups', id);
  bus.emit('group:removed', { id });
  return { id };
}

function attachGroup(workerId, groupId) {
  const worker = getWorker(workerId);
  if (!worker || worker.groupIds.includes(groupId)) return;
  db.update('workers', workerId, { ...worker, groupIds: [...worker.groupIds, groupId] });
}

function detachGroup(workerId, groupId) {
  const worker = getWorker(workerId);
  if (!worker) return;
  db.update('workers', workerId, { ...worker, groupIds: worker.groupIds.filter((gid) => gid !== groupId) });
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