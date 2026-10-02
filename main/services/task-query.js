/**
 * 任务查询与数据治理（F2 从 task-service.js 拆出）：
 * 看板列表/队列/统计口径、历史导出、批量查收、归档迁移、过期清理与孤儿清扫。
 * 与生命周期（create/cancel/answer/...）天然分层：本模块依赖生命周期域的常量与内部工具
 * （经 require('./task-service') 取用），反向无依赖。
 * 加载方向约定：入口只允许 require task-service（其模块尾部 Object.assign 本模块导出）；
 * 直接 require 本文件会因 CJS 半初始化拿到空对象。
 */

const db = require('../store/db');
const bus = require('../runtime/event-bus');
const { nowIso, isWithinPeriod } = require('../util/time');
const { toPositiveInt } = require('../util/validate');
const taskService = require('./task-service');

const { STATUS, ACTIVE_STATUS, FINISHED_STATUS, TRIGGER_LABEL, publicTask, appendEvent, publish } = taskService;

/** 列表状态筛选枚举（O12）：IPC 契约只认存储枚举 */
const STATUS_FILTER = {
  active: ACTIVE_STATUS,
  action: [STATUS.needAction],
  finished: FINISHED_STATUS
};

/** 列表分页 pageSize 上限：防止一次下发全量列表（渲染层按 50/页增量加载，累计窗口上限即此值） */
const LIST_PAGE_SIZE_MAX = 200;

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

/** 导出任务历史（含完整时间线）：与 list 共用筛选口径，供归档与外部报表。
 *  强制忽略分页参数（导出即全量口径），period 传空字符串表示导出全部历史。
 *  时间线一次建索引（BUG-18）：此前逐任务 db.where 全量遍历 taskevents 为 O(N×M)；
 *  现改为 query 谓词过滤（B1）：一次线性扫描，且只克隆导出任务的时间线事件，
 *  不再把全部任务的 event 深拷贝一遍。 */
function exportTasks(filter = {}) {
  const { page, pageSize, ...rest } = filter;
  const { items, total } = list({ ...rest, limit: 0 });
  // tasks 集合不含时间线（v2 起拆分），导出时按 detail 口径并入
  const taskIdSet = new Set(items.map((task) => task.id));
  const eventsById = new Map();
  for (const event of db.query('taskevents', (item) => taskIdSet.has(item.taskId))) {
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

/** 归档阈值（BUG-20）：已查收且查收时间早于该天数 → 移入 tasks-archive。
 *  succeeded 仍要求已查收（未查收的结果用户还没看，不退出活跃集合）；
 *  failed/canceled 无查收语义（BUG-27）：按 finishedAt 计龄走同一归档/保留通道——
 *  此前两者没有任何退出通道，失败风暴与级联取消产生的终态任务永久滞留活跃集合，
 *  归档治理「活跃集合规模有界」的前提被打破。重试候选语义不受影响：
 *  retry 经 getTask 合并读归档集合，新任务照常入队。
 *  归档后活跃集合规模被压在「30 天已定格终态 + 进行中 + 未查收结果」窗口内，
 *  create/completeStep 等高频写的 O(N) 拷贝与全量重写成本随之有界。 */
const ARCHIVE_AFTER_DAYS = 30;

/** 终态定格时间（BUG-27）：succeeded 取查收时间（未查收返回 null 保持不清理语义），
 *  failed/canceled 取 finishedAt（无查收语义，失败信息本身即用户可见的终态结果） */
function settledAtOf(task) {
  if (task.status === STATUS.succeeded) {
    if (!task.resultAckedAt) return null;
    return settledTime(task.resultAckedAt);
  }
  return settledTime(task.finishedAt);
}

function settledTime(raw) {
  if (!raw) return null;
  const time = new Date(raw).getTime();
  return Number.isNaN(time) ? null : time;
}

/** 过期判定：已结束、已定格且超出保留期（未查收的成功结果不会被清理，避免用户还没看就消失） */
function expiredPredicate(threshold) {
  return (task) => {
    if (!FINISHED_STATUS.includes(task.status)) return false;
    const settledAt = settledAtOf(task);
    return settledAt !== null && settledAt < threshold;
  };
}

/** 归档判定：已定格且超出归档阈值（严格弱于过期判定，归档是删除前的中间层） */
function agedPredicate(threshold) {
  return (task) => {
    const settledAt = settledAtOf(task);
    return settledAt !== null && settledAt < threshold;
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

/** 孤儿时间线清扫（O13）：任务与其事件分属两个集合文件，删除任务的崩溃窗口可能遗留
 *  taskId 已不存在的 taskevents，且无任何后续清理路径。由每日维护（含启动即跑的一次）调用。
 *  已知 taskId 需含归档集合（BUG-20）：归档任务的时间线仍然有效，不得当作孤儿清扫 */
function purgeOrphanEvents() {
  // pluck 免克隆提取 id（PERF-6）：原 db.query(()=>true) 会把两个任务集合全部深拷贝一遍
  const knownIds = new Set([...db.pluck('tasks', (task) => task.id), ...db.pluck('tasks-archive', (task) => task.id)]);
  return db.removeWhere('taskevents', (event) => !knownIds.has(event.taskId)).removed;
}

module.exports = {
  list,
  queue,
  stats,
  exportTasks,
  ackAll,
  ARCHIVE_AFTER_DAYS,
  purgeExpired,
  archiveAged,
  purgePreview,
  purgeOrphanEvents
};
