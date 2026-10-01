/**
 * IPC 契约测试：统一响应包 + capability:create-knowledge 透传。
 *
 * 背景（P0 回归防护）：该 handler 曾只透传 { dir, ticket }，丢弃渲染层
 * payload 中的 name/desc，导致创建知识库必然抛"请填写知识库名称"。
 *
 * 加载方式：main/ipc/index.js 顶层依赖 electron（测试环境不可用），
 * 先向 require.cache 注入 electron stub，再经 createRequire 加载，
 * 确保与生产模块命中同一份 require.cache 单例（见 tests/setup.js 说明）。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// —— electron stub：必须在 require 生产 ipc 模块之前注入 require.cache ——
const handlers = new Map();
const electronStub = {
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  clipboard: { writeText: () => {} },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true })
  },
  shell: { openPath: async () => 'stub' },
  app: { getPath: () => os.tmpdir(), relaunch: () => {}, exit: () => {}, quit: () => {} }
};
const electronResolved = require.resolve('electron');
const stubModule = new Module(electronResolved, null);
stubModule.filename = electronResolved;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[electronResolved] = stubModule;

const ipc = require('../main/ipc/index');
const dirGrant = require('../main/runtime/dir-grant');
const db = require('../main/store/db');
const { initTempDb, cleanupTempDb } = await import('./setup.js');

/** 模拟渲染层 invoke：直接调用注册到 ipcMain 的 handler */
function invoke(channel, payload) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`通道未注册: ${channel}`);
  return handler({}, payload);
}

/** 创建一个包含可索引文本文件的临时目录 */
function makeDocsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-docs-'));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'VirtWorker 知识库内容测试');
  return dir;
}

describe('IPC 契约：统一响应包', () => {
  beforeAll(() => {
    initTempDb();
    ipc.register();
  });

  afterAll(() => {
    db.flush();
  });

  test('业务异常返回 ok:false + 业务错误码', async () => {
    const res = await invoke('flow:detail', { id: 'fw_not_exist' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('NOT_FOUND');
    expect(res.apiVersion).toBe(1);
  });

  test('未预期异常返回 INTERNAL 且不泄露内部错误信息', async () => {
    const res = await invoke('task:detail', null);
    // payload 为 null 时 handler 解构抛 TypeError，应被统一包装为 INTERNAL
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('INTERNAL');
    expect(res.error.message).toBe('系统内部错误，请重试');
    expect(res.error.details).toBeNull();
  });
});

describe('IPC 契约：@Worker 通道', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = initTempDb();
    ipc.register();
  });

  afterAll(() => {
    db.flush();
    cleanupTempDb(tempDir);
  });

  test('chat:platforms 返回平台目录且 mock 可用', async () => {
    const res = await invoke('chat:platforms');
    expect(res.ok).toBe(true);
    const mock = res.data.find((item) => item.key === 'mock');
    expect(mock.available).toBe(true);
  });

  test('chat:connection-create → chat:simulate-inbound 全链路响应包正确', async () => {
    const created = await invoke('chat:connection-create', { platform: 'mock', name: '契约测试连接' });
    expect(created.ok).toBe(true);
    expect(created.data.status).toBe('connected');

    const inbound = await invoke('chat:simulate-inbound', {
      connectionId: created.data.id,
      chatId: 'chat-contract',
      chatName: '契约测试群',
      chatType: 'group',
      sender: '王工',
      text: '@Worker 任意内容'
    });
    expect(inbound.ok).toBe(true);
    // 无 Worker 时无法建绑定，消息必然分流为接入申请
    expect(inbound.data.kind).toBe('request_created');
  });

  test('bootstrap 包含 @Worker 数据切片', async () => {
    const res = await invoke('app:bootstrap');
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data.chatConnections)).toBe(true);
    expect(Array.isArray(res.data.chatBindings)).toBe(true);
    expect(res.data.chatStats).toHaveProperty('pendingRequests');
  });

  test('chat:simulate-inbound 连接不存在返回 NOT_FOUND', async () => {
    const res = await invoke('chat:simulate-inbound', { connectionId: 'imc_missing', chatId: 'c', text: 'hi' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('NOT_FOUND');
  });
});

