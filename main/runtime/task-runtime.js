/**
 * 任务运行时
 * 职责：派发（queued → running）、逐步执行、注入「需要操作」暂停、恢复（resume）与收口（succeeded）。
 * 与执行器解耦：通过 executor 注册中心取用当前执行器，替换执行器即可从模拟切换到真实 LLM，
 * 本文件不感知具体执行器实现。所有执行器方法统一 await，兼容同步与异步（LLM）实现。
 *
 * 并发与离线：
 * - 同时执行的任务数受 MAX_CONCURRENT 限制，超出的排队等待槽位释放；
 * - 执行者离线的任务不占槽位，按指数退避重试，Worker 恢复在线时立即重试。
 */

const db = require('../store/db');
const bus = require('./event-bus');
const executorRegistry = require('./executor');
const taskService = require('../services/task-service');
const workerService = require('../services/worker-service');
const flowService = require('../services/flow-service');

/**
 * taskId → 执行上下文（仅保存瞬时状态，不持久化）。
 * 处于 contexts 中的任务占用一个并发槽位（含暂停态，语义为"已被运行时接管"）。
 * - timer: 兼容保留（当前用 sleep 的 AbortSignal 中断，未使用 timer 字段）
 * - actionUsed: 本任务是否已注入过用户操作
 * - controller: AbortController，任务取消时中止进行中的异步步骤
 * - pumping: 串行守卫，防止 resume/重入导致同一任务并行执行
 */
const contexts = new Map();

/** 并发上限：同时被运行时接管的任务数 */
const MAX_CONCURRENT = 5;
/** 离线重试：指数退避（30s 起步，最长 10 分钟） */
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 10 * 60 * 1000;

const waiting = new Set(); // 等待并发槽位的任务（保持插入顺序，先到先派发）
const retryTimers = new Map(); // taskId → 离线重试定时器
const retryAttempts = new Map(); // taskId → 已重试次数（控制退避与事件去重）

function start() {
  bus.onCommand('task:queued', dispatch);
  bus.onCommand('task:resumed', resume);
  bus.onCommand('task:canceled', stop);
  // 执行者恢复在线时，立即重试等待中的离线任务，不必等退避定时器
  bus.on(({ type, payload }) => {
    if ((type === 'worker:updated' || type === 'worker:created') && payload?.status === 'online') {
      for (const taskId of [...retryTimers.keys()]) {
        clearTimer(retryTimers, taskId);
        dispatch(taskId);
      }
    }
  });
  recover();
}

/** 应用退出时清理所有定时器与内存状态 */
function shutdown() {
  for (const ctx of contexts.values()) {
    if (ctx.timer) clearTimeout(ctx.timer);
    if (ctx.controller) ctx.controller.abort();
  }
  contexts.clear();
  for (const taskId of [...retryTimers.keys()]) clearTimer(retryTimers, taskId);
  waiting.clear();
  retryAttempts.clear();
}

function clearTimer(map, key) {
  const timer = map.get(key);
  if (timer) clearTimeout(timer);
  map.delete(key);
}

/** 槽位释放后排空等待队列 */
function drainWaiting() {
  while (waiting.size && contexts.size < MAX_CONCURRENT) {
    const next = waiting.values().next().value;
    waiting.delete(next);
    dispatch(next);
  }
}

/** 启动恢复：排队中的重新派发；执行中的从当前未完成步骤继续（重启不丢任务） */
function recover() {
  db.all('tasks').forEach((task) => {
    if (task.status === taskService.STATUS.queued) {
      dispatch(task.id);
    } else if (task.status === taskService.STATUS.running) {
      contexts.set(task.id, createContext({ actionUsed: Boolean(task.actionRequest?.answer) }));
      pump(task.id);
    }
  });
}

function createContext(overrides = {}) {
  return { timer: null, actionUsed: false, controller: new AbortController(), pumping: false, ...overrides };
}

