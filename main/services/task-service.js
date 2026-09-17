/**
 * 任务领域服务
 * 职责：任务生命周期（创建 → 派发 → 执行 → 需要操作 → 恢复 → 结果 → 查收）、
 *       看板统计与筛选口径的唯一实现、TaskEvent 时间线维护。
 * 说明：执行细节由 runtime 驱动，本服务只做状态与持久化，保证口径集中在一处。
 */

const db = require('../store/db');
const bus = require('../runtime/event-bus');
const { createId } = require('../util/id');
const { nowIso, isWithinPeriod } = require('../util/time');
const { fail } = require('../util/errors');

const STATUS = Object.freeze({
  queued: 'queued',
  running: 'running',
  needAction: 'need_action',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled'
});

/** 进行中：已创建待派发 + 执行中 */
const ACTIVE_STATUS = [STATUS.queued, STATUS.running];
const FINISHED_STATUS = [STATUS.succeeded, STATUS.failed, STATUS.canceled];

const TRIGGER_LABEL = {
  manual: '手动创建',
  schedule: '定时触发',
  event: '事件触发',
  api: 'API 触发',
  chat: '会话触发'
};

/** 界面筛选项文本 → 存储枚举（与 index.html 中的 option 一一对应） */
const STATUS_FILTER = {
  进行中: ACTIVE_STATUS,
  需要操作: [STATUS.needAction],
  已结束: FINISHED_STATUS
};

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const MAX_EVENTS = 200;

// ==================== 内部工具 ====================

/** 对外输出剥离 events（时间线体积大，仅详情接口返回） */
function publicTask(task) {
  const { events, ...rest } = task;
  return rest;
}

function appendEvent(task, type, message, extra = {}) {
  task.events.push({ id: createId('ev'), taskId: task.id, type, message, ...extra, at: nowIso() });
  if (task.events.length > MAX_EVENTS) task.events = task.events.slice(-MAX_EVENTS);
}

function publish(task, eventType) {
  bus.emit(eventType, publicTask(task));
}

/** 读-改-写：所有状态变更都经此，保证 updatedAt 与持久化一致 */
function mutate(id, updater) {
  const task = getOrThrow(id);
  updater(task);
  task.updatedAt = nowIso();
  db.update('tasks', id, task);
  return task;
}

function getTask(id) {
  return db.find('tasks', id);
}

function getOrThrow(id) {
  const task = getTask(id);
  if (!task) throw fail.notFound('任务不存在');
  return task;
}

function normalizeTrigger(trigger) {
  const type = TRIGGER_LABEL[trigger?.type] ? trigger.type : 'manual';
  return {
    type,
    refId: trigger?.refId ?? null,
    /** 事件触发链深度：防止自动任务互相触发形成无限循环 */
    depth: Number.isInteger(trigger?.depth) ? trigger.depth : 0,
    label: TRIGGER_LABEL[type]
  };
}

/** 解析执行者：支持 Worker 与 Group（Group 归一为组长/首个成员代表执行） */
function resolveAssignee(assigneeId) {
  const id = String(assigneeId ?? '').trim();
  if (!id) throw fail.validation('请选择执行者');

  if (id.startsWith('gp_')) {
    const group = db.find('groups', id);
    if (!group) throw fail.notFound('所选 Group 不存在');
    const leadId = group.leadWorkerId || group.memberIds[0];
    const lead = leadId ? db.find('workers', leadId) : null;
    return { type: 'group', id: group.id, name: group.name, env: lead?.env ?? 'cloud' };
  }

  if (id.startsWith('fl_')) {
    const flow = db.find('flows', id);
    if (!flow) throw fail.notFound('所选 WorkerFlow 不存在');
    return { type: 'flow', id: flow.id, name: flow.name, env: 'cloud' };
  }

  const worker = db.find('workers', id);
  if (!worker) throw fail.notFound('所选 Worker 不存在');
  return { type: 'worker', id: worker.id, name: worker.name, env: worker.env };
}

// ==================== 创建 / 查询 ====================

