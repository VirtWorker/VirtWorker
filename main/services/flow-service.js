/**
 * WorkerFlow 领域服务
 * 流程 = 有序步骤列表，每步绑定一个 Worker 与指令模板（可插入 Skill）。
 * 被任务/自动任务引用时（executor.type = flow），运行时逐步委派给各节点 Worker。
 */

const db = require('../store/db');
const bus = require('../runtime/event-bus');
const { createId } = require('../util/id');
const { nowIso } = require('../util/time');
const { fail } = require('../util/errors');

const MAX_NODES = 8;

function listAll() {
  return db.all('flows');
}

function getOrThrow(id) {
  const found = db.find('flows', id);
  if (!found) throw fail.notFound('WorkerFlow 不存在');
  return found;
}

function decorate(flow) {
  const nodes = flow.nodes.map((node) => {
    const worker = db.find('workers', node.workerId);
    return { ...node, workerName: worker ? worker.name : '（Worker 已删除）', workerMissing: !worker };
  });
  return { ...flow, nodes, nodeCount: nodes.length, missingWorkers: nodes.filter((node) => node.workerMissing).length };
}

/** 校验并归一化节点：每个节点必须绑定存在的 Worker，指令模板必填 */
function normalizeNodes(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) throw fail.validation('请至少添加一个流程步骤');
  if (nodes.length > MAX_NODES) throw fail.validation(`流程步骤最多 ${MAX_NODES} 个`);

  return nodes.map((node, index) => {
    const worker = db.find('workers', String(node.workerId ?? ''));
    if (!worker) throw fail.notFound(`第 ${index + 1} 步绑定的 Worker 不存在`);
    const instruction = String(node.instruction ?? '').trim();
    if (!instruction) throw fail.validation(`第 ${index + 1} 步请填写指令模板`);
    if (instruction.length > 300) throw fail.validation(`第 ${index + 1} 步指令最多 300 字`);
    return {
      id: node.id || createId('nd'),
      title: String(node.title ?? '').trim().slice(0, 30) || `步骤 ${index + 1}`,
      workerId: worker.id,
      instruction,
      capabilityIds: (Array.isArray(node.capabilityIds) ? node.capabilityIds : []).filter((id) => db.find('capabilities', id))
    };
  });
}

// ==================== 查询 ====================

function list(filter = {}) {
  let items = listAll();
  const keyword = String(filter.keyword ?? '').trim().toLowerCase();
  if (keyword) {
    items = items.filter((flow) => `${flow.name} ${flow.desc}`.toLowerCase().includes(keyword));
  }
  if (filter.workerId) {
    items = items.filter((flow) => flow.nodes.some((node) => node.workerId === filter.workerId));
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items: items.map(decorate), total: items.length };
}

function stats() {
  const items = listAll();
  return {
    total: items.length,
    nodeTotal: items.reduce((total, flow) => total + flow.nodes.length, 0),
    usable: items.filter((flow) => flow.nodes.every((node) => db.find('workers', node.workerId))).length
  };
}

function detail(id) {
  return { flow: decorate(getOrThrow(id)) };
}

/** 执行计划：把节点展开成运行时步骤（带节点 Worker 与指令） */
function buildPlan(flowId) {
  const flow = getOrThrow(flowId);
  return {
    flow: decorate(flow),
    nodes: flow.nodes.map((node) => ({ ...node, worker: db.find('workers', node.workerId) }))
  };
}

// ==================== 增删改 ====================

function create(params = {}) {
  const name = String(params.name ?? '').trim();
  if (!name) throw fail.validation('请填写流程名称');
  if (name.length > 30) throw fail.validation('流程名称最多 30 个字符');
  if (listAll().some((flow) => flow.name === name)) throw fail.conflict(`已存在同名流程「${name}」`);

  const flow = {
    id: createId('fl'),
    name,
    desc: String(params.desc ?? '').trim().slice(0, 100),
    nodes: normalizeNodes(params.nodes),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  db.insert('flows', flow);
  bus.emit('flow:created', decorate(flow));
  return decorate(flow);
}

function update(id, patch = {}) {
  const flow = getOrThrow(id);
  const next = { ...flow };

  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw fail.validation('请填写流程名称');
    if (listAll().some((item) => item.id !== id && item.name === name)) {
      throw fail.conflict(`已存在同名流程「${name}」`);
    }
    next.name = name;
  }
  if (patch.desc !== undefined) next.desc = String(patch.desc).trim().slice(0, 100);
  if (patch.nodes !== undefined) next.nodes = normalizeNodes(patch.nodes);
  next.updatedAt = nowIso();

  db.update('flows', id, next);
  bus.emit('flow:updated', decorate(next));
  return decorate(next);
}

function remove(id) {
  getOrThrow(id);
  db.remove('flows', id);
  bus.emit('flow:removed', { id });
  return { id };
}

module.exports = { MAX_NODES, list, stats, detail, buildPlan, create, update, remove };