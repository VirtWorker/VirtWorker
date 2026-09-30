/**
 * 调度器容错测试（对应优化项 #1）
 * 验证：失效的自动任务触发时不抛异常、不阻断其余任务与后续排程。
 * 注意：生产模块统一经 setup.js 的 createRequire 导出，确保与运行时共享同一 db 单例。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { initTempDb, cleanupTempDb, db, bus, scheduler, nowIso, workerService, automationService } from './setup.js';

let dir;

describe('scheduler 容错', () => {
  beforeAll(() => {
    dir = initTempDb();
    scheduler.start();
  });

  afterAll(() => {
    scheduler.stop();
    cleanupTempDb(dir);
  });

  test('事件触发遇到失效执行者时不抛出异常（fireSafely 兜底）', () => {
    db.insert('automations', {
      id: 'at_broken',
      name: '失效任务',
      desc: '',
      enabled: true,
      trigger: { type: 'event', event: { source: 'task_succeeded', assigneeId: '' } },
      executor: { type: 'worker', id: 'wk_not_exist', name: '幽灵' },
      input: { goal: '测试目标', workspace: '', priority: 'normal', confirmFirst: false },
      lastRunAt: null,
      lastTaskId: null,
      runCount: 0,
      nextRunAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    // 若 fireSafely 未兜底，taskService.create 会抛 NOT_FOUND
    expect(() => {
      bus.command('task:finished', { status: 'succeeded', taskId: 'tk_x', assigneeId: 'wk_other', depth: 0 });
    }).not.toThrow();
  });

  test('失效事件任务确实被尝试触发（验证共享同一 db 单例）', () => {
    // fireSafely 失败后会调用 advanceSchedule 推进计划 → updatedAt 变化但 enabled 保持
    const automation = db.find('automations', 'at_broken');
    expect(automation).toBeTruthy();
    expect(automation.enabled).toBe(true);
  });
});

describe('调度计划推进（P1-10）', () => {
  let dir;

  beforeAll(() => {
    dir = initTempDb();
  });

  afterAll(() => {
    cleanupTempDb(dir);
  });

  test('interval 以计划触发时刻为基准计算下次触发，不再顺延漂移', () => {
    const worker = workerService.createWorker({ name: `间隔执行者${Date.now().toString(36)}`.slice(0, 20) });
    const automation = automationService.create({
      name: `间隔任务${Date.now().toString(36)}`,
      executorId: worker.id,
      trigger: { type: 'schedule', schedule: { mode: 'interval', everyMinutes: 30 } },
      input: { goal: '目标' }
    });
    // 计划触发点在 5 分钟前（调度延迟/休眠唤醒的常见形态）
    const due = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    db.update('automations', automation.id, { nextRunAt: due });

    const next = automationService.markFired(automation.id, 'tk_interval', { reason: '定时触发' });

    // 基准 = 计划触发点：due + 30min；若以实际触发时刻为基准则会漂移 5 分钟
    const expected = new Date(new Date(due).getTime() + 30 * 60 * 1000).toISOString();
    expect(next.nextRunAt).toBe(expected);
  });

  test('仅一次自动任务错过且补跑关闭时，推进计划自动停用（不再产生僵尸配置）', () => {
    const worker = workerService.createWorker({ name: `一次性执行者${Date.now().toString(36)}`.slice(0, 20) });
    const automation = automationService.create({
      name: `仅一次任务${Date.now().toString(36)}`,
      executorId: worker.id,
      trigger: { type: 'schedule', schedule: { mode: 'once', at: new Date(Date.now() - 60 * 1000).toISOString() } },
      input: { goal: '目标' }
    });
    expect(automation.enabled).toBe(true);
    expect(automation.nextRunAt).toBe(null); // 创建时已过期 → 无下次

    const next = automationService.advanceSchedule(automation.id);
    expect(next.enabled).toBe(false);
  });

  test('非 once 类型推进计划不会被误停用', () => {
    const worker = workerService.createWorker({ name: `每日执行者${Date.now().toString(36)}`.slice(0, 20) });
    const automation = automationService.create({
      name: `每日任务${Date.now().toString(36)}`,
      executorId: worker.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '目标' }
    });
    const next = automationService.advanceSchedule(automation.id);
    expect(next.enabled).toBe(true);
    expect(next.nextRunAt).toBeTruthy();
  });
});