function create(params = {}) {
  const goal = String(params.goal ?? '').trim();
  if (!goal) throw fail.validation('任务目标不能为空');
  if (goal.length > 500) throw fail.validation('任务目标最多 500 字');

  const assignee = resolveAssignee(params.assigneeId);
  const trigger = normalizeTrigger(params.trigger);
  const title = String(params.title ?? '').trim() || goal.slice(0, 24);

  const task = {
    id: createId('tk'),
    title: title.slice(0, 60),
    goal,
    status: STATUS.queued,
    priority: PRIORITIES.includes(params.priority) ? params.priority : 'normal',
    trigger,
    assignee,
    confirmFirst: Boolean(params.confirmFirst),
    workspace: { cwd: String(params.workspace ?? '').trim(), env: assignee.env },
    input: { payload: params.payload ?? {}, attachments: [] },
    steps: [],
    progress: 0,
    actionRequest: null,
    result: null,
    resultAckedAt: null,
    error: null,
    tags: Array.isArray(params.tags) ? params.tags.slice(0, 5) : [],
    createdAt: nowIso(),
    startedAt: null,
    updatedAt: nowIso(),
    finishedAt: null,
    events: []
  };

  appendEvent(task, 'created', `任务已创建（${trigger.label}）`);
  db.insert('tasks', task);
  publish(task, 'task:created');
  bus.command('task:queued', task.id); // 通知运行时派发
  return publicTask(task);
}

function list(filter = {}) {
  // period 显式传空字符串表示不限时间（如自动任务的运行历史）
  const period = filter.period === undefined ? 'month' : filter.period;
  let items = db.all('tasks').filter((task) => isWithinPeriod(task.createdAt, period));

  if (filter.refId) items = items.filter((task) => task.trigger.refId === filter.refId);

  const statuses = STATUS_FILTER[filter.status];
  if (statuses) items = items.filter((task) => statuses.includes(task.status));

  // 「触发方式」筛选：界面传中文标签，转为存储枚举
  const triggerKey =
    Object.keys(TRIGGER_LABEL).find((key) => TRIGGER_LABEL[key] === filter.triggerType) ||
    (TRIGGER_LABEL[filter.triggerType] ? filter.triggerType : null);
  if (triggerKey) items = items.filter((task) => task.trigger.type === triggerKey);

  if (filter.assigneeId && filter.assigneeId !== '全部') {
    items = items.filter((task) => task.assignee.id === filter.assigneeId);
  }

  const keyword = String(filter.keyword ?? '').trim().toLowerCase();
  if (keyword) {
    items = items.filter((task) =>
      `${task.title} ${task.goal} ${task.assignee.name}`.toLowerCase().includes(keyword)
    );
  }

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const limited = filter.limit ? items.slice(0, filter.limit) : items;
  return { items: limited.map(publicTask), total: items.length };
}

/** 看板统计口径（与 list 共用同一时间过滤，保证数字与列表一致） */
function stats(period = 'month') {
  const items = db.all('tasks').filter((task) => isWithinPeriod(task.createdAt, period));
  const active = items.filter((task) => ACTIVE_STATUS.includes(task.status));
  return {
    total: items.length,
    running: active.length,
    needAction: items.filter((task) => task.status === STATUS.needAction).length,
    finished: items.filter((task) => FINISHED_STATUS.includes(task.status)).length,
    workingWorkers: new Set(active.map((task) => task.assignee.id)).size
  };
}

function detail(id) {
  const task = getOrThrow(id);
  return { task, actionRequest: task.actionRequest };
}

// ==================== 用户操作 ====================

function cancel(id, reason) {
  const task = getOrThrow(id);
  if (FINISHED_STATUS.includes(task.status)) throw fail.invalidState('该任务已结束，无法取消');

  const from = task.status;
  const next = mutate(id, (t) => {
    t.status = STATUS.canceled;
    t.finishedAt = nowIso();
    t.error = null;
    appendEvent(t, 'status_changed', reason ? `任务已取消：${reason}` : '任务已取消', { from, to: STATUS.canceled });
  });
  publish(next, 'task:updated');
  bus.command('task:canceled', id);
  return publicTask(next);
}

