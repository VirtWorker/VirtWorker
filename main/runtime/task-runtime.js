/**
 * 任务运行时
 * 职责：派发（queued → running）、逐步执行、注入「需要操作」暂停、恢复（resume）与收口（succeeded）。
 * 与执行器解耦：替换 executor 即可从模拟执行切换到真实 LLM 执行。
 */

const db = require('../store/db');
const bus = require('./event-bus');
const taskService = require('../services/task-service');
const workerService = require('../services/worker-service');
const flowService = require('../services/flow-service');
const executor = require('./executor-mock');

/** taskId → { timer, actionUsed }：仅保存执行过程中的瞬时上下文，不持久化 */
const contexts = new Map();

function start() {
  bus.onCommand('task:queued', dispatch);
  bus.onCommand('task:resumed', resume);
  bus.onCommand('task:canceled', stop);
  recover();
}

/** 启动恢复：排队中的重新派发；执行中的从当前未完成步骤继续（重启不丢任务） */
function recover() {
  db.all('tasks').forEach((task) => {
    if (task.status === taskService.STATUS.queued) {
      dispatch(task.id);
    } else if (task.status === taskService.STATUS.running) {
      contexts.set(task.id, { timer: null, actionUsed: Boolean(task.actionRequest?.answer) });
      pump(task.id);
    }
  });
}

/**
 * 解析任务的执行方式：
 * - flow：按 WorkerFlow 节点逐步委派（节点 Worker 必须都存在）
 * - worker：单 Worker / Group（Group 归一到组长）
 * - offline：执行者当前不在线，保持排队
 */
function resolveExecution(task) {
  if (task.assignee.type === 'flow') {
    const plan = flowService.buildPlan(task.assignee.id);
    const missing = plan.nodes.filter((node) => !node.worker);
    if (missing.length) {
      return { kind: 'invalid', reason: `流程节点绑定的 Worker 已删除：${missing.map((node) => node.title).join('、')}` };
    }
    return { kind: 'flow', plan };
  }
  const worker = workerService.resolveExecutorWorker(task.assignee);
  if (!worker || worker.status === 'offline') return { kind: 'offline', name: task.assignee.name };
  return { kind: 'worker', worker };
}

function dispatch(taskId) {
  if (contexts.has(taskId)) return; // 防止重复派发导致并行执行
  const task = taskService.getTask(taskId);
  if (!task || task.status !== taskService.STATUS.queued) return;

  const execution = resolveExecution(task);
  if (execution.kind === 'offline') {
    // 保持排队状态并记录时间线，任务不丢失
    taskService.recordEvent(taskId, `执行者「${execution.name}」当前不在线，任务等待中`);
    return;
  }
  if (execution.kind === 'invalid') {
    taskService.failTask(taskId, { code: 'VALIDATION_FAILED', message: execution.reason });
    return;
  }

  contexts.set(taskId, { timer: null, actionUsed: false });
  const isFlow = execution.kind === 'flow';
  const steps = isFlow ? executor.buildFlowSteps(task, execution.plan) : executor.buildSteps(task, execution.worker);
  const message = isFlow
    ? `已按 WorkerFlow「${execution.plan.flow.name}」启动，共 ${steps.length} 个节点`
    : `已派发给「${execution.worker.name}」`;
  taskService.markRunning(taskId, steps, message);
  pump(taskId);
}

/** 执行循环：每步结束时判断是否需要请求用户操作，否则继续下一步 */
function pump(taskId) {
  const ctx = contexts.get(taskId);
  const task = taskService.getTask(taskId);
  if (!ctx || !task || task.status !== taskService.STATUS.running) return;

  const step = task.steps.find((item) => item.status !== 'done');
  if (!step) return finish(taskId);

  taskService.startStep(taskId, step.step);
  ctx.timer = setTimeout(() => {
    ctx.timer = null;
    const fresh = taskService.getTask(taskId);
    if (!fresh || fresh.status !== taskService.STATUS.running) return;

    const action = executor.maybeAction(fresh, step, {
      actionUsed: ctx.actionUsed,
      randomAction: db.getSettings().mockRandomAction !== false
    });

    if (action) {
      ctx.actionUsed = true;
      taskService.requestAction(taskId, action); // 进入暂停态，等待 task:resumed
      return;
    }

    const outcome = executor.runStep(fresh, step);
    taskService.completeStep(taskId, step.step, outcome.log, outcome.citations);
    pump(taskId);
  }, executor.stepDelay());
}

function resume(taskId) {
  if (!contexts.has(taskId)) contexts.set(taskId, { timer: null, actionUsed: true });
  pump(taskId);
}

function finish(taskId) {
  const ctx = contexts.get(taskId);
  if (ctx?.timer) clearTimeout(ctx.timer);
  contexts.delete(taskId);

  const task = taskService.getTask(taskId);
  if (!task || task.status !== taskService.STATUS.running) return;
  const worker = task.assignee.type === 'flow' ? null : workerService.resolveExecutorWorker(task.assignee);
  taskService.succeed(taskId, executor.buildResult(task, worker));
}

function stop(taskId) {
  const ctx = contexts.get(taskId);
  if (ctx?.timer) clearTimeout(ctx.timer);
  contexts.delete(taskId);
}

module.exports = { start, dispatch, stop };