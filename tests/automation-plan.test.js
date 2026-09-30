/**
 * 自动任务计划推算测试（computeNextRun 纯函数）
 * 覆盖定时触发的核心时间推算：间隔/每天/每周/仅一次，含过期与边界。
 */

import { describe, test, expect } from 'vitest';
import { automationService } from './setup.js';

const { computeNextRun } = automationService;

describe('computeNextRun 计划推算', () => {
  test('interval：按分钟数推进', () => {
    const from = new Date('2026-09-18T10:00:00');
    const next = new Date(computeNextRun({ type: 'schedule', schedule: { mode: 'interval', everyMinutes: 30 } }, from));
    expect(next.getTime() - from.getTime()).toBe(30 * 60 * 1000);
  });

  test('daily：已过当天时间则顺延到次日', () => {
    const from = new Date('2026-09-18T22:00:00');
    const next = new Date(computeNextRun({ type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } }, from));
    expect(next.getDate()).toBe(from.getDate() + 1);
    expect(next.getHours()).toBe(9);
  });

  test('daily：未到当天时间则为当天', () => {
    const from = new Date('2026-09-18T06:00:00');
    const next = new Date(computeNextRun({ type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } }, from));
    expect(next.getDate()).toBe(from.getDate());
    expect(next.getHours()).toBe(9);
  });

  test('once：已过期返回 null（不再排程）', () => {
    const from = new Date('2026-09-18T10:00:00');
    const at = new Date('2026-09-17T10:00:00').toISOString();
    expect(computeNextRun({ type: 'schedule', schedule: { mode: 'once', at } }, from)).toBe(null);
  });

  test('once：未来时间返回该时刻', () => {
    const from = new Date('2026-09-18T10:00:00');
    const at = new Date('2026-09-20T15:30:00');
    const next = new Date(computeNextRun({ type: 'schedule', schedule: { mode: 'once', at: at.toISOString() } }, from));
    expect(next.getTime()).toBe(at.getTime());
  });

  test('非 schedule 类型返回 null', () => {
    expect(computeNextRun({ type: 'event', event: { source: 'task_succeeded' } })).toBe(null);
    expect(computeNextRun(null)).toBe(null);
  });
});
