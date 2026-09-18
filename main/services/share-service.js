/**
 * 分享与公开项目服务
 * - 资源包：Worker / WorkerFlow 的配置快照（凭据一律不导出，连接器只留标识）
 * - 导出/导入：JSON 文件形式，跨设备使用；冲突自动改名，能力按名称尽力恢复
 * - 分享记录：「公开项目」清单 = 已分享的资源包，带可见性开关与分享码
 *   分享码是**本机**资源包引用（导入即复制一份到本机），跨设备请使用导出的 JSON 文件。
 */

const { randomBytes } = require('node:crypto');
const db = require('../store/db');
const bus = require('../runtime/event-bus');
const workerService = require('./worker-service');
const flowService = require('./flow-service');
const { createId } = require('../util/id');
const { nowIso } = require('../util/time');
const { fail } = require('../util/errors');

const EXPORT_KIND = 'virtworker.resource';
const EXPORT_VERSION = 1;
const SUPPORTED_TYPES = ['worker', 'flow'];
const TYPE_LABEL = { worker: 'Worker', flow: 'WorkerFlow' };
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  // 用加密随机源避免分享码可预测（Math.random 存在被枚举的风险）
  const block = () =>
    Array.from(randomBytes(4), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
  return `VW-${block()}-${block()}`;
}

function listAll() {
  return db.all('shares');
}

function decorate(share) {
  const { payload, ...rest } = share;
  return {
    ...rest,
    typeLabel: TYPE_LABEL[share.resourceType] || share.resourceType,
    summary: summarize(payload)
  };
}

function summarize(payload) {
  if (!payload) return '';
  if (payload.resourceType === 'worker') {
    const capabilityCount = (payload.capabilities || []).length;
    return `${payload.resource.role} · ${payload.resource.env === 'local' ? '本地' : '云端'}${capabilityCount ? ` · 含 ${capabilityCount} 项能力` : ''}`;
  }
  return `${(payload.nodes || []).length} 个节点`;
}

// ==================== 资源包构造 ====================

/** 导出 Worker：配置 + 能力清单；连接器不含凭据，导入后需重新授权 */
function buildWorkerPayload(workerId) {
  const worker = db.find('workers', workerId);
  if (!worker) throw fail.notFound('Worker 不存在');

  const capabilities = (worker.capabilityIds || [])
    .map((id) => db.find('capabilities', id))
    .filter(Boolean)
    .map((item) => ({
      type: item.type,
      title: item.title,
      connectorKey: item.connectorKey || null,
      requiresCredential: item.type === 'connector'
    }));

  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    resourceType: 'worker',
    exportedAt: nowIso(),
    resource: { name: worker.name, role: worker.role, env: worker.env, desc: worker.desc },
    capabilities
  };
}

/** 导出 WorkerFlow：节点按 Worker 名称记录，导入时按名称匹配 */
function buildFlowPayload(flowId) {
  const flow = db.find('flows', flowId);
  if (!flow) throw fail.notFound('WorkerFlow 不存在');

  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    resourceType: 'flow',
    exportedAt: nowIso(),
    resource: { name: flow.name, desc: flow.desc },
    nodes: flow.nodes.map((node) => {
      const worker = db.find('workers', node.workerId);
      return {
        title: node.title,
        instruction: node.instruction,
        workerName: worker ? worker.name : '',
        capabilityIds: node.capabilityIds || []
      };
    })
  };
}

function buildPayload(resourceType, resourceId) {
  if (!SUPPORTED_TYPES.includes(resourceType)) throw fail.validation('暂不支持该类型的资源包');
  return resourceType === 'flow' ? buildFlowPayload(resourceId) : buildWorkerPayload(resourceId);
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw fail.validation('文件内容不是合法的资源包');
  if (payload.kind !== EXPORT_KIND) throw fail.validation('文件类型不匹配（缺少 VirtWorker 标识）');
  if (Number(payload.version) > EXPORT_VERSION) throw fail.validation('资源包版本高于当前应用支持的版本');
  if (!SUPPORTED_TYPES.includes(payload.resourceType)) throw fail.validation('暂不支持该类型的资源包');
  const resource = payload.resource;
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    throw fail.validation('资源包缺少 resource 内容');
  }
  for (const key of ['name', 'role', 'env', 'desc']) {
    if (resource[key] !== undefined && typeof resource[key] !== 'string') {
      throw fail.validation(`资源字段「${key}」类型不合法`);
    }
  }
  // 数组规模收敛 + 按类型校验必需清单，避免无界遍历与结构缺失
  if (payload.resourceType === 'worker' && !Array.isArray(payload.capabilities)) {
    throw fail.validation('Worker 资源包缺少 capabilities 清单');
  }
  if (payload.resourceType === 'flow' && !Array.isArray(payload.nodes)) {
    throw fail.validation('流程资源包缺少 nodes 清单');
  }
  if (payload.nodes !== undefined && (!Array.isArray(payload.nodes) || payload.nodes.length > 20)) {
    throw fail.validation('资源包节点列表不合法（最多 20 个）');
  }
  if (payload.capabilities !== undefined && (!Array.isArray(payload.capabilities) || payload.capabilities.length > 50)) {
    throw fail.validation('资源包能力列表不合法（最多 50 项）');
  }
  return payload;
}

function uniqueName(base, exists) {
  let name = base.slice(0, 20);
  let index = 2;
  while (exists(name)) {
    const suffix = ` (${index})`;
    name = `${base.slice(0, 20 - suffix.length)}${suffix}`;
    index += 1;
  }
  return name;
}

