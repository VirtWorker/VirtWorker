/**
 * 任务运行时
 * 职责：派发（queued → running）、逐步执行、注入「需要操作」暂停、恢复（resume）与收口（succeeded）。
 * 与执行器解耦：通过 executor 注册中心取用当前执行器，替换执行器即可从模拟切换到真实 LLM，
 * 本文件不感知具体执行器实现。所有执行器方法统一 await，兼容同步与异步（LLM）实现。
 *
 * 并发与离线：
 * - 同时执行的任务数受 MAX_CONCURRENT 限制，超出的排队等待槽位释放；
 * - need_action 暂停态不占槽位（人工操作可能耗时数小时），恢复时重新参与并发检查；
 * - 等待队列按任务优先级派发（urgent > high > normal > low），同级先到先执行；
 * - 执行者离线的任务不占槽位，按指数退避重试，Worker 恢复在线时立即重试；
 * - 单步执行带超时兜底（STEP_TIMEOUT_MS，可被执行器 stepTimeoutMs() 覆盖），
 *   执行异常/超时的任务立即释放槽位并落为失败，不会出现槽位泄漏锁死运行时。
 */

const db = require('../store/db');
const bus = require('./event-bus');
const executorRegistry = require('./executor');
const taskService = require('../services/task-service');
const workerService = require('../services/worker-service');
const flowService = require('../services/flow-service');

/**
 * taskId → 执行上下文（仅保存瞬时状态，不持久化）。
 * 处于 contexts 中的任务占用一个并发槽位；need_action 暂停会释放槽位，恢复时重建。
 * - executor: 派发时锁定的执行器（同一任务中途不会被切换，避免出现半 Mock 半 LLM 的任务）
 * - actionUsed: 本任务是否已注入过用户操作
 * - controller: AbortController，任务取消时中止进行中的异步步骤
 * - pumping: 串行守卫，防止 resume/重入导致同一任务并行执行
 */
const contexts = new Map();

/** 并发上限默认值：可在设置中调整（maxConcurrent，1..20，O16） */
const MAX_CONCURRENT = 5;
/** 离线重试：指数退避（30s 起步，最长 10 分钟） */
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 10 * 60 * 1000;
/** 单步执行默认超时：执行器可通过 stepTimeoutMs() 覆盖（真实 LLM 执行器建议按请求特征设定） */
const STEP_TIMEOUT_MS = 120 * 1000;
/** 步骤级重试退避：1s 起步、翻倍、上限 30s（F1；次数由执行器 stepRetryLimit() 声明） */
const STEP_RETRY_BASE_MS = 1000;
const STEP_RETRY_MAX_MS = 30 * 1000;
/** 任务优先级 → 派发顺序（值越小越先派发），与 task-service 的 priority 枚举对应 */
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

/**
 * 当前有效并发上限（O16）：取设置值（maxConcurrent），并受执行器声明的
 * maxParallel() 约束（如真实 LLM 执行器按上游速率限制声明更低的并行度）。
 */
function capacity() {
  const configured = Number(db.getSettings().maxConcurrent);
  let cap = Number.isInteger(configured) && configured >= 1 && configured <= 20 ? configured : MAX_CONCURRENT;
  try {
    const executor = executorRegistry.getActive();
    const declared = typeof executor.maxParallel === 'function' ? Number(executor.maxParallel()) : 0;
    if (Number.isInteger(declared) && declared >= 1) cap = Math.min(cap, declared);
  } catch (error) {
    // 无注册执行器时按设置值返回（dispatch 阶段会得到更明确的错误）
  }
  return cap;
}

const waiting = new Set(); // 等待并发槽位的任务（含暂停恢复的 running 任务）；派发顺序见 drainWaiting
const retryTimers = new Map(); // taskId → 离线重试定时器
const retryAttempts = new Map(); // taskId → 已重试次数（控制退避与事件去重）

