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
/** 列表分页 pageSize 上限：防止一次下发全量列表（渲染层按 50/页增量加载，累计窗口上限即此值） */
const LIST_PAGE_SIZE_MAX = 200;

// ==================== 内部工具 ====================

/** 对外输出剥离 events（时间线体积大，仅详情接口返回） */
function publicTask(task) {
  const { events, ...rest } = task;
  return rest;
}

function appendEvent(task, type, message, extra = {}) {
  // v2：时间线存独立 taskevents 集合（任务对象不再内嵌，读路径不再克隆大数组）
  db.append('taskevents', { id: createId('ev'), taskId: task.id, type, message, ...extra, at: nowIso() });
}

/** 任务时间线上限：终态收口时修剪（执行中单任务事件量远小于该值，无需逐步检查） */
function pruneTaskEvents(id) {
  db.keepLast('taskevents', { taskId: id }, MAX_EVENTS);
}

/** 读取任务时间线（detail 组装用；追加序即时间序） */
function listEvents(id) {
  return db.where('taskevents', { taskId: id });
}

function publish(task, eventType) {
  bus.emit(eventType, publicTask(task));
}

/**
 * 读-改-写：所有状态变更都经此，保证 updatedAt 与持久化一致。
 * 终态守卫：已结束（succeeded/failed/canceled）的任务拒绝一切后续变更（仅查收 ack 豁免），
 * 防止取消/失败后被挂起的运行时回调把任务改写成另一终态（如 canceled → failed）
 * 或向终态任务追加步骤数据，污染看板口径与审计时间线。
 */