/**
 * 解析任务的执行方式：
 * - flow：按 WorkerFlow 节点逐步委派（节点 Worker 必须都存在）
 * - worker：单 Worker / Group（Group 归一到组长）
 * - offline：执行者当前不在线，保持排队并退避重试
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
  // 派发链路（解析执行方式、构建步骤、标记运行）任何一环抛错都必须把任务落为失败，
  // 否则异常只会被事件总线的 command 吞掉，任务将永远停留在"排队中"
  try {
    dispatchUnsafe(taskId);
  } catch (error) {
    console.error(`[runtime] 任务 ${taskId} 派发失败:`, error);
    // 清理派发中间态：markRunning 前已占用并发槽位，异常时必须释放，否则槽位泄漏
    waiting.delete(taskId);
    clearTimer(retryTimers, taskId);
    retryAttempts.delete(taskId);
    contexts.delete(taskId);
    try {
      taskService.failTask(taskId, { code: 'RUNTIME_ERROR', message: error.message || '派发失败' });
    } catch (failError) {
      // 任务已被并发删除等极端情况：仅记录，不向上抛
      console.error(`[runtime] 任务 ${taskId} 失败落库异常:`, failError);
    }
  }
}

function dispatchUnsafe(taskId) {
  const task = taskService.getTask(taskId);
  if (!task || task.status !== taskService.STATUS.queued) return;

  const executor = executorRegistry.getActive();
  const execution = resolveExecution(task);
  if (execution.kind === 'invalid') {
    taskService.failTask(taskId, { code: 'VALIDATION_FAILED', message: execution.reason });
    return;
  }
  if (execution.kind === 'offline') {
    scheduleRetry(taskId, execution.name); // 不占并发槽位
    return;
  }
  if (contexts.size >= MAX_CONCURRENT) {
    waiting.add(taskId); // 槽位已满，排队等待
    return;
  }

  contexts.set(taskId, createContext());
  const isFlow = execution.kind === 'flow';
  const steps = isFlow ? executor.buildFlowSteps(task, execution.plan) : executor.buildSteps(task, execution.worker);
  const message = isFlow
    ? `已按 WorkerFlow「${execution.plan.flow.name}」启动，共 ${steps.length} 个节点`
    : `已派发给「${execution.worker.name}」`;
  taskService.markRunning(taskId, steps, message);
  pump(taskId);
}

/** 离线任务退避重试：首次记录时间线，之后静默重试；恢复在线由 start() 的监听立即触发 */
function scheduleRetry(taskId, name) {
  if (retryTimers.has(taskId)) return; // 已在重试计划中
  const attempts = retryAttempts.get(taskId) || 0;
  if (attempts === 0) taskService.recordEvent(taskId, `执行者「${name}」当前不在线，任务等待中`);
  retryAttempts.set(taskId, attempts + 1);
  const delay = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
  retryTimers.set(
    taskId,
    setTimeout(() => {
      retryTimers.delete(taskId);
      dispatch(taskId);
    }, delay)
  );
}

/** 可被取消信号中断的等待 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 执行循环：串行推进未完成步骤。
 * 每步 await 执行器（支持真实 LLM 异步）；需要用户操作时暂停并等待 resume。
 * pumping 守卫保证同一任务任意时刻只有一个循环在跑。
 */
async function pump(taskId) {
  const ctx = contexts.get(taskId);
  if (!ctx || ctx.pumping) return;
  ctx.pumping = true;

  try {
    while (true) {
      const executor = executorRegistry.getActive();
      const task = taskService.getTask(taskId);
      if (!task || task.status !== taskService.STATUS.running) return; // 已结束/暂停/被取消

      const step = task.steps.find((item) => item.status !== 'done');
      if (!step) return finish(taskId);

      taskService.startStep(taskId, step.step);
      await sleep(executor.stepDelay(), ctx.controller.signal);

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

      const outcome = await executor.runStep(fresh, step, { signal: ctx.controller.signal });
      taskService.completeStep(taskId, step.step, outcome.log, outcome.citations);
    }
  } catch (error) {
    if (error.message === 'aborted') return; // 任务取消，静默退出
    console.error(`[runtime] 任务 ${taskId} 执行异常:`, error);
    taskService.failTask(taskId, { code: 'RUNTIME_ERROR', message: error.message || '执行失败' });
  } finally {
    const current = contexts.get(taskId);
    if (current) current.pumping = false;
  }
}

function resume(taskId) {
  if (!contexts.has(taskId)) contexts.set(taskId, createContext({ actionUsed: true }));
  pump(taskId);
}

function finish(taskId) {
  const ctx = contexts.get(taskId);
  if (ctx?.timer) clearTimeout(ctx.timer);
  contexts.delete(taskId);
  retryAttempts.delete(taskId);
  drainWaiting(); // 释放槽位，派发排队任务

  const task = taskService.getTask(taskId);
  if (!task || task.status !== taskService.STATUS.running) return;
  const executor = executorRegistry.getActive();
  const worker = task.assignee.type === 'flow' ? null : workerService.resolveExecutorWorker(task.assignee);
  taskService.succeed(taskId, executor.buildResult(task, worker));
}

function stop(taskId) {
  waiting.delete(taskId);
  clearTimer(retryTimers, taskId);
  retryAttempts.delete(taskId);
  const ctx = contexts.get(taskId);
  if (ctx?.timer) clearTimeout(ctx.timer);
  if (ctx?.controller) ctx.controller.abort(); // 中断进行中的异步步骤
  contexts.delete(taskId);
  drainWaiting();
}

module.exports = { start, dispatch, stop, shutdown, MAX_CONCURRENT };
