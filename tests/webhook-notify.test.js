/**
 * Webhook 出站通知测试（F2）
 * 覆盖：地址校验（http/https、无 userinfo）、终态投递到本地 HTTP 接收端点（真实 fetch）、
 * 投递结果写入任务时间线、未配置 webhookUrl 的自动化静默跳过。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';
import { initTempDb, cleanupTempDb, db, workerService, automationService, taskService } from './setup.js';

const require = createRequire(import.meta.url);
const notifier = require('../main/runtime/webhook-notifier');

/** 轮询任务时间线直到出现 Webhook 投递记录（投递是异步的） */
async function waitForWebhookEvent(taskId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = taskService.detail(taskId).task.events;
    const hit = events.find((event) => event.message.includes('Webhook'));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等待任务 ${taskId} 的 Webhook 时间线超时`);
}

describe('automation notify 配置校验（F2）', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = initTempDb();
  });

  afterAll(() => {
    db.flush();
    cleanupTempDb(tempDir);
  });

  test('webhookUrl 必须是 http(s) 且不带 userinfo，空值合法', () => {
    const worker = workerService.createWorker({ name: '校验执行者' });
    expect(() =>
      automationService.create({
        name: '坏地址任务',
        executorId: worker.id,
        trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
        input: { goal: '目标' },
        notify: { webhookUrl: 'ftp://example.com/hook' }
      })
    ).toThrow(/http/);

    expect(() =>
      automationService.create({
        name: '带账号任务',
        executorId: worker.id,
        trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
        input: { goal: '目标' },
        notify: { webhookUrl: 'https://user:pass@example.com/hook' }
      })
    ).toThrow(/账号密码/);

    const ok = automationService.create({
      name: '无通知任务',
      executorId: worker.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '目标' }
    });
    expect(ok.notify.webhookUrl).toBe('');
  });
});

describe('webhook 出站投递（F2）', () => {
  let tempDir;
  let server;
  let port;
  /** 收到的 POST 体 */
  const received = [];

  beforeAll(async () => {
    tempDir = initTempDb();
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
    notifier.start();
  });

  afterAll(() => {
    db.flush();
    cleanupTempDb(tempDir);
    return new Promise((resolve) => server.close(resolve));
  });

  test('配置 webhookUrl 的自动化：任务终态时 POST 结构化事件并写入时间线', async () => {
    const worker = workerService.createWorker({ name: '通知执行者' });
    const automation = automationService.create({
      name: `带通知的自动化 ${Date.now()}`,
      executorId: worker.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '目标' },
      notify: { webhookUrl: `http://127.0.0.1:${port}/hook` }
    });

    const task = taskService.create({
      goal: '通知目标',
      assigneeId: worker.id,
      trigger: { type: 'schedule', refId: automation.id }
    });
    taskService.succeed(task.id, { summary: '已生成报告' });

    await waitForWebhookEvent(task.id);
    expect(received.length).toBe(1);
    expect(received[0].headers['x-virtworker-event']).toBe('task.finished');
    expect(received[0].body.event).toBe('task.finished');
    expect(received[0].body.taskId).toBe(task.id);
    expect(received[0].body.automationId).toBe(automation.id);
    expect(received[0].body.status).toBe('succeeded');
    expect(received[0].body.result.summary).toBe('已生成报告');
  });

  test('未配置 webhookUrl 的自动化不投递', async () => {
    const worker = workerService.createWorker({ name: '静默执行者' });
    const automation = automationService.create({
      name: `无通知的自动化 ${Date.now()}`,
      executorId: worker.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '目标' }
    });
    const task = taskService.create({
      goal: '静默目标',
      assigneeId: worker.id,
      trigger: { type: 'schedule', refId: automation.id }
    });
    taskService.succeed(task.id, { summary: '完成' });

    await new Promise((r) => setTimeout(r, 150));
    expect(received.length).toBe(1); // 没有新增投递
    const events = taskService.detail(task.id).task.events;
    expect(events.some((event) => event.message.includes('Webhook'))).toBe(false);
  });
});
