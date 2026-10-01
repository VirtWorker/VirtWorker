/**
 * 事件总线测试（O17）：按类型订阅与全局订阅并存、退订、错误隔离、async 指令兜底。
 */

import { describe, test, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bus = require('../main/runtime/event-bus');

describe('bus.on 按类型订阅（O17）', () => {
  test('按类型订阅只收到匹配事件，且直接拿到 payload', () => {
    const seen = [];
    const off = bus.on('task:updated', (payload) => seen.push(payload));
    bus.on('task:created', (payload) => seen.push(`created:${payload.id}`));

    bus.emit('task:updated', { id: 'tk_1' });
    bus.emit('task:created', { id: 'tk_2' });
    bus.emit('worker:removed', { id: 'wk_1' }); // 未订阅的类型不触达

    expect(seen).toEqual([{ id: 'tk_1' }, 'created:tk_2']);

    off();
    bus.emit('task:updated', { id: 'tk_3' });
    expect(seen).toEqual([{ id: 'tk_1' }, 'created:tk_2']);
  });

  test('全局订阅 on(fn) 保持兼容：收到 { type, payload }，与类型订阅并存', () => {
    const globalSeen = [];
    const typedSeen = [];
    const offGlobal = bus.on((event) => globalSeen.push(event));
    const offTyped = bus.on('app:notice', (payload) => typedSeen.push(payload));

    bus.emit('app:notice', { title: 'hi' });

    expect(globalSeen).toEqual([{ type: 'app:notice', payload: { title: 'hi' } }]);
    expect(typedSeen).toEqual([{ title: 'hi' }]);

    offGlobal();
    offTyped();
    bus.emit('app:notice', { title: 'second' });
    expect(globalSeen.length).toBe(1);
    expect(typedSeen.length).toBe(1);
  });

  test('监听器抛错被隔离，不影响同一事件的其他监听器', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = [];
    bus.on('boom', () => {
      throw new Error('监听器炸了');
    });
    const off = bus.on('boom', (payload) => seen.push(payload));

    expect(() => bus.emit('boom', { ok: true })).not.toThrow();
    expect(seen).toEqual([{ ok: true }]);
    expect(errSpy).toHaveBeenCalled();

    off();
    errSpy.mockRestore();
  });
});

describe('bus.command async 处理器（O2 配套）', () => {
  test('async 指令处理器的拒绝被捕获落日志，不产生 unhandledRejection', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const off = bus.onCommand('cmd:async-boom', async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('异步指令失败');
    });

    expect(() => bus.command('cmd:async-boom', {})).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(errSpy).toHaveBeenCalledWith('[bus] 指令处理失败:', 'cmd:async-boom', expect.any(Error));

    off();
    errSpy.mockRestore();
  });
});
