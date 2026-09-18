/**
 * 执行器注册中心：定义任务运行时（task-runtime）与执行器之间的统一接口契约。
 *
 * 接口契约（各方法可同步或异步实现，运行时统一 await）：
 * - name: string                     执行器唯一标识（mock / llm / ...）
 * - buildSteps(task, worker)         单 Worker 执行计划 → Step[]
 * - buildFlowSteps(task, plan)       WorkerFlow 执行计划 → Step[]
 * - stepDelay()                      步骤间隔（毫秒）
 * - runStep(task, step, ctx)         执行一个步骤 → { log, citations }（真实实现可 async 调 LLM）
 * - maybeAction(task, step, ctx)     是否需要请求用户操作 → actionRequest | null
 * - buildResult(task, worker)        汇总执行结果 → Result
 *
 * ctx 上下文：
 * - actionUsed: boolean              本任务是否已注入过用户操作
 * - randomAction: boolean            是否允许概率性操作注入
 * - signal: AbortSignal              任务取消时中止；真实 LLM 执行器应据此中断进行中的请求
 *
 * 替换真实执行器：实现同一契约后 register() 并 setActive()，无需改动运行时。
 */

/** @type {Map<string, object>} */
const executors = new Map();
let activeName = null;

function validate(executor) {
  if (!executor || typeof executor !== 'object') throw new Error('执行器必须是对象');
  if (!executor.name) throw new Error('执行器必须提供 name 标识');
  const required = ['buildSteps', 'buildFlowSteps', 'stepDelay', 'runStep', 'maybeAction', 'buildResult'];
  const missing = required.filter((method) => typeof executor[method] !== 'function');
  if (missing.length) throw new Error(`执行器「${executor.name}」缺少方法：${missing.join('、')}`);
}

/** 注册执行器；首个注册者自动成为当前执行器 */
function register(executor, { activate = false } = {}) {
  validate(executor);
  executors.set(executor.name, executor);
  if (activate || activeName === null) activeName = executor.name;
  return executor;
}

/** 切换当前生效的执行器 */
function setActive(name) {
  if (!executors.has(name)) throw new Error(`执行器「${name}」未注册`);
  activeName = name;
}

/** 当前生效的执行器 */
function getActive() {
  const executor = executors.get(activeName);
  if (!executor) throw new Error('没有可用的执行器，请先 register()');
  return executor;
}

function listNames() {
  return [...executors.keys()];

}

module.exports = { register, setActive, getActive, listNames };
