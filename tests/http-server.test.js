/**
 * 本地触发端点 restart 状态收敛测试（B-11.4 配套）。
 * restart 的 Promise 必须在新端口监听成功或失败后 resolve，
 * 否则调用方（settings:update 端口回滚逻辑）无法判断重启结果。
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const http = require('node:http');
const httpServer = require('../main/runtime/http-server');
const { initTempDb, cleanupTempDb, db, workerService, automationService } = await import('./setup.js');

let dir;

afterAll(() => {
  httpServer.stop();
  if (dir) cleanupTempDb(dir);
});

/** 原生 http 请求（fetch 不允许伪造 Host 头，rebinding 场景必须用原始套接字模拟） */
function request(port, { path = '/health', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 确保端点已按测试端口启动（前序用例可能已启动） */
function ensureServer() {
  const port = 20000 + (process.pid % 20000);
  if (!httpServer.getStatus().running) {
    dir = dir || initTempDb();
    db.setSettings({ apiPort: port });
    httpServer.start();
  }
  return port;
}

describe('http-server restart 状态收敛', () => {
  test('restart 后返回的 status 已反映监听结果', async () => {
    dir = initTempDb();
    // 使用随进程变化的端口，避免与其他测试/服务冲突
    const port = 20000 + (process.pid % 20000);
    db.setSettings({ apiPort: port });
    httpServer.start();

    const status = await httpServer.restart();
    expect(status.running).toBe(true);
    expect(status.port).toBe(port);
  });
});

describe('http-server Host 头校验（DNS rebinding 防护）', () => {
  test('伪造非本地 Host 的请求被 403 拒绝', async () => {
    const port = ensureServer();
    expect((await request(port, { headers: { Host: 'evil.example.com' } })).statusCode).toBe(403);
  });

  test('回环 IP 与 localhost 的 Host 不受影响', async () => {
    const port = ensureServer();
    expect((await request(port, { headers: { Host: `127.0.0.1:${port}` } })).statusCode).toBe(200);
    expect((await request(port, { headers: { Host: `localhost:${port}` } })).statusCode).toBe(200);
  });
});

describe('http-server Token 鉴权', () => {
  /** 创建一个 API 触发型自动任务，返回 { id, token }（名称限长，Worker 名 ≤20 字符；Token 从保险箱取回明文） */
  function makeApiAutomation() {
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const worker = workerService.createWorker({ name: `API执行者${stamp}`.slice(0, 20) });
    const automation = automationService.create({
      name: `API自动任务${stamp}`,
      executorId: worker.id,
      trigger: { type: 'api' },
      input: { goal: 'API 触发的任务目标' }
    });
    return { id: automation.id, token: automationService.revealApiToken(db.find('automations', automation.id)) };
  }

  test('有效 Token 触发成功并创建任务', async () => {
    const port = ensureServer();
    const { id, token } = makeApiAutomation();
    const res = await request(port, {
      path: `/automations/${id}/run`,
      method: 'POST',
      headers: { 'X-VirtWorker-Token': token, 'Content-Type': 'application/json' }
    });
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.ok).toBe(true);
    expect(payload.data.automationId).toBe(id);
    expect(String(payload.data.taskId)).toMatch(/^tk_/);
  });

  test('错误 Token 返回 401，不创建任务', async () => {
    const port = ensureServer();
    const { id } = makeApiAutomation();
    const before = db.all('tasks').length;
    const res = await request(port, {
      path: `/automations/${id}/run`,
      method: 'POST',
      headers: { 'X-VirtWorker-Token': 'vw_wrong_token' }
    });
    expect(res.statusCode).toBe(401);
    expect(db.all('tasks').length).toBe(before);
  });

  test('缺少 Token / 不存在的自动任务 / 非 API 类型一律同形 401（BUG-22 防探测）', async () => {
    const port = ensureServer();
    // 不存在的 ID：无 Token 与持他人有效 Token 都必须与「Token 错误」同形 401，不暴露存在性
    const missing = await request(port, { path: '/automations/at_none/run', method: 'POST' });
    expect(missing.statusCode).toBe(401);

    const { token } = makeApiAutomation();
    const noToken = await request(port, { path: '/automations/at_none/run', method: 'POST', headers: { 'X-VirtWorker-Token': token } });
    expect(noToken.statusCode).toBe(401);

    // 非 API 类型（无 Token 可验证）同样 401，且错误文案与 Token 错误一致（无类型信息泄漏）
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const worker = workerService.createWorker({ name: `定时执行者${stamp}`.slice(0, 20) });
    const schedule = automationService.create({
      name: `定时自动任务${stamp}`,
      executorId: worker.id,
      trigger: { type: 'schedule' }, // 缺省 daily 模式，非 API 触发
      input: { goal: '定时任务目标' }
    });
    const scheduleRes = await request(port, {
      path: `/automations/${schedule.id}/run`,
      method: 'POST',
      headers: { 'X-VirtWorker-Token': token }
    });
    expect(scheduleRes.statusCode).toBe(401);
    expect(JSON.parse(missing.body).error.message).toBe(JSON.parse(scheduleRes.body).error.message);
  });

  test('连续认证失败达阈值后进入冷却一律 429，重启端点复位（BUG-13）', async () => {
    dir = dir || initTempDb();
    await httpServer.restart(); // 复位限速状态（start 时清零），换独立端口避免污染前序用例
    const port = 20000 + (process.pid % 20000) + 2;
    db.setSettings({ apiPort: port });
    await httpServer.restart();
    try {
      const { id, token } = makeApiAutomation();
      for (let i = 0; i < 10; i += 1) {
        const res = await request(port, {
          path: `/automations/${id}/run`,
          method: 'POST',
          headers: { 'X-VirtWorker-Token': 'vw_wrong_token' }
        });
        expect(res.statusCode).toBe(401);
      }
      // 达到阈值后冷却：连不存在的自动化 ID 的枚举探测也一并 429，正确 Token 也暂被拒
      const blockedProbe = await request(port, { path: '/automations/at_none/run', method: 'POST' });
      expect(blockedProbe.statusCode).toBe(429);
      const blockedValid = await request(port, {
        path: `/automations/${id}/run`,
        method: 'POST',
        headers: { 'X-VirtWorker-Token': token, 'Content-Type': 'application/json' }
      });
      expect(blockedValid.statusCode).toBe(429);

      // 重启端点（start 复位限速）后正确 Token 恢复 200
      await httpServer.restart();
      const okRes = await request(port, {
        path: `/automations/${id}/run`,
        method: 'POST',
        headers: { 'X-VirtWorker-Token': token, 'Content-Type': 'application/json' }
      });
      expect(okRes.statusCode).toBe(200);
    } finally {
      httpServer.stop();
    }
  });
});

describe('API Token 保险箱存储与轮换（P1-15）', () => {
  test('Token 以加密对象落盘、decorate 不外泄明文、regenerateToken 可轮换', () => {
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const worker = workerService.createWorker({ name: `保险箱执行者${stamp}`.slice(0, 20) });
    const automation = automationService.create({
      name: `Token轮换任务${stamp}`,
      executorId: worker.id,
      trigger: { type: 'api' },
      input: { goal: '目标' }
    });

    // 测试环境 safeStorage 不可用 → base64 降级模式，但结构必须是加密对象而非明文字符串
    const raw = db.find('automations', automation.id);
    const stored = raw.trigger.api.token;
    expect(typeof stored).toBe('object');
    expect(stored.sealed).toBeTruthy();
    expect(stored.mode).toBe('base64');

    const oldToken = automationService.revealApiToken(raw);
    expect(oldToken).toMatch(/^vw_/);

    // 装饰输出（下发渲染层的数据）不包含明文 Token 与密文
    const decorated = JSON.stringify(automationService.detail(automation.id).automation);
    expect(decorated).not.toContain(oldToken);
    expect(decorated).not.toContain(JSON.stringify(stored.sealed.value).slice(1, -1));
    expect(automationService.detail(automation.id).automation.tokenMask).toBeTruthy();

    // 轮换：新 Token 生效、旧 Token 失效
    automationService.regenerateToken(automation.id);
    const newToken = automationService.revealApiToken(db.find('automations', automation.id));
    expect(newToken).not.toBe(oldToken);
  });

  test('非 API 型自动任务不可轮换 Token', () => {
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const worker = workerService.createWorker({ name: `定时执行者${stamp}`.slice(0, 20) });
    const automation = automationService.create({
      name: `定时任务${stamp}`,
      executorId: worker.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '目标' }
    });
    expect(() => automationService.regenerateToken(automation.id)).toThrow(/API 触发/);
  });
});

describe('http-server 启动失败可恢复（error 后句柄必须释放，start 不再 no-op）', () => {
  test('端口被占用启动失败后，释放端口再次 start 能恢复监听', async () => {
    dir = initTempDb();
    httpServer.stop();
    const port = 20000 + (process.pid % 20000) + 1;
    db.setSettings({ apiPort: port });

    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    try {
      httpServer.start();
      await vi.waitFor(
        () => {
          const status = httpServer.getStatus();
          expect(status.running).toBe(false);
          expect(status.error).toBeTruthy();
        },
        { timeout: 2000 }
      );

      // error 回调已把句柄置空：直接 start 即可按新状态重试，无需重启应用
      await new Promise((resolve) => blocker.close(resolve));
      httpServer.start();
      await vi.waitFor(() => expect(httpServer.getStatus().running).toBe(true), { timeout: 2000 });
      expect(httpServer.getStatus().port).toBe(port);
      expect(httpServer.getStatus().error).toBeNull();
    } finally {
      httpServer.stop();
    }
  });
});
