/**
 * 自动任务调度器
 * - 定时触发：单个常驻定时器（上限 60s 唤醒一次并重算），兼容休眠与时钟漂移；无计划时不占用定时器
 * - 事件触发：监听 task-service 发出的终态指令（task:finished），按事件源匹配自动任务
 * - 启动补跑：应用未运行期间错过的定时任务，默认补跑一次（可在设置中关闭）
 * 触发后统一调用 task-service 创建任务，复用 Phase 1 的执行运行时。
 */

const db = require('../store/db');
const bus = require('./event-bus');
const taskService = require('../services/task-service');
const automationService = require('../services/automation-service');

/** 定时器单次最长等待：到点后重算，避免长时间挂起导致计划漂移 */
const MAX_TIMER_MS = 60 * 1000;
const MIN_TIMER_MS = 500;
/** 事件触发链最大深度：防止自动任务互相触发形成无限循环 */
const MAX_CHAIN_DEPTH = 3;

const EVENT_SOURCE_LABEL = { task_succeeded: '任务完成', task_failed: '任务失败' };

let timer = null;

function start() {
  bus.onCommand('automation:changed', () => arm());
  bus.onCommand('task:finished', onTaskFinished);
  catchUpMissed();
  arm();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** 启动补跑：错过的定时任务最多补一次，避免积压出大量任务 */
function catchUpMissed() {
  const missed = automationService.dueSchedules();
  if (!missed.length) return;
  if (db.getSettings().catchUpMissed === false) {
    missed.forEach((automation) => automationService.advanceSchedule(automation.id));
    console.log(`[scheduler] 已跳过 ${missed.length} 个错过的定时任务（补跑已关闭）`);
    return;
  }
  missed.forEach((automation) => fire(automation, '补跑错过的定时'));
  console.log(`[scheduler] 已补跑 ${missed.length} 个错过的定时任务`);
}

/** 触发一个自动任务：装配输入 → 创建任务 → 推进计划 */
function fire(automation, reason, overrides = {}) {
  const task = taskService.create({
    goal: overrides.goal || automation.input.goal,
    assigneeId: automation.executor.id,
    workspace: automation.input.workspace,
    priority: automation.input.priority,
    confirmFirst: automation.input.confirmFirst,
    trigger: { type: automation.trigger.type, refId: automation.id, depth: overrides.depth || 0 },
    payload: { automationId: automation.id, reason, ...(overrides.payload || {}) }
  });

  automationService.markFired(automation.id, task.id, { reason });
  bus.emit('app:notice', {
    level: 'info',
    title: `自动任务「${automation.name}」已开工`,
    body: task.title
  });
  return task;
}

/** 事件触发：任务进入终态时匹配启用中的事件型自动任务 */
function onTaskFinished(payload = {}) {
  const source =
    payload.status === 'succeeded' ? 'task_succeeded' : payload.status === 'failed' ? 'task_failed' : null;
  if (!source) return;

  const depth = (payload.depth || 0) + 1;
  if (depth > MAX_CHAIN_DEPTH) {
    console.warn('[scheduler] 事件触发链已达上限，忽略本次触发:', payload.taskId);
    return;
  }

  automationService.listEnabledByEvent(source).forEach((automation) => {
    if (automation.id === payload.triggerRefId) return; // 不由自身触发的任务回触自己
    const scoped = automation.trigger.event.assigneeId;
    if (scoped && scoped !== payload.assigneeId) return;
    fire(automation, `事件触发：${EVENT_SOURCE_LABEL[source]}`, { depth });
  });
}

/** 重排下一次唤醒；没有待触发的定时任务时不占用定时器 */
function arm() {
  stop();
  const next = automationService.earliestNextRun();
  if (!next) return;
  const delay = Math.min(Math.max(next - Date.now(), MIN_TIMER_MS), MAX_TIMER_MS);
  timer = setTimeout(tick, delay);
}

function tick() {
  timer = null;
  automationService.dueSchedules().forEach((automation) => fire(automation, '定时触发'));
  arm();
}

module.exports = { start, stop, fire };