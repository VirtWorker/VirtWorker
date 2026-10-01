/**
 * Webhook 出站通知（F2）
 * 自动任务配置 notify.webhookUrl 后，其任务进入终态（succeeded/failed）时向该地址
 * POST 结构化事件（event=task.finished）。定位是「数字员工干完活主动通知外部系统」的最短路径：
 * - 单次投递、10s 超时、不重试；投递结果写入任务时间线供排查，失败不影响任务状态
 * - 地址经 automation-service.normalizeNotify 校验（http/https、无 userinfo）后才入库
 * - 仅由任务触发来源 refId 关联到对应自动化；手动/聊天任务没有配置入口，不投递
 */

const bus = require('./event-bus');
const taskService = require('../services/task-service');
const automationService = require('../services/automation-service');

const TIMEOUT_MS = 10 * 1000;
let wired = false;

async function deliver(payload = {}) {
  const automation = automationService.listAll().find((item) => item.id === payload.triggerRefId);
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
    taskService.recordEvent(task.id, `Webhook 通知已投递（HTTP ${response.status}）`, { allowFinished: true });
    if (!response.ok) console.warn(`[webhook] 投递返回非 2xx（${response.status}）：${url}`);
  } catch (error) {
    console.error('[webhook] 投递失败:', url, error.message || error);
    taskService.recordEvent(task.id, `Webhook 通知投递失败：${error.message || '未知原因'}`, { allowFinished: true });
  } finally {
    clearTimeout(timer);
  }
}

/** 订阅任务终态指令；重复调用幂等（测试环境多次 start 安全） */
function start() {
  if (wired) return;
  wired = true;
  bus.onCommand('task:finished', (payload) => {
    deliver(payload).catch((error) => console.error('[webhook] 通知异常:', error));
  });
}

module.exports = { start, deliver };