function start() {
  bus.onCommand('task:queued', dispatch);
  bus.onCommand('task:resumed', resume);
  bus.onCommand('task:canceled', stop);
  // 执行者恢复在线时，立即重试等待中的离线任务，不必等退避定时器
  const retryWaitingTasks = () => {
    for (const taskId of [...retryTimers.keys()]) {
      clearTimer(retryTimers, taskId);
      dispatch(taskId);
    }
  };
  bus.on('worker:updated', (payload) => {
    if (payload?.status === 'online') retryWaitingTasks();
  });
  bus.on('worker:created', (payload) => {
    if (payload?.status === 'online') retryWaitingTasks();
  });
  // 兜底：执行者被删除时，等待队列/离线重试中的任务立即重新派发一次，
  // 由 resolveExecution 的执行者缺失检查尽快落为失败（服务层级联取消是主路径，这里兜住漏网任务）
  bus.on('worker:removed', () => {
    retryWaitingTasks();
    for (const taskId of [...waiting]) {
      waiting.delete(taskId);
      dispatch(taskId);
    }
  });
  recover();
  // 重启补提醒（O10）：need_action 任务重启后不会自愈，主动提示并由看门狗按策略接管
  const pending = taskService.listNeedAction();
  if (pending.length) {
    bus.emit('app:notice', {
      level: 'warning',
      title: `有 ${pending.length} 个任务正在等待操作`,
      body: '任务在重启前挂起于「需要操作」状态，请到任务看板处理'
    });
  }
  startActionWatchdog();
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
  stopActionWatchdog();
}

function clearTimer(map, key) {
  const timer = map.get(key);
  if (timer) clearTimeout(timer);
  map.delete(key);
}

/** 槽位释放后排空等待队列：按优先级派发（urgent > high > normal > low），同级先到先执行 */
function drainWaiting() {
  while (waiting.size && contexts.size < capacity()) {
    const next = takeNextWaiting();
    if (!next) return;
    dispatch(next);
  }
}

/** 取出等待队列中最应派发的任务（顺带清理已结束/暂停的失效条目） */
function takeNextWaiting() {
  let best = null;
  for (const taskId of [...waiting]) {
    const task = taskService.getTask(taskId);
    const eligible =
      task && (task.status === taskService.STATUS.queued || task.status === taskService.STATUS.running);
    if (!eligible) {
      waiting.delete(taskId); // 排队期间已被取消/结束的任务不再占队
      continue;
    }
    const rank = PRIORITY_RANK[task.priority] ?? PRIORITY_RANK.normal;
    if (!best || rank < best.rank || (rank === best.rank && task.createdAt < best.createdAt)) {
      best = { id: taskId, rank, createdAt: task.createdAt };
    }
  }
  if (best) waiting.delete(best.id);
  return best ? best.id : null;
}

/** 释放任务占用的并发槽位与全部中间态（派发失败 / 执行异常 / 超时 / 取消的公共清理路径） */
function release(taskId) {
  const ctx = contexts.get(taskId);
  if (ctx?.timer) clearTimeout(ctx.timer);
  contexts.delete(taskId);
  waiting.delete(taskId);
  clearTimer(retryTimers, taskId);
  retryAttempts.delete(taskId);
  drainWaiting(); // 槽位已释放，立即派发排队任务
}

/** 失败落库：终态守卫可能拒绝改写（如取消与异常竞争），只记录不外抛 */
function safeFailTask(taskId, error) {
  try {
    taskService.failTask(taskId, error);
  } catch (failError) {
    console.error(`[runtime] 任务 ${taskId} 失败落库异常:`, failError.message);
  }
}

/** 启动恢复：排队与执行中的任务统一走 dispatch 重新派发——
 *  并发上限与执行者在线检查和正常路径完全一致（不再绕过），
 *  执行进度从第一个未完成步骤继续，重启不丢任务 */
