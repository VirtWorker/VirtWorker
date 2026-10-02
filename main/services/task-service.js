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
const { toPositiveInt } = require('../util/validate');
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

/** 状态筛选枚举（O12）：IPC 契约只认存储枚举，中文展示文案由渲染层负责 */
const STATUS_FILTER = {
  active: ACTIVE_STATUS,
  action: [STATUS.needAction],
  finished: FINISHED_STATUS
};

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const MAX_EVENTS = 200;
/** 任务级总超时上限（分钟）：从开始执行起算的墙钟上限（E3），缺省/0 = 不限时 */
const TASK_TIMEOUT_MAX_MINUTES = 7 * 24 * 60;
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
 * 并发约束：本函数依赖「主进程同步单线程执行」这一前提（读取与写回之间不可让出事件循环）；
 * 未来若在 updater 中引入 await，必须先为任务增加 revision 乐观锁，否则会产生读-改-写竞态。
 */
function mutate(id, updater, { allowFinished = false } = {}) {
  const task = getOrThrow(id);
  if (!allowFinished && FINISHED_STATUS.includes(task.status)) {
    throw fail.invalidState(`任务已结束（${task.status}），不能再变更状态`);
  }
  updater(task);
  task.updatedAt = nowIso();
  // writeBack（PERF-7）：mutate 自持完整草稿、不依赖返回值，省去 update 返回值的一次全任务深克隆
  db.writeBack('tasks', id, task);
  return task;
}

/** 读取任务：先查活跃集合，未命中再查归档集合（BUG-20）。
 *  归档任务均为「已完成且已查收」，所有变更类操作都会被 mutate 的终态守卫拒绝
 *  （ack 幂等早返回），因此合并读取不会造成跨集合误写。 */
function getTask(id) {
  return db.find('tasks', id) || db.find('tasks-archive', id);
}

function getOrThrow(id) {
  const task = getTask(id);
  if (!task) throw fail.notFound('任务不存在');
  return task;
}

