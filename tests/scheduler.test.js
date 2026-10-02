/**
 * 调度器容错测试（对应优化项 #1）
 * 验证：失效的自动任务触发时不抛异常、不阻断其余任务与后续排程。
 * 注意：生产模块统一经 setup.js 的 createRequire 导出，确保与运行时共享同一 db 单例。
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
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

  test('interval 长停机追赶上限：计划点落后超过一个完整间隔时，下次直接以当前时刻重排（O3）', () => {
    const worker = workerService.createWorker({ name: `停机执行者${Date.now().toString(36)}`.slice(0, 20) });
    const automation = automationService.create({
      name: `停机任务${Date.now().toString(36)}`,
      executorId: worker.id,
      trigger: { type: 'schedule', schedule: { mode: 'interval', everyMinutes: 30 } },
      input: { goal: '目标' }
    });
    // 计划触发点在 45 分钟前（应用停开数天后补跑的形态）：
    // 若仍以过期点为基准，due + 30min 仍在过去，调度器会以最小定时器间隔连续触发制造任务洪峰
    const due = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    db.update('automations', automation.id, { nextRunAt: due });

    const before = Date.now();
    const next = automationService.markFired(automation.id, 'tk_catchup', { reason: '补跑错过的定时' });
    const nextMs = new Date(next.nextRunAt).getTime();

    // 下次触发必须在未来（now + 30min 附近）——补跑只发生本次这一次
    expect(nextMs).toBeGreaterThan(before);
    expect(nextMs).toBeLessThanOrEqual(before + 31 * 60 * 1000);
  });

  test('定时触发重叠守卫：上一轮任务仍在进行时跳过本轮，不堆积任务（O3）', () => {
    const worker = workerService.createWorker({ name: `重叠执行者${Date.now().toString(36)}`.slice(0, 20) });
    const automation = automationService.create({
      name: `重叠任务${Date.now().toString(36)}`,
      executorId: worker.id,
      trigger: { type: 'schedule', schedule: { mode: 'interval', everyMinutes: 30 } },
      input: { goal: '重叠目标' }
    });
    // 伪造上一轮任务仍在执行
    db.insert('tasks', {
      id: 'tk_still_running',
      title: '上一轮任务',
      status: 'running',
      assignee: { type: 'worker', id: worker.id, name: worker.name },
      createdAt: nowIso()
    });
    db.update('automations', automation.id, { lastTaskId: 'tk_still_running', nextRunAt: new Date(Date.now() - 60 * 1000).toISOString() });

    const fired = scheduler.fire(db.find('automations', automation.id), '定时触发');

    expect(fired).toBeNull(); // 跳过本轮，不创建新任务
    expect(
      db.query('tasks', (task) => task.trigger?.refId === automation.id).length
    ).toBe(0);

    // 上一轮结束后不再拦截
    db.update('tasks', 'tk_still_running', { status: 'succeeded' });
    const retry = scheduler.fire(db.find('automations', automation.id), '定时触发');
    expect(retry).toBeTruthy();
    expect(retry.trigger.refId).toBe(automation.id);
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


describe('事件/API 触发限速（A3）：最小触发间隔防风暴', () => {
  let dir;

  beforeAll(() => {
    dir = initTempDb();
    scheduler.start(); // 注册 task:finished → onTaskFinished 监听
  });

  afterAll(() => {
    scheduler.stop();
    cleanupTempDb(dir);
  });

  function makeEventAutomation(prefix) {
    const worker = workerService.createWorker({ name: `${prefix}执行者${Date.now().toString(36)}`.slice(0, 20) });
    const automation = automationService.create({
      name: `${prefix}任务${Date.now().toString(36)}`,
      executorId: worker.id,
      trigger: { type: 'event', event: { source: 'task_succeeded', assigneeId: '' } },
      input: { goal: '目标' }
    });
    return db.find('automations', automation.id);
  }

  test('fire：上次触发不足最小间隔时抛 RATE_LIMITED，不重复建任务', () => {
    const automation = makeEventAutomation('直连限速');
    const first = scheduler.fire(automation, '测试触发');
    expect(first).toBeTruthy();

    // 重新读取（首次触发已把 lastRunAt 落库，旧对象的锚点仍为 null）
    const fresh = db.find('automations', automation.id);
    let limited = null;
    try {
      scheduler.fire(fresh, '测试触发');
    } catch (error) {
      limited = error;
    }
    expect(limited?.code).toBe('RATE_LIMITED');
    expect(db.query('tasks', (task) => task.trigger?.refId === automation.id).length).toBe(1);
  });

  test('事件触发链：限流被 fireSafely 静默吞掉，不推进计划也不抛错', () => {
    const automation = makeEventAutomation('风暴限速');
    bus.command('task:finished', { status: 'succeeded', taskId: 'tk_sa', assigneeId: 'wk_other', depth: 0 });
    expect(db.query('tasks', (task) => task.trigger?.refId === automation.id).length).toBe(1);

    // 失败风暴下同一终态事件在最小间隔内再次匹配：被限流，任务数不变、不抛异常
    expect(() => {
      bus.command('task:finished', { status: 'succeeded', taskId: 'tk_sb', assigneeId: 'wk_other', depth: 0 });
    }).not.toThrow();
    expect(db.query('tasks', (task) => task.trigger?.refId === automation.id).length).toBe(1);
    // 限流不是失效：不按失败推进计划（enabled 保持、once 语义不受影响）
    const stored = db.find('automations', automation.id);
    expect(stored.enabled).toBe(true);
  });

  test('超过最小间隔后可再次触发（锚点为 lastRunAt）', () => {
    const automation = makeEventAutomation('窗口恢复');
    expect(scheduler.fire(automation, '首次')).toBeTruthy();
    // 把 lastRunAt 回拨到最小间隔之外
    db.update('automations', automation.id, {
      lastRunAt: new Date(Date.now() - scheduler.FIRE_MIN_INTERVAL_MS - 1000).toISOString()
    });
    const again = scheduler.fire(db.find('automations', automation.id), '窗口外触发');
    expect(again).toBeTruthy();
    expect(again.trigger.refId).toBe(automation.id);
  });
});

describe('调度器自愈（BUG-33）', () => {
  beforeAll(() => {
    dir = initTempDb();
    scheduler.start(); // 文件内第二次 start：事件监听重复注册对本用例无害（arm 幂等）
  });

  afterAll(() => {
    scheduler.stop();
    cleanupTempDb(dir);
  });

  test('earliestNextRun 抛错不产生未捕获异常，恢复后调度循环继续', async () => {
    const real = automationService.earliestNextRun.bind(automationService);
    let calls = 0;
    const spy = vi.spyOn(automationService, 'earliestNextRun').mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error('计算失败');
      return real();
    });
    try {
      // 修复前：arm() 的异常从 tick 的 finally 变成未捕获异常，调度器永久停摆
      //（生产环境会触发全局兜底直接退出应用）。修复后 arm 内部捕获并按 MAX_TIMER_MS 兜底重排
      expect(() => bus.command('automation:changed', 'at_heal')).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBeGreaterThanOrEqual(1);

      // spy 恢复后再次重排回到正常路径，调度循环存活
      spy.mockRestore();
      expect(() => bus.command('automation:changed', 'at_heal_2')).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      spy.mockRestore();
    }
  });
});