function recover() {
  db.all('tasks').forEach((task) => {
    if (task.status === taskService.STATUS.queued || task.status === taskService.STATUS.running) {
      dispatch(task.id);
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
  if (!worker) {
    // 执行者已被删除（或 Group 成员被清空）时按离线处理只会无限重试，任务将永远卡在排队中，直接判失败
    return { kind: 'invalid', reason: `执行者「${task.assignee.name}」不存在或没有可用成员，请重新选择执行者` };
  }
  if (worker.status === 'offline') return { kind: 'offline', name: task.assignee.name };
  return { kind: 'worker', worker };
}

function dispatch(taskId) {
  if (contexts.has(taskId)) return; // 防止重复派发导致并行执行
  // 派发链路（解析执行方式、构建步骤、标记运行）任何一环抛错都必须把任务落为失败，
  // 否则异常只会被事件总线的 command 吞掉，任务将永远停留在"排队中"。
  // dispatch 为 async：真实执行器的 buildSteps 是异步的；bus.command 已兼容 Promise 拒绝
  return dispatchUnsafe(taskId).catch((error) => {
    console.error(`[runtime] 任务 ${taskId} 派发失败:`, error);
    release(taskId); // markRunning 前已占用并发槽位，异常时必须释放，否则槽位泄漏
    safeFailTask(taskId, { code: 'RUNTIME_ERROR', message: error.message || '派发失败' });
  });
}

async function dispatchUnsafe(taskId) {
  const task = taskService.getTask(taskId);
  if (!task) return;
  // running 状态的重新接管（启动恢复 / 暂停后排队）：从第一个未完成步骤继续
  if (task.status === taskService.STATUS.running) {
    resumeRunning(taskId, task);
    return;
  }
  if (task.status !== taskService.STATUS.queued) return;

  const executor = executorRegistry.getActive(); // 派发时锁定执行器，任务中途不再更换
  const execution = resolveExecution(task);
  if (execution.kind === 'invalid') {
    taskService.failTask(taskId, { code: 'VALIDATION_FAILED', message: execution.reason });
    return;
  }
  if (execution.kind === 'offline') {
    scheduleRetry(taskId, execution.name); // 不占并发槽位
    return;
  }
  if (contexts.size >= capacity()) {
    waiting.add(taskId); // 槽位已满，排队等待
    return;
  }

  contexts.set(taskId, createContext({ executor }));
  const isFlow = execution.kind === 'flow';
  // 契约统一 await：步骤计划允许异步生成（真实 LLM 执行器常见）；同步实现零成本兼容
  let steps = await (isFlow
    ? executor.buildFlowSteps(task, execution.plan)
    : executor.buildSteps(task, execution.worker));
  // await 期间任务可能已被取消/删除：非排队态不得再标记运行（与 pump 的 afterRun 守卫同款）
  const fresh = taskService.getTask(taskId);
  if (!fresh || fresh.status !== taskService.STATUS.queued) {
    release(taskId);
    return;
  }
  // 断点重跑（F1）：重试任务从原任务的失败步骤继续，此前步骤沿用原执行结果
  const retryFromStep = Number(task.input?.retryFromStep) || 0;
  if (retryFromStep > 1 && task.retryOf) {
    const source = taskService.getTask(task.retryOf);
    if (source) {
      steps = steps.map((step) => {
        if (step.step >= retryFromStep) return step;
        const prev = (source.steps || []).find((item) => item.step === step.step);
        if (!prev || prev.status !== 'done') return step;
        return { ...step, status: 'done', log: prev.log || '', citations: prev.citations || [], finishedAt: prev.finishedAt || null };
      });
    }
  }
  const message = isFlow
    ? `已按 WorkerFlow「${execution.plan.flow.name}」启动，共 ${steps.length} 个节点`
    : `已派发给「${execution.worker.name}」`;
  taskService.markRunning(taskId, steps, message);
  pump(taskId);
}

/** running 任务的重新接管：与正常派发共用执行者检查与并发上限（恢复语义不再绕过任何检查） */
function resumeRunning(taskId, task) {
  if (contexts.has(taskId)) return; // 正在执行中
  const execution = resolveExecution(task);
  if (execution.kind === 'invalid') {
    taskService.failTask(taskId, { code: 'VALIDATION_FAILED', message: execution.reason });
    return;
  }
  if (execution.kind === 'offline') {
    scheduleRetry(taskId, execution.name);
    return;
  }
  if (contexts.size >= capacity()) {
    waiting.add(taskId);
    return;
  }
  contexts.set(
    taskId,
    createContext({ executor: executorRegistry.getActive(), actionUsed: Boolean(task.actionRequest?.answer) })
  );
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
 * 带超时保护的单步执行：真实执行器（LLM 网络调用）挂起时若不设防，
 * 任务将永久卡在 running 并占用并发槽位。超时是兜底失败，不改变取消语义。
 */
async function runStepWithTimeout(executor, task, step, ctx) {
  const declared = typeof executor.stepTimeoutMs === 'function' ? Number(executor.stepTimeoutMs()) : 0;
  const timeoutMs = declared > 0 ? declared : STEP_TIMEOUT_MS;
  let timer;
  try {
    return await Promise.race([
      executor.runStep(task, step, { signal: ctx.controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`步骤执行超过 ${Math.round(timeoutMs / 1000)} 秒未返回，已中止`);
          error.code = 'STEP_TIMEOUT';
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const executor = ctx.executor || executorRegistry.getActive(); // 全程使用派发时锁定的执行器
  // 步骤级重试计数（F1）：同一步骤内累计，成功后清零；次数由执行器 stepRetryLimit() 声明
  let stepRetries = 0;

  try {
    while (true) {
      const task = taskService.getTask(taskId);
      if (!task) return release(taskId); // 任务已被删除：必须释放槽位
      if (task.status !== taskService.STATUS.running) return; // 暂停/取消：槽位已由 requestAction/stop 释放

      const step = task.steps.find((item) => item.status !== 'done');
      if (!step) return await finish(taskId); // await 保持在 try 内：收口抛错仍走本循环的异常兜底

      taskService.startStep(taskId, step.step);
      await sleep(executor.stepDelay(), ctx.controller.signal);

      const fresh = taskService.getTask(taskId);
      if (!fresh) return release(taskId);
      if (fresh.status !== taskService.STATUS.running) return;

      const action = await executor.maybeAction(fresh, step, { actionUsed: ctx.actionUsed });

      if (action) {
        ctx.actionUsed = true;
        taskService.requestAction(taskId, action); // 进入暂停态，等待 task:resumed
        release(taskId); // 暂停态释放并发槽位：人工操作可能耗时数小时，不应阻塞其他任务派发
        return;
      }

      let outcome;
      try {
        outcome = await runStepWithTimeout(executor, fresh, step, ctx);
      } catch (error) {
        // 超时与取消不重试：前者是挂起兜底（重试只会加倍挂起时间），后者是用户意图
        if (error?.code === 'STEP_TIMEOUT') throw error;
        if (error.message === 'aborted' || ctx.controller.signal.aborted) throw error;
        const limit =
          typeof executor.stepRetryLimit === 'function' ? Number(executor.stepRetryLimit()) || 0 : 0;
        if (stepRetries >= limit) throw error;
        stepRetries += 1;
        taskService.recordEvent(
          taskId,
          `步骤「${step.title}」执行失败（${error.message}），第 ${stepRetries}/${limit} 次重试`
        );
        await sleep(Math.min(STEP_RETRY_BASE_MS * 2 ** (stepRetries - 1), STEP_RETRY_MAX_MS), ctx.controller.signal);
        const retried = taskService.getTask(taskId);
        if (!retried) return release(taskId);
        if (retried.status !== taskService.STATUS.running) return;
        continue; // 重跑同一步骤（startStep 只标记 pending，不会重复计时）
      }
      // runStep（异步执行时为挂起点）期间任务可能已被取消/暂停：非 running 态不得再写入步骤数据
      const afterRun = taskService.getTask(taskId);
      if (!afterRun) return release(taskId);
      if (afterRun.status !== taskService.STATUS.running) return;
      taskService.completeStep(taskId, step.step, outcome.log, outcome.citations);
      stepRetries = 0;
    }
  } catch (error) {
    if (error?.code === 'STEP_TIMEOUT') {
      ctx.controller.abort(); // 通知执行器中止挂起的请求（真实执行器应中断网络调用）
      console.error(`[runtime] 任务 ${taskId} ${error.message}`);
      release(taskId);
      safeFailTask(taskId, { code: 'STEP_TIMEOUT', message: error.message });
      return;
    }
    // 取消识别以 abort 信号为准（不同执行器的 abort 错误文案各异）；取消时 stop() 已完成清理
    if (error.message === 'aborted' || ctx.controller.signal.aborted) return;
    console.error(`[runtime] 任务 ${taskId} 执行异常:`, error);
    release(taskId); // 异常路径必须释放并发槽位，否则失败任务累积会锁死运行时
    safeFailTask(taskId, { code: 'RUNTIME_ERROR', message: error.message || '执行失败' });
  } finally {
    const current = contexts.get(taskId);
    if (current) current.pumping = false;
  }
}

/** 暂停任务恢复：槽位在暂停时已释放，统一复用 dispatch 路径（并发检查 / 执行者检查 / 等待队列全部一致） */
function resume(taskId) {
  const task = taskService.getTask(taskId);
  if (!task || task.status !== taskService.STATUS.running) return;
  if (contexts.has(taskId)) {
    pump(taskId);
    return;
  }
  dispatch(taskId);
}

async function finish(taskId) {
  const ctx = contexts.get(taskId);
  if (ctx?.timer) clearTimeout(ctx.timer);
  contexts.delete(taskId);
  retryAttempts.delete(taskId);
  drainWaiting(); // 释放槽位，派发排队任务

  const task = taskService.getTask(taskId);
  if (!task || task.status !== taskService.STATUS.running) return;
  const executor = ctx.executor || executorRegistry.getActive();
  const worker = task.assignee.type === 'flow' ? null : workerService.resolveExecutorWorker(task.assignee);
  // 契约统一 await：结果汇总允许异步（真实 LLM 执行器需要等待最终响应）
  taskService.succeed(taskId, await executor.buildResult(task, worker));
}

function stop(taskId) {
  const ctx = contexts.get(taskId);
  if (ctx?.controller) ctx.controller.abort(); // 中断进行中的异步步骤
  release(taskId);
}

// ==================== need_action 超时看门狗（O10） ====================

const ACTION_CHECK_INTERVAL_MS = 60 * 1000;
const ACTION_REMIND_INTERVAL_MS = 24 * 60 * 60 * 1000;
let actionWatchdogTimer = null;

function startActionWatchdog() {
  if (actionWatchdogTimer) return;
  actionWatchdogTimer = setInterval(() => checkActionTimeouts(), ACTION_CHECK_INTERVAL_MS);
  actionWatchdogTimer.unref?.(); // 不阻塞进程退出
}

function stopActionWatchdog() {
  if (actionWatchdogTimer) clearInterval(actionWatchdogTimer);
  actionWatchdogTimer = null;
}

/**
 * 扫描挂起任务并按超时策略处置（O10）：
 * - fail：自动失败（ACTION_TIMEOUT）
 * - continue：自动采用默认选项继续（无默认值则失败）
 * - remind：保持挂起，每 24 小时重发一次提醒
 * actionTimeoutHours = 0 表示关闭超时处置。扫描与处置均做逐任务容错。
 */
function checkActionTimeouts(now = Date.now()) {
  const settings = db.getSettings();
  const hours = Number(settings.actionTimeoutHours);
  if (!Number.isFinite(hours) || hours <= 0) return;
  const policy = ['fail', 'continue', 'remind'].includes(settings.actionTimeoutPolicy)
    ? settings.actionTimeoutPolicy
    : 'remind';
  const deadline = hours * 60 * 60 * 1000;

  taskService.listNeedAction().forEach((task) => {
    try {
      const request = task.actionRequest || {};
      const createdAt = new Date(request.createdAt || task.updatedAt).getTime();
      if (Number.isNaN(createdAt) || now - createdAt < deadline) return;

      if (policy === 'fail') {
        taskService.failTask(task.id, {
          code: 'ACTION_TIMEOUT',
          message: `等待操作超过 ${hours} 小时，已按超时策略自动失败`
        });
        return;
      }

      if (policy === 'continue') {
        const defaultValue = request.defaultValue;
        if (defaultValue === null || defaultValue === undefined) {
          taskService.failTask(task.id, {
            code: 'ACTION_TIMEOUT',
            message: `等待操作超过 ${hours} 小时且无默认选项，已自动失败`
          });
          return;
        }
        taskService.answer({ taskId: task.id, answer: { value: defaultValue } });
        bus.emit('app:notice', {
          level: 'info',
          title: `「${task.title}」已按超时策略自动继续`,
          body: '操作等待超时，已采用默认选项继续执行'
        });
        return;
      }

      // remind：首次超时即提醒，此后重发间隔不低于 24 小时，避免通知刷屏
      if (request.remindedAt) {
        const last = new Date(request.remindedAt).getTime();
        if (!Number.isNaN(last) && now - last < ACTION_REMIND_INTERVAL_MS) return;
      }
      taskService.touchActionReminder(task.id);
      bus.emit('app:notice', {
        level: 'warning',
        title: `「${task.title}」仍在等待你的操作`,
        body: `已等待超过 ${hours} 小时，请尽快到任务看板处理`
      });
    } catch (error) {
      // 处置竞争（如扫描与用户操作同时发生）只记录，不中断其余任务
      console.error(`[runtime] 任务 ${task.id} 超时处置失败:`, error.message || error);
    }
  });
}

module.exports = { start, dispatch, stop, shutdown, MAX_CONCURRENT, capacity, checkActionTimeouts };