describe('IPC 契约：capability:create-knowledge 完整透传 payload', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = initTempDb();
    ipc.register();
  });

  afterAll(() => {
    db.flush();
    cleanupTempDb(tempDir);
  });

  test('name/desc/dir 透传成功，知识库创建并落库', async () => {
    const docsDir = makeDocsDir();
    const ticket = dirGrant.grant(docsDir);
    const res = await invoke('capability:create-knowledge', {
      name: '产品文档',
      desc: '内部使用文档',
      dir: docsDir,
      ticket
    });
    expect(res.ok).toBe(true);
    expect(res.data.name).toBe('产品文档');
    expect(res.data.desc).toBe('内部使用文档');

    const stored = db.find('capabilities', res.data.id);
    expect(stored).not.toBeNull();
    expect(stored.title).toBe('产品文档');
    // 索引已产出 chunks，证明 indexDirectory 收到的是授权目录
    const chunks = db.all('chunks').filter((c) => c.capabilityId === res.data.id);
    expect(chunks.length).toBeGreaterThan(0);
  });

  test('缺少 name 时服务层校验生效（透传后校验不被绕过）', async () => {
    const docsDir = makeDocsDir();
    const ticket = dirGrant.grant(docsDir);
    const res = await invoke('capability:create-knowledge', { dir: docsDir, ticket });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('VALIDATION_FAILED');
    expect(res.error.message).toContain('名称');
  });

  test('ticket 未授权时拒绝，目录不会落库', async () => {
    const before = db.all('capabilities').length;
    const res = await invoke('capability:create-knowledge', {
      name: '未授权',
      dir: 'C:\\not-granted',
      ticket: 'forged-ticket'
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('VALIDATION_FAILED');
    expect(db.all('capabilities').length).toBe(before);
  });

  test('ticket 一次性消费：重放同一 ticket 被拒绝', async () => {
    const docsDir = makeDocsDir();
    const ticket = dirGrant.grant(docsDir);
    const first = await invoke('capability:create-knowledge', {
      name: '第一次',
      dir: docsDir,
      ticket
    });
    expect(first.ok).toBe(true);

    const replay = await invoke('capability:create-knowledge', {
      name: '重放',
      dir: docsDir,
      ticket
    });
    expect(replay.ok).toBe(false);
    expect(replay.error.message).toContain('目录未授权');
  });
});

describe('IPC 契约：app:relaunch 走完整退出流程（O1 回归防护）', () => {
  beforeAll(() => {
    initTempDb();
    ipc.register();
  });

  afterAll(() => {
    db.flush();
  });

  test('app:relaunch 登记重启请求并调用 app.quit，绝不直接 app.exit 跳过 before-quit', async () => {
    const calls = { quit: 0, exit: 0, relaunch: 0 };
    electronStub.app.quit = () => {
      calls.quit += 1;
    };
    electronStub.app.exit = () => {
      calls.exit += 1;
    };
    electronStub.app.relaunch = () => {
      calls.relaunch += 1;
    };

    const res = await invoke('app:relaunch');
    expect(res.ok).toBe(true);
    expect(calls.quit).toBe(1);
    // 关键断言：app.exit(0) 会跳过 before-quit（db.flush 等清理全部不执行），必须杜绝
    expect(calls.exit).toBe(0);
    // main.js 的 before-quit 消费该标志后登记 app.relaunch()
    expect(ipc.consumeRelaunchRequest()).toBe(true);
    expect(ipc.consumeRelaunchRequest()).toBe(false); // 消费一次即复位
  });

  test('app:restore-backup 恢复后登记重启（恢复会话不落盘 + 重启加载新数据）', async () => {
    const calls = { quit: 0 };
    electronStub.app.quit = () => {
      calls.quit += 1;
    };
    const res = await invoke('app:restore-backup', { name: '20990101-000000' });
    expect(res.ok).toBe(false); // 不存在的快照被拒绝
    expect(res.error.code).toBe('NOT_FOUND');
    expect(calls.quit).toBe(0); // 失败时不应触发重启
  });
});