function mutate(id, updater, { allowFinished = false } = {}) {
  const task = getOrThrow(id);
  if (!allowFinished && FINISHED_STATUS.includes(task.status)) {
    throw fail.invalidState(`任务已结束（${task.status}），不能再变更状态`);
  }
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
    /** 事件触发链深度：钳制到与 runtime/scheduler 的 MAX_CHAIN_DEPTH(3) 一致
     *  （调度器是链式触发的唯一执行点，超过 3 的深度本来就会被其拒绝，这里统一口径避免误导） */
    depth: Number.isInteger(trigger?.depth) ? Math.min(3, Math.max(0, trigger.depth)) : 0,
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
    if (!leadId) throw fail.validation('该 Group 没有成员，请先为其添加成员再派发任务');
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

/**
 * 收敛外部传入的 payload：限制嵌套深度、字符串长度与总规模，
 * 丢弃函数/符号等不可序列化值，防止任意结构数据入库或被渲染层回显。
 */
const PAYLOAD_MAX_DEPTH = 4;
const PAYLOAD_MAX_STRING = 2000;
const PAYLOAD_MAX_ARRAY = 50;
const PAYLOAD_MAX_KEYS = 50;

function sanitizeValue(value, depth) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, PAYLOAD_MAX_STRING);
  if (depth >= PAYLOAD_MAX_DEPTH) return undefined; // 超深直接丢弃
  if (Array.isArray(value)) return value.slice(0, PAYLOAD_MAX_ARRAY).map((item) => sanitizeValue(item, depth + 1)).filter((item) => item !== undefined);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, PAYLOAD_MAX_KEYS)) {
      const cleaned = sanitizeValue(value[key], depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return undefined; // function / symbol / bigint 等丢弃
}

function sanitizePayload(payload) {
  const cleaned = sanitizeValue(payload, 0);
  return cleaned && typeof cleaned === 'object' ? cleaned : {};
}

function create(params = {}) {
  // retryOf / retryFromStep 是 retry() 使用的内部关联字段（trusted internal params）：
  // 必须在任务入队（触发派发）之前落到任务对象上，断点重跑才能在派发时读到断点
  const retryOf = typeof params.retryOf === 'string' ? params.retryOf : null;
  const retryFromStep = Number.isInteger(params.retryFromStep) && params.retryFromStep > 1 ? params.retryFromStep : null;
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
    workspace: { cwd: String(params.workspace ?? '').trim().slice(0, 300), env: assignee.env },
    input: {
      payload: sanitizePayload(params.payload),
      attachments: [],
      ...(retryFromStep ? { retryFromStep } : {})
    },
    ...(retryOf ? { retryOf } : {}),
    steps: [],
    progress: 0,
    actionRequest: null,
    result: null,
    resultAckedAt: null,
    error: null,
    tags: Array.isArray(params.tags)
      ? [...new Set(params.tags.slice(0, 5).map((tag) => String(tag).trim().slice(0, 20)).filter(Boolean))]
      : [],
    createdAt: nowIso(),
    startedAt: null,
    updatedAt: nowIso(),
    finishedAt: null
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
  const statuses = STATUS_FILTER[filter.status];
  // 「触发方式」筛选：界面传中文标签，转为存储枚举
  const triggerKey =
    Object.keys(TRIGGER_LABEL).find((key) => TRIGGER_LABEL[key] === filter.triggerType) ||
    (TRIGGER_LABEL[filter.triggerType] ? filter.triggerType : null);
  const assigneeId = filter.assigneeId && filter.assigneeId !== '全部' ? filter.assigneeId : null;
  const keyword = String(filter.keyword ?? '').trim().toLowerCase();
  const tag = String(filter.tag ?? '').trim();

  // 谓词下推（O8）：db.query 只克隆命中项，替代原先「整集合 structuredClone 后再过滤」
  let items = db.query('tasks', (task) =>
    isWithinPeriod(task.createdAt, period) &&
    (!filter.refId || task.trigger.refId === filter.refId) &&
    (!statuses || statuses.includes(task.status)) &&
    (!triggerKey || task.trigger.type === triggerKey) &&
    (!assigneeId || task.assignee.id === assigneeId) &&
    (!tag || (task.tags || []).includes(tag)) &&
    (!keyword ||
      `${task.title} ${task.goal} ${task.assignee.name} ${(task.tags || []).join(' ')}`
        .toLowerCase()
        .includes(keyword))
  );

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // 分页（蓝图 task:list 契约中的 page/pageSize）：pageSize 上限 200，防止一次下发全量列表
  const page = Number.isInteger(filter.page) && filter.page > 0 ? filter.page : null;
  const pageSize = Number.isInteger(filter.pageSize) && filter.pageSize > 0 ? Math.min(LIST_PAGE_SIZE_MAX, filter.pageSize) : null;
  let limited;
  let pagination = {};
  if (page && pageSize) {
    const start = (page - 1) * pageSize;
    limited = items.slice(start, start + pageSize);
    pagination = { page, pageSize, totalPages: Math.ceil(items.length / pageSize) };
  } else {
    limited = filter.limit ? items.slice(0, filter.limit) : items;
  }
  return { items: limited.map(publicTask), total: items.length, ...pagination };
}

/** 看板队列表：需要操作 / 待查收结果（与 list/stats 共用同一时间过滤，主进程一次算完，
 *  避免渲染层拉全量周期任务后自行过滤） */
function queue(period = 'month') {
  const inPeriod = (task) => isWithinPeriod(task.createdAt, period);
  return {
    action: db
      .query('tasks', (task) => inPeriod(task) && task.status === STATUS.needAction)
      .map(publicTask),
    result: db
      .query('tasks', (task) => inPeriod(task) && task.status === STATUS.succeeded && !task.resultAckedAt)
      .map(publicTask)
  };
}

/** 看板统计口径（与 list 共用同一时间过滤，保证数字与列表一致）。
 *  计数走 countWhere（零克隆），只有活跃任务需要克隆（算工作中的 Worker 去重数） */
function stats(period = 'month') {
  const inPeriod = (task) => isWithinPeriod(task.createdAt, period);
  const active = db.query('tasks', (task) => inPeriod(task) && ACTIVE_STATUS.includes(task.status));
  const total = db.countWhere('tasks', inPeriod);
  const needAction = db.countWhere('tasks', (task) => inPeriod(task) && task.status === STATUS.needAction);
  return {
    total,
    running: active.length,
    needAction,
    finished: total - active.length - needAction, // 状态枚举完备且互斥
    workingWorkers: new Set(active.map((task) => task.assignee.id)).size
  };
}

function detail(id) {
  const task = getOrThrow(id);
  // 时间线按需组装（tasks 集合已不含 events）
  return { task: { ...task, events: listEvents(id) }, actionRequest: task.actionRequest };
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
  pruneTaskEvents(id);
  publish(next, 'task:updated');
  bus.command('task:canceled', id);
  return publicTask(next);
}

function ack(id) {
  const task = getOrThrow(id);
  if (task.status !== STATUS.succeeded) throw fail.invalidState('仅已完成的任务可以查收');
  if (task.resultAckedAt) return publicTask(task);

  const next = mutate(
    id,
    (t) => {
      t.resultAckedAt = nowIso();
      appendEvent(t, 'acked', '结果已查收');
    },
    { allowFinished: true } // ack 是唯一允许作用于终态任务的变更
  );
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
  // 内部指令：出站回执（IM 推送等）与 SLA 看门狗的触发源（F3）
  bus.command('task:action-requested', { taskId: id, title: next.title });
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
  pruneTaskEvents(id);
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
  pruneTaskEvents(id);
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

/** 级联取消：执行者（Worker/Group）被删除或成员被清空时，取消其名下在途任务。
 *  不取消的话任务要等槽位释放或离线退避重试才失败，成为"延迟僵尸"，
 *  甚至会以已删除执行者的名义继续执行。逐条容错：终态竞争等异常只记录不中断级联。 */
function cancelActiveByAssignees(assigneeIds, reason) {
  const ids = (Array.isArray(assigneeIds) ? assigneeIds : []).filter(Boolean);
  if (!ids.length) return [];
  const canceled = [];
  // 结构化匹配器（O11）：assignee.id IN (ids) AND status IN (queued/running)
  db.where('tasks', { 'assignee.id': ids, status: ACTIVE_STATUS }).forEach((task) => {
    try {
      cancel(task.id, reason);
      canceled.push(task.id);
    } catch (error) {
      console.error(`[task] 级联取消任务 ${task.id} 失败:`, error.message || error);
    }
  });
  return canceled;
}

/** 仅记录时间线（如执行者离线等待），不改变任务状态；allowFinished 允许写给终态任务（如重试/出站通知的审计） */
function recordEvent(id, message, { allowFinished = false } = {}) {
  const next = mutate(id, (t) => appendEvent(t, 'log', message), { allowFinished });
  publish(next, 'task:updated');
}

/** need_action 任务清单（SLA 看门狗扫描用，O10） */
function listNeedAction() {
  return db.where('tasks', { status: STATUS.needAction });
}

/** 更新操作请求的最近提醒时间（超时策略 remind 每 24h 重发提醒，O10） */
function touchActionReminder(id) {
  return mutate(id, (t) => {
    if (t.actionRequest) t.actionRequest.remindedAt = nowIso();
  });
}

/**
 * 重试失败/已取消的任务（F1）：以新任务重新入队（终态任务本身不可变，保证时间线审计完整），
 * 新任务通过 retryOf 关联原任务；fromStep='failed' 时从原任务第一个未完成步骤继续（断点重跑，
 * 由运行时在构建步骤后沿用原任务已完成步骤的结果）。
 */
function retry(id, { fromStep = null } = {}) {
  const source = getOrThrow(id);
  if (!FINISHED_STATUS.includes(source.status)) {
    throw fail.invalidState('仅失败或已取消的任务可以重试');
  }

  let retryFromStep = null;
  if (fromStep === 'failed') {
    const firstPending = (source.steps || []).find((step) => step.status !== 'done');
    retryFromStep = firstPending && firstPending.step > 1 ? firstPending.step : null;
  } else if (Number.isInteger(fromStep) && fromStep > 1) {
    retryFromStep = fromStep;
  }

  const task = create({
    title: source.title,
    goal: source.goal,
    assigneeId: source.assignee.id,
    priority: source.priority,
    workspace: source.workspace?.cwd,
    payload: source.input?.payload,
    tags: source.tags,
    confirmFirst: source.confirmFirst,
    trigger: { type: 'manual' },
    retryOf: source.id,
    retryFromStep
  });

  const next = task;

  recordEvent(task.id, retryFromStep ? `重试自任务 ${source.id}（从第 ${retryFromStep} 步继续）` : `重试自任务 ${source.id}`);
  mutate(source.id, (t) => appendEvent(t, 'retried', `已发起重试，新任务：${task.id}`), { allowFinished: true });
  return publicTask(next);
}

/** 过期判定：已结束、已查收且超出保留期（未查收的结果不会被清理，避免用户还没看就消失） */
function expiredPredicate(threshold) {
  return (task) => {
    if (!FINISHED_STATUS.includes(task.status)) return false;
    if (!task.resultAckedAt) return false;
    const settledAt = new Date(task.resultAckedAt).getTime();
    return !Number.isNaN(settledAt) && settledAt < threshold;
  };
}

function expiredTasks(days = 90, now = Date.now()) {
  const retention = Number(days) > 0 ? Number(days) : 90;
  const threshold = now - retention * 24 * 60 * 60 * 1000;
  return { retention, items: db.query('tasks', expiredPredicate(threshold)) };
}

/** 清理过期任务（连带其时间线），应用启动、每日维护与设置中心手动触发都会调用。
 *  两个集合各一次批量删除（逐条 remove 是 O(N²)），写入经 db 合并窗口只落盘一轮。 */
function purgeExpired(days = 90, now = Date.now()) {
  const { retention, items } = expiredTasks(days, now);
  if (items.length) {
    const removedIds = items.map((task) => task.id);
    db.removeWhere('tasks', { id: removedIds });
    db.removeWhere('taskevents', { taskId: removedIds });
    items.forEach((task) => bus.emit('task:removed', { id: task.id }));
  }
  return { removed: items.length, retention };
}

/** 导出任务历史（含完整时间线）：与 list 共用筛选口径，供归档与外部报表。
 *  强制忽略分页参数（导出即全量口径），period 传空字符串表示导出全部历史。 */
function exportTasks(filter = {}) {
  const { page, pageSize, ...rest } = filter;
  const { items, total } = list({ ...rest, limit: 0 });
  // tasks 集合不含时间线（v2 起拆分），导出时按 detail 口径并入
  const records = items.map((task) => ({ ...task, events: listEvents(task.id) }));
  return { exportedAt: nowIso(), count: records.length, total, records };
}

/** 预览可清理数量（设置中心展示用）：countWhere 零克隆 */
function purgePreview(days = 90, now = Date.now()) {
  const retention = Number(days) > 0 ? Number(days) : 90;
  const threshold = now - retention * 24 * 60 * 60 * 1000;
  return { removable: db.countWhere('tasks', expiredPredicate(threshold)), retention };
}

/** 批量查收：周期内全部「已完成且未查收」的任务（看板「查收结果」页签的一键操作，F8） */
function ackAll(period = 'month') {
  const items = db.query('tasks', (task) => {
    if (!isWithinPeriod(task.createdAt, period)) return false;
    return task.status === STATUS.succeeded && !task.resultAckedAt;
  });
  let acked = 0;
  items.forEach((task) => {
    try {
      ack(task.id);
      acked += 1;
    } catch (error) {
      console.error(`[task] 批量查收任务 ${task.id} 失败:`, error.message || error);
    }
  });
  return { acked };
}

module.exports = {
  STATUS,
  ACTIVE_STATUS,
  FINISHED_STATUS,
  TRIGGER_LABEL,
  create,
  list,
  queue,
  stats,
  detail,
  cancel,
  ack,
  ackAll,
  answer,
  retry,
  getTask,
  resolveAssignee,
  cancelActiveByAssignees,
  listNeedAction,
  touchActionReminder,
  markRunning,
  startStep,
  completeStep,
  requestAction,
  succeed,
  failTask,
  recordEvent,
  exportTasks,
  purgeExpired,
  purgePreview
};