// ==================== 导入 ====================

function importWorker(payload) {
  const resource = payload.resource || {};
  const name = uniqueName(
    String(resource.name || '导入的 Worker').trim() || '导入的 Worker',
    (candidate) => db.all('workers').some((worker) => worker.name === candidate)
  );

  const worker = workerService.createWorker({
    name,
    role: resource.role,
    env: resource.env,
    desc: resource.desc
  });

  const warnings = [];
  const matched = [];
  (payload.capabilities || []).forEach((item) => {
    const local = db
      .all('capabilities')
      .find((capability) =>
        item.connectorKey ? capability.connectorKey === item.connectorKey : capability.title === item.title && capability.type === item.type
      );
    if (!local) {
      warnings.push(`本机未安装${TYPE_LABEL[item.type] || '能力'}「${item.title}」，已跳过`);
      return;
    }
    if (item.type === 'connector' && local.status !== 'authorized') {
      warnings.push(`连接器「${local.title}」需重新授权后才能使用`);
    }
    matched.push(local.id);
  });

  const created = matched.length ? workerService.updateWorker(worker.id, { capabilityIds: matched }) : worker;
  return { type: 'worker', name: created.name, worker: created, warnings };
}

function importFlow(payload) {
  const resource = payload.resource || {};
  const nodes = payload.nodes || [];
  if (!nodes.length) throw fail.validation('资源包中没有流程节点');

  const missing = nodes.filter((node) => !db.all('workers').some((worker) => worker.name === node.workerName));
  if (missing.length) {
    throw fail.validation(`请先创建这些 Worker：${[...new Set(missing.map((node) => node.workerName || '（未命名）'))].join('、')}`);
  }

  const name = uniqueName(
    String(resource.name || '导入的流程').trim() || '导入的流程',
    (candidate) => db.all('flows').some((flow) => flow.name === candidate)
  );

  const flow = flowService.create({
    name,
    desc: resource.desc,
    nodes: nodes.map((node) => ({
      title: node.title,
      instruction: node.instruction,
      workerId: db.all('workers').find((worker) => worker.name === node.workerName).id,
      capabilityIds: (node.capabilityIds || []).filter((id) => db.find('capabilities', id))
    }))
  });

  return { type: 'flow', name: flow.name, flow, warnings: [] };
}

/** 导入资源包（文件导入与分享码导入共用） */
function importPayload(payload) {
  validatePayload(payload);
  return payload.resourceType === 'flow' ? importFlow(payload) : importWorker(payload);
}

// ==================== 分享记录 / 公开项目 ====================

/** 分享（重复分享同一资源 = 刷新快照） */
function createShare(params = {}) {
  const resourceType = params.resourceType;
  const resourceId = String(params.resourceId ?? '');
  const payload = buildPayload(resourceType, resourceId); // 同时校验资源存在

  const existing = listAll().find((share) => share.resourceType === resourceType && share.resourceId === resourceId);
  if (existing) {
    const next = { ...existing, title: payload.resource.name, payload, updatedAt: nowIso() };
    db.update('shares', existing.id, next);
    bus.emit('share:updated', decorate(next));
    return decorate(next);
  }

  const share = {
    id: createId('sh'),
    code: generateCode(),
    resourceType,
    resourceId,
    title: payload.resource.name,
    payload,
    visibility: params.visibility === 'private' ? 'private' : 'public',
    importCount: 0,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  db.insert('shares', share);
  bus.emit('share:created', decorate(share));
  return decorate(share);
}

function list() {
  return listAll()
    .map(decorate)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function stats() {
  const items = listAll();
  return {
    total: items.length,
    publicCount: items.filter((share) => share.visibility === 'public').length,
    importTotal: items.reduce((total, share) => total + (share.importCount || 0), 0)
  };
}

function setVisibility(id, visibility) {
  const share = listAll().find((item) => item.id === id);
  if (!share) throw fail.notFound('分享记录不存在');
  const next = { ...share, visibility: visibility === 'private' ? 'private' : 'public', updatedAt: nowIso() };
  db.update('shares', id, next);
  bus.emit('share:updated', decorate(next));
  return decorate(next);
}

function remove(id) {
  const share = listAll().find((item) => item.id === id);
  if (!share) throw fail.notFound('分享记录不存在');
  db.remove('shares', id);
  bus.emit('share:removed', { id });
  return { id };
}

function findByCode(code) {
  const normalized = String(code ?? '').trim().toUpperCase();
  if (!normalized) throw fail.validation('请输入分享码');
  const share = listAll().find((item) => item.code === normalized);
  if (!share) throw fail.notFound('分享码无效或对应记录已删除');
  return share;
}

function previewByCode(code) {
  const share = findByCode(code);
  return { share: decorate(share), payload: share.payload };
}

/** 按分享码导入到本机（复制一份新资源，不影响原资源） */
function importByCode(code) {
  const share = findByCode(code);
  const result = importPayload(share.payload);
  const next = { ...share, importCount: (share.importCount || 0) + 1, updatedAt: nowIso() };
  db.update('shares', share.id, next);
  bus.emit('share:updated', decorate(next));
  return result;
}

module.exports = {
  EXPORT_KIND,
  EXPORT_VERSION,
  buildPayload,
  buildWorkerPayload,
  buildFlowPayload,
  validatePayload,
  importPayload,
  createShare,
  list,
  stats,
  setVisibility,
  remove,
  previewByCode,
  importByCode
};