function ack(id) {
  const task = getOrThrow(id);
  if (task.status !== STATUS.succeeded) throw fail.invalidState('仅已完成的任务可以查收');
  if (task.resultAckedAt) return publicTask(task);

  const next = mutate(id, (t) => {
    t.resultAckedAt = nowIso();
    appendEvent(t, 'acked', '结果已查收');
  });
  publish(next, 'task:updated');
  return publicTask(next);
}

/** 校验并归一化用户提交的操作内容 */
function normalizeAnswer(request, answer = {}) {
  if (request.type === 'selection' || request.type === 'confirm') {
    const values = (request.options || []).map((option) => option.value);
    const value = String(answer.value ?? request.defaultValue ?? values[0] ?? '');
    if (values.length && !values.includes(value)) throw fail.validation('请选择有效的选项');
    return { value, form: null };
  }

  const form = {};
  (request.form || []).forEach((field) => {
    const value = String(answer.form?.[field.name] ?? '').trim();
    if (field.required && !value) throw fail.validation(`请填写「${field.label}」`);
    form[field.name] = value.slice(0, 500);
  });

  const value = String(answer.value ?? '').trim();
  if (request.type === 'question' && !value) throw fail.validation('请填写回答内容');
  return { value: value.slice(0, 500), form };
}

function describeAnswer(request, normalized) {
  if (request.type === 'selection' || request.type === 'confirm') {
    const option = (request.options || []).find((item) => item.value === normalized.value);
    return option ? option.label : String(normalized.value);
  }
  const parts = Object.values(normalized.form || {}).filter(Boolean);
  return parts.length ? parts.join(' / ') : String(normalized.value || '已提交');
}

function answer(params = {}) {
  const task = getOrThrow(params.taskId);
  if (task.status !== STATUS.needAction) throw fail.invalidState('该任务当前不需要操作');

  const request = task.actionRequest;
  if (!request) throw fail.notFound('操作请求不存在');
  if (params.actionId && request.id !== params.actionId) {
    throw fail.notFound('操作请求已更新，请刷新后重试');
  }

  const normalized = normalizeAnswer(request, params.answer);
  const next = mutate(task.id, (t) => {
    t.actionRequest.answer = { ...normalized, at: nowIso() };
    t.actionRequest.answeredAt = nowIso();
    t.status = STATUS.running;
    appendEvent(t, 'action_answered', `已提交操作：${describeAnswer(request, normalized)}`);
  });

  publish(next, 'task:updated');
  bus.command('task:resumed', task.id);
  return publicTask(next);
}

// ==================== 运行时回调（执行过程状态变更） ====================

function markRunning(id, steps, message) {
  const next = mutate(id, (t) => {
    const from = t.status;
    t.status = STATUS.running;
    t.steps = steps;
    t.startedAt = nowIso();
    t.progress = 0;
    appendEvent(t, 'status_changed', message || '开始执行', { from, to: STATUS.running });
  });
  publish(next, 'task:updated');
  return publicTask(next);
}

function startStep(id, stepNo) {
  const next = mutate(id, (t) => {
    const step = t.steps.find((item) => item.step === stepNo);
    if (step && step.status === 'pending') {
      step.status = 'running';
      step.startedAt = nowIso();
    }
  });
  publish(next, 'task:updated');
}

function completeStep(id, stepNo, log, citations) {
  const next = mutate(id, (t) => {
    const step = t.steps.find((item) => item.step === stepNo);
    if (step) {
      step.status = 'done';
      step.finishedAt = nowIso();
      step.log = log || '';
      step.citations = Array.isArray(citations) ? citations : [];
    }
    const done = t.steps.filter((item) => item.status === 'done').length;
    t.progress = t.steps.length ? Math.round((done / t.steps.length) * 100) : 0;
    appendEvent(t, 'step_updated', `已完成步骤：${step ? step.title : stepNo}`);
  });
  publish(next, 'task:updated');
}