function normalizeTrigger(trigger) {
  // O12：缺省视为手动创建（内部默认值语义）；显式传入无效类型一律校验失败，不再静默归一
  let type = 'manual';
  if (trigger?.type !== undefined) {
    if (!TRIGGER_LABEL[trigger.type]) throw fail.validation('无效的任务触发类型');
    type = trigger.type;
  }
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
    return { type: 'group', id: group.id, name: group.name, env: 'local' };
  }

  if (id.startsWith('fl_')) {
    const flow = db.find('flows', id);
    if (!flow) throw fail.notFound('所选 WorkerFlow 不存在');
    return { type: 'flow', id: flow.id, name: flow.name, env: 'local' };
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

  // 任务级总超时（E3）：可选，1..TASK_TIMEOUT_MAX_MINUTES 分钟；运行时在每步推进前检查
  let timeoutMinutes = null;
  if (params.timeoutMinutes !== undefined && params.timeoutMinutes !== null && params.timeoutMinutes !== '') {
    const minutes = Number(params.timeoutMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > TASK_TIMEOUT_MAX_MINUTES) {
      throw fail.validation(`任务超时必须是 1-${TASK_TIMEOUT_MAX_MINUTES} 分钟的整数`);
    }
    timeoutMinutes = minutes;
  }

  const task = {
    id: createId('tk'),
    title: title.slice(0, 60),
    goal,
    status: STATUS.queued,
    priority: PRIORITIES.includes(params.priority) ? params.priority : 'normal',
    timeoutMinutes,
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
  // 「触发方式」筛选（O12）：只认存储枚举（manual/schedule/event/api/chat）
  const triggerKey = TRIGGER_LABEL[filter.triggerType] ? filter.triggerType : null;
  const assigneeId = filter.assigneeId || null;
  const keyword = String(filter.keyword ?? '').trim().toLowerCase();
  const tag = String(filter.tag ?? '').trim();

  // 谓词下推（O8）：db.query 只克隆命中项，替代原先「整集合 structuredClone 后再过滤」
  // 归档合并（BUG-20）：活跃 + 归档两集合同谓词查询后合并排序。归档任务均早于归档阈值
  // （30 天）进入，week/month 周期谓词会零克隆地拒绝全部归档条目，合并只在
  // quarter / 全部历史窗口产生额外命中，保证「全部任务」口径完整。
  const predicate = (task) =>
    isWithinPeriod(task.createdAt, period) &&
    (!filter.refId || task.trigger.refId === filter.refId) &&
    (!statuses || statuses.includes(task.status)) &&
    (!triggerKey || task.trigger.type === triggerKey) &&
    (!assigneeId || task.assignee.id === assigneeId) &&
    (!tag || (task.tags || []).includes(tag)) &&
    (!keyword ||
      `${task.title} ${task.goal} ${task.assignee.name} ${(task.tags || []).join(' ')}`
        .toLowerCase()
        .includes(keyword));

  const items = [...db.query('tasks', predicate), ...db.query('tasks-archive', predicate)];

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // 分页（蓝图 task:list 契约中的 page/pageSize）：兼容数字字符串，pageSize 上限 200
  const page = toPositiveInt(filter.page);
  const pageSizeRaw = toPositiveInt(filter.pageSize);
  const pageSize = pageSizeRaw ? Math.min(LIST_PAGE_SIZE_MAX, pageSizeRaw) : null;
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
 *  计数走 countWhere（零克隆），只有活跃任务需要克隆（算工作中的 Worker 去重数）。
 *  归档合并（BUG-20）：total 需含归档集合（week/month 窗口下归档条目零命中，仅 quarter 生效）；
 *  归档条目均为 succeeded+acked，不可能是 needAction，无需合并该计数。 */
function stats(period = 'month') {
  const inPeriod = (task) => isWithinPeriod(task.createdAt, period);
  const active = db.query('tasks', (task) => inPeriod(task) && ACTIVE_STATUS.includes(task.status));
  const total = db.countWhere('tasks', inPeriod) + db.countWhere('tasks-archive', inPeriod);
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
    timeoutMinutes: source.timeoutMinutes, // 重试任务沿用原任务的总超时口径
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

/** 归档阈值（BUG-20）：已查收且查收时间早于该天数 → 移入 tasks-archive。
 *  只归档 succeeded+acked：failed/canceled 是重试候选、未查收结果用户还没看，
 *  两者都留在活跃集合。归档后活跃集合规模被压在「30 天已查收 + 进行中 + 未查收」窗口内，
 *  create/completeStep 等高频写的 O(N) 拷贝与全量重写成本随之有界。 */
const ARCHIVE_AFTER_DAYS = 30;

/** 过期判定：已结束、已查收且超出保留期（未查收的结果不会被清理，避免用户还没看就消失） */
function expiredPredicate(threshold) {
  return (task) => {
    if (!FINISHED_STATUS.includes(task.status)) return false;
    if (!task.resultAckedAt) return false;
    const settledAt = new Date(task.resultAckedAt).getTime();
    return !Number.isNaN(settledAt) && settledAt < threshold;
  };
}

/** 归档判定：已完成、已查收且超出归档阈值（严格弱于过期判定，归档是删除前的中间层） */
function agedPredicate(threshold) {
  return (task) => {
    if (task.status !== STATUS.succeeded || !task.resultAckedAt) return false;
    const settledAt = new Date(task.resultAckedAt).getTime();
    return !Number.isNaN(settledAt) && settledAt < threshold;
  };
}

/** 清理过期任务（连带其时间线），应用启动、每日维护与设置中心手动触发都会调用。
 *  两个集合各一次批量删除（逐条 remove 是 O(N²)），写入经 db 合并窗口只落盘一轮。
 *  归档集合同样按保留期清理（BUG-20）：归档只进不出的话磁盘占用无界增长；
 *  活跃与归档取并集一次性删除，事件清理与 task:removed 广播保持原语义。 */
function purgeExpired(days = 90, now = Date.now()) {
  const retention = Number(days) > 0 ? Number(days) : 90;
  const threshold = now - retention * 24 * 60 * 60 * 1000;
  const predicate = expiredPredicate(threshold);
  const expired = [...db.query('tasks', predicate), ...db.query('tasks-archive', predicate)];
  if (expired.length) {
    const removedIds = expired.map((task) => task.id);
    db.removeWhere('tasks', { id: removedIds });
    db.removeWhere('tasks-archive', { id: removedIds });
    db.removeWhere('taskevents', { taskId: removedIds });
    expired.forEach((task) => bus.emit('task:removed', { id: task.id }));
  }
  return { removed: expired.length, retention };
}

/** 归档迁移（BUG-20）：把「已查收且超出归档阈值」的任务从 tasks 批量移入 tasks-archive。
 *  由每日维护调用（启动首跑 + 每 24h），低频批量，写入经 insertMany/removeWhere 各只落盘一轮。
 *  先入后出（BUG-26）：原「先出后进」在两次落盘之间崩溃时（tasks.json 已写出删除、
 *  tasks-archive.json 尚未写出插入，dirty 缓存随进程消亡），这批已查收任务会从磁盘永久消失。
 *  改为先插入归档再删除活跃：崩溃最多留下「活跃与归档短暂双份」，由第一步的幂等去重
 *  （先清归档同名 id 再插入）在下次归档重跑时收敛，不再产生不可逆丢失。 */
function archiveAged(days = ARCHIVE_AFTER_DAYS, now = Date.now()) {
  const threshold = now - days * 24 * 60 * 60 * 1000;
  const aged = db.query('tasks', agedPredicate(threshold));
  if (!aged.length) return { archived: 0, threshold: days };
  const ids = aged.map((task) => task.id);
  db.removeWhere('tasks-archive', { id: ids }); // 幂等去重：上次中断遗留的双份先清掉，保证归档集合无重复
  db.insertMany('tasks-archive', aged);
  db.removeWhere('tasks', { id: ids });
  return { archived: aged.length, threshold: days };
}

/** 预览可清理数量（设置中心展示用）：countWhere 零克隆；活跃 + 归档合并口径 */
function purgePreview(days = 90, now = Date.now()) {
  const retention = Number(days) > 0 ? Number(days) : 90;
  const threshold = now - retention * 24 * 60 * 60 * 1000;
  const predicate = expiredPredicate(threshold);
  return {
    removable: db.countWhere('tasks', predicate) + db.countWhere('tasks-archive', predicate),
    retention
  };
}

/** 导出任务历史（含完整时间线）：与 list 共用筛选口径，供归档与外部报表。
 *  强制忽略分页参数（导出即全量口径），period 传空字符串表示导出全部历史。
 *  时间线一次性建 taskId 索引（BUG-18）：此前逐任务 db.where 全量遍历 taskevents 为 O(N×M)，
 *  数万任务×数十万事件可卡死主进程数分钟，索引化后降为 O(N+M)。 */
function exportTasks(filter = {}) {
  const { page, pageSize, ...rest } = filter;
  const { items, total } = list({ ...rest, limit: 0 });
  // tasks 集合不含时间线（v2 起拆分），导出时按 detail 口径并入
  const eventsById = new Map();
  for (const event of db.all('taskevents')) {
    if (!eventsById.has(event.taskId)) eventsById.set(event.taskId, []);
    eventsById.get(event.taskId).push(event);
  }
  const records = items.map((task) => ({ ...task, events: eventsById.get(task.id) || [] }));
  return { exportedAt: nowIso(), count: records.length, total, records };
}

/** 批量查收（F8）：周期内全部「已完成且未查收」的任务（看板「查收结果」页签的一键操作）。
 *  单次批量更新（PERF-3）：此前逐条 ack() 为 O(N²)——每条一次全集合 map + persist 标记，
 *  外加 keepLast 对整个 taskevents 的全量扫描；事件在 succeed 收口时已修剪过（≤200 条/任务），
 *  批量路径无需重剪，仅追加查收事件并按任务发布 task:updated（渲染层契约不变）。 */
function ackAll(period = 'month') {
  const updated = db.updateWhere(
    'tasks',
    (task) => isWithinPeriod(task.createdAt, period) && task.status === STATUS.succeeded && !task.resultAckedAt,
    (task) => {
      task.resultAckedAt = nowIso();
      task.updatedAt = nowIso();
      appendEvent(task, 'acked', '结果已查收');
    }
  );
  updated.forEach((task) => publish(task, 'task:updated'));
  return { acked: updated.length };
}

/** 孤儿时间线清扫（O13）：任务与其事件分属两个集合文件，删除任务的崩溃窗口可能遗留
 *  taskId 已不存在的 taskevents，且无任何后续清理路径。由每日维护（含启动即跑的一次）调用。
 *  已知 taskId 需含归档集合（BUG-20）：归档任务的时间线仍然有效，不得当作孤儿清扫 */
function purgeOrphanEvents() {
  // pluck 免克隆提取 id（PERF-6）：原 db.query(()=>true) 会把两个任务集合全部深拷贝一遍
  const knownIds = new Set([...db.pluck('tasks', (task) => task.id), ...db.pluck('tasks-archive', (task) => task.id)]);
  return db.removeWhere('taskevents', (event) => !knownIds.has(event.taskId)).removed;
}

module.exports = {
  STATUS,
  ACTIVE_STATUS,
  FINISHED_STATUS,
  TRIGGER_LABEL,
  TASK_TIMEOUT_MAX_MINUTES,
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
  archiveAged,
  ARCHIVE_AFTER_DAYS,
  purgeOrphanEvents,
  purgeExpired,
  purgePreview
};