describe('IPC 契约：task 事件转发合并节流（O17 回归防护）', () => {
  beforeAll(() => {
    initTempDb();
    ipc.register();
  });

  afterAll(() => {
    db.flush();
  });

  test('100ms 窗口内同一任务的多次 task:updated 只下发最后一条，其余事件立即转发', async () => {
    const bus = require('../main/runtime/event-bus');
    const sent = [];
    const fakeWin = { isDestroyed: () => false, webContents: { send: (_channel, event) => sent.push(event) } };
    const original = electronStub.BrowserWindow.getAllWindows;
    electronStub.BrowserWindow.getAllWindows = () => [fakeWin];

    try {
      bus.emit('task:updated', { id: 'tk_coalesce', title: 'v1' });
      bus.emit('task:updated', { id: 'tk_coalesce', title: 'v2' });
      bus.emit('task:created', { id: 'tk_other', title: 'other' });
      bus.emit('app:notice', { title: '立即送达' });

      // 窗口期内：非 task 事件已立即转发，task 事件仍在缓冲
      expect(sent.map((event) => event.type)).toEqual(['app:notice']);

      await new Promise((r) => setTimeout(r, 150));
      expect(sent.map((event) => event.type)).toEqual(['app:notice', 'task:updated', 'task:created']);
      expect(sent[1].payload.title).toBe('v2'); // 同任务只保留最后一条
      expect(sent[2].payload.id).toBe('tk_other');
      expect(sent[2].type).toBe('task:created'); // created 在窗口内未被 updated 覆盖（不同任务）

      // 删除事件立即下发，并丢弃窗口内该任务的待发更新
      bus.emit('task:updated', { id: 'tk_x', title: 'pending' });
      bus.emit('task:removed', { id: 'tk_x' });
      expect(sent[sent.length - 1].type).toBe('task:removed');
      await new Promise((r) => setTimeout(r, 150));
      expect(sent.filter((event) => event.payload?.id === 'tk_x').length).toBe(1);
    } finally {
      electronStub.BrowserWindow.getAllWindows = original;
    }
  });
});

describe('IPC 契约：preload 白名单与主进程注册互为镜像（防三层管道脱节）', () => {
  /** 从 preload.js 源码收集全部 invoke 通道（含 app:ping 直连），确保白名单唯一事实被双向校验 */
  function scanPreloadChannels() {
    const source = fs.readFileSync(fileURLToPath(new URL('../preload/preload.js', import.meta.url)), 'utf8');
    return new Set([...source.matchAll(/invoke\('([a-zA-Z0-9:_-]+)'/g)].map((match) => match[1]));
  }

  test('preload 暴露的每个通道都已在主进程注册（防白名单漂移出未注册通道）', () => {
    const preloadChannels = scanPreloadChannels();
    // app:ping 在 main.js 顶层注册（不经 ipc.register），测试环境未加载 main.js，单独放行
    const missing = [...preloadChannels].filter((channel) => !handlers.has(channel) && channel !== 'app:ping');
    expect(missing).toEqual([]);
  });

  test('主进程注册的业务通道均有 preload 入口（防"通道已通、UI 不可达"）', () => {
    const preloadChannels = scanPreloadChannels();
    const mainChannels = new Set([...handlers.keys(), 'app:ping']);
    const orphans = [...mainChannels].filter((channel) => !preloadChannels.has(channel));
    expect(orphans).toEqual([]);
  });
});