/** 进入「需要操作」暂停态，等待用户提交后由运行时继续 */
function requestAction(id, actionRequest) {
  const next = mutate(id, (t) => {
    t.status = STATUS.needAction;
    t.actionRequest = {
      ...actionRequest,
      id: actionRequest.id || createId('ar'),
      taskId: id,
      answer: null,
      createdAt: nowIso(),
      answeredAt: null
    };
    appendEvent(t, 'action_requested', t.actionRequest.title);
  });
  publish(next, 'task:updated');
  bus.emit('app:notice', {
    level: 'info',
    title: `「${next.title}」需要你的操作`,
    body: next.actionRequest.title
  });
  return publicTask(next);
}

function succeed(id, result) {
  const next = mutate(id, (t) => {
    t.status = STATUS.succeeded;
    t.progress = 100;
    t.result = { ...result, deliveredAt: nowIso() };
    t.finishedAt = nowIso();
    appendEvent(t, 'result_ready', '任务已完成，结果待查收');
  });
  publish(next, 'task:updated');
  bus.emit('app:notice', {
    level: 'success',
    title: `「${next.title}」已完成`,
    body: '结果已生成，可在「查收结果」中查看。'
  });
  notifyFinished(next);
  return publicTask(next);
}

function failTask(id, error) {
  const next = mutate(id, (t) => {
    const from = t.status;
    t.status = STATUS.failed;
    t.error = { code: error?.code || 'INTERNAL', message: error?.message || '执行失败', at: nowIso() };
    t.finishedAt = nowIso();
    appendEvent(t, 'failed', `执行失败：${t.error.message}`, { from, to: STATUS.failed });
  });
  publish(next, 'task:updated');
  notifyFinished(next);
  return publicTask(next);
}

/** 通知调度器：任务进入终态（供事件触发的自动任务使用） */
function notifyFinished(task) {
  bus.command('task:finished', {
    taskId: task.id,
    title: task.title,
    status: task.status,
    assigneeId: task.assignee.id,
    triggerRefId: task.trigger.refId,
    depth: task.trigger.depth || 0
  });
}

/** 仅记录时间线（如执行者离线等待），不改变任务状态 */
function recordEvent(id, message) {
  const next = mutate(id, (t) => appendEvent(t, 'log', message));
  publish(next, 'task:updated');
}

/** 已结束、已查收且超出保留期的任务（未查收的结果不会被清理，避免用户还没看就消失） */
function expiredTasks(days = 90, now = Date.now()) {
  const retention = Number(days) > 0 ? Number(days) : 90;
  const threshold = now - retention * 24 * 60 * 60 * 1000;
  const items = db.all('tasks').filter((task) => {
    if (!FINISHED_STATUS.includes(task.status)) return false;
    if (!task.resultAckedAt) return false;
    const settledAt = new Date(task.resultAckedAt).getTime();
    return !Number.isNaN(settledAt) && settledAt < threshold;
  });
  return { retention, items };
}

/** 清理过期任务（连带其时间线），应用启动与设置中心手动触发都会调用 */
function purgeExpired(days = 90, now = Date.now()) {
  const { retention, items } = expiredTasks(days, now);
  items.forEach((task) => db.remove('tasks', task.id));
  items.forEach((task) => bus.emit('task:removed', { id: task.id }));
  return { removed: items.length, retention };
}

/** 预览可清理数量（设置中心展示用） */
function purgePreview(days = 90, now = Date.now()) {
  const { retention, items } = expiredTasks(days, now);
  return { removable: items.length, retention };
}

module.exports = {
  STATUS,
  ACTIVE_STATUS,
  FINISHED_STATUS,
  TRIGGER_LABEL,
  create,
  list,
  stats,
  detail,
  cancel,
  ack,
  answer,
  getTask,
  resolveAssignee,
  markRunning,
  startStep,
  completeStep,
  requestAction,
  succeed,
  failTask,
  recordEvent,
  purgeExpired,
  purgePreview
};