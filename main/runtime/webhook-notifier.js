/**
 * Webhook 出站通知（F2）
 * 自动任务配置 notify.webhookUrl 后，其任务进入终态（succeeded/failed）时向该地址
 * POST 结构化事件（event=task.finished）。定位是「数字员工干完活主动通知外部系统」的最短路径：
 * - 投递失败（网络异常/非 2xx）按指数退避重试 2 次（E4：此前单次投递，目标端瞬时抖动即永久丢通知）；
 *   投递结果（含重试次数）写入任务时间线供排查，最终失败不影响任务状态
 * - 地址经 automation-service.normalizeNotify 校验（http/https、无 userinfo）后才入库
 * - 仅由任务触发来源 refId 关联到对应自动化；手动/聊天任务没有配置入口，不投递
 */

const bus = require('./event-bus');
const taskService = require('../services/task-service');
const automationService = require('../services/automation-service');

const TIMEOUT_MS = 10 * 1000;
/** 首次投递 + 2 次重试的间隔（指数退避）：目标端瞬时抖动（重启/限流/网络闪断）即可自愈 */
const RETRY_DELAYS_MS = [2 * 1000, 8 * 1000];
let wired = false;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.(); // 不阻塞进程退出（before-quit 无需等待通知重试链）
  });
}

async function deliver(payload = {}) {
  const automation = automationService.findById(payload.triggerRefId); // 免全集合克隆（B1）
  const url = automation?.notify?.webhookUrl;
  if (!url) return;
  const task = taskService.getTask(payload.taskId);
  if (!task) return;

  const body = JSON.stringify({
    event: 'task.finished',
    taskId: task.id,
    title: task.title,
    status: task.status,
    automationId: automation.id,
    automationName: automation.name,
    finishedAt: task.finishedAt,
    result: task.result ? { summary: task.result.summary || '', artifacts: task.result.artifacts || [] } : null,
    error: task.error || null
  });

  let lastError = null;
  let attempts = 0;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VirtWorker-Event': 'task.finished' },
        body,
        signal: controller.signal
      });
      if (response.ok) {
        taskService.recordEvent(
          task.id,
          `Webhook 通知已投递（HTTP ${response.status}）${attempts > 1 ? `，重试 ${attempts - 1} 次后成功` : ''}`,
          { allowFinished: true }
        );
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
  }

  console.error('[webhook] 投递失败:', url, lastError?.message || '未知原因');
  taskService.recordEvent(
    task.id,
    `Webhook 通知投递失败（共 ${attempts} 次尝试）：${lastError?.message || '未知原因'}`,
    { allowFinished: true }
  );
}

/** 订阅任务终态指令；重复调用幂等（测试环境多次 start 安全） */
function start() {
  if (wired) return;
  wired = true;
  bus.onCommand('task:finished', (payload) => {
    deliver(payload).catch((error) => console.error('[webhook] 通知异常:', error));
  });
}

module.exports = { start, deliver, RETRY_DELAYS_MS };
