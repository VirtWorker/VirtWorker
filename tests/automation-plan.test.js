/**
 * 自动任务计划推算测试（computeNextRun 纯函数）
 * 覆盖定时触发的核心时间推算：间隔/每天/每周/仅一次，含过期与边界。
 * 另含 API Token 只读掩码契约测试（O6）。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initTempDb, cleanupTempDb, db, workerService, automationService } from './setup.js';

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

describe('computeNextRun 错峰 jitter（OPT-8）', () => {
  const dailyTrigger = { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } };
  // 当天 09:00 已过 → 槽位为次日 09:00（本地时间，与 computeNextRun 口径一致）
  const from = new Date('2026-10-01T10:00:00');
  const slot = new Date('2026-10-02T09:00:00').getTime();
  const JITTER = 5 * 60 * 1000;

  test('不传 seed 保持精确槽位（纯函数直调兼容）', () => {
    expect(new Date(computeNextRun(dailyTrigger, from)).getTime()).toBe(slot);
  });

  test('带 seed 在 ±5 分钟内散开，且不早于基准时刻', () => {
    const next = new Date(computeNextRun(dailyTrigger, from, 'am_seed1'));
    expect(Math.abs(next.getTime() - slot)).toBeLessThanOrEqual(JITTER);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  test('同一 (seed, 槽位) 推算结果恒定；不同 seed 确实错开', () => {
    const first = computeNextRun(dailyTrigger, from, 'am_seed1');
    expect(computeNextRun(dailyTrigger, from, 'am_seed1')).toBe(first); // 重复推算不漂移

    const offsets = new Set();
    for (let i = 0; i < 20; i += 1) {
      const time = new Date(computeNextRun(dailyTrigger, from, `am_seed_${i}`)).getTime();
      offsets.add(time - slot);
    }
    expect(offsets.size).toBeGreaterThan(1); // 同刻配置的不同自动化不再同毫秒建任务
  });

  test('hourly 参与抖动且任何 seed 都不早于基准（负向抖动回退槽位）', () => {
    const hourly = { type: 'schedule', schedule: { mode: 'hourly', minute: 0 } };
    const hourSlot = new Date('2026-10-01T11:00:00').getTime();
    for (let i = 0; i < 30; i += 1) {
      const time = new Date(computeNextRun(hourly, new Date('2026-10-01T10:59:30'), `am_c${i}`)).getTime();
      expect(time).toBeGreaterThan(new Date('2026-10-01T10:59:30').getTime()); // 槽位距基准仅 30s：负向抖动必须回退
      expect(Math.abs(time - hourSlot)).toBeLessThanOrEqual(JITTER);
    }
  });

  test('interval 与 once 不参与抖动（各自锚定 / 用户指定时刻）', () => {
    const once = computeNextRun(
      { type: 'schedule', schedule: { mode: 'once', at: '2026-10-05T09:00:00Z' } },
      new Date('2026-10-01T10:00:00Z'),
      'am_once'
    );
    expect(new Date(once).toISOString()).toBe('2026-10-05T09:00:00.000Z');

    const interval = computeNextRun(
      { type: 'schedule', schedule: { mode: 'interval', everyMinutes: 30 } },
      new Date('2026-10-01T10:00:00Z'),
      'am_interval'
    );
    expect(new Date(interval).toISOString()).toBe('2026-10-01T10:30:00.000Z');
  });

  test('服务层 create 落库的 nextRunAt 带确定性抖动（接线验证）', () => {
    const worker = workerService.createWorker({ name: '抖动执行者' });
    const a = automationService.create({
      name: `抖动任务A ${Date.now()}`,
      executorId: worker.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 23, minute: 59 } },
      input: { goal: '目标A' }
    });
    const b = automationService.create({
      name: `抖动任务B ${Date.now()}`,
      executorId: worker.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 23, minute: 59 } },
      input: { goal: '目标B' }
    });

    const slot = new Date();
    slot.setHours(23, 59, 0, 0);
    if (slot.getTime() <= Date.now()) slot.setDate(slot.getDate() + 1);
    for (const item of [a, b]) {
      expect(item.enabled).toBe(true);
      expect(item.nextRunAt).toBeTruthy();
      const time = new Date(item.nextRunAt).getTime();
      expect(Math.abs(time - slot.getTime())).toBeLessThanOrEqual(JITTER);
      expect(time).toBeGreaterThan(Date.now());
    }
    // 再推算一次结果恒定（create 路径的 seed 接线正确）
    expect(automationService.advanceSchedule(a.id).nextRunAt).toBe(a.nextRunAt);
  });
});

describe('API Token 只读掩码契约（O6）：掩码回传不得静默轮换凭据', () => {
  let dir;

  beforeAll(() => {
    dir = initTempDb();
  });

  afterAll(() => {
    cleanupTempDb(dir);
  });

  beforeEach(() => {
    ['workers', 'automations'].forEach((name) => db.removeWhere(name, () => true));
  });

  function createApiAutomation(name) {
    const worker = workerService.createWorker({ name: `令牌执行者${Date.now().toString(36)}`.slice(0, 20) });
    return automationService.create({
      name,
      executorId: worker.id,
      trigger: { type: 'api' },
      input: { goal: '目标' }
    });
  }

  test('详情下发的掩码对象原样回传时等价于「保留现有 Token」', () => {
    const created = createApiAutomation(`掩码回传${Date.now().toString(36)}`);
    const storedBefore = db.find('automations', created.id).trigger.api.token;

    // 模拟「编辑→原样回传详情」的常规客户端模式（修复前这会生成新 Token 静默轮换）
    automationService.update(created.id, {
      trigger: { type: 'api', api: { token: created.trigger.api } }
    });

    const storedAfter = db.find('automations', created.id).trigger.api.token;
    expect(storedAfter).toEqual(storedBefore); // 密文不变 = Token 未被轮换
  });

  test('create/update 直接传入掩码对象被显式拒绝（不静默生成新 Token）', () => {
    const worker = workerService.createWorker({ name: `掩码拒绝${Date.now().toString(36)}`.slice(0, 20) });
    expect(() =>
      automationService.create({
        name: `掩码新建${Date.now().toString(36)}`,
        executorId: worker.id,
        trigger: { type: 'api', api: { token: { masked: true, mask: 'vw_ab***', mode: 'base64' } } },
        input: { goal: '目标' }
      })
    ).toThrow(/掩码/);
  });

  test('触发类型切离 api 时归档 Token 密文，切回时恢复而不是静默换新', () => {
    const created = createApiAutomation(`类型切换${Date.now().toString(36)}`);
    const original = db.find('automations', created.id).trigger.api.token;
    expect(created.trigger.api.masked).toBe(true); // 详情输出带只读标记
    expect(created.retiredApiToken).toBeUndefined(); // 归档密文绝不下发渲染层

    automationService.update(created.id, {
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } }
    });
    const switched = db.find('automations', created.id);
    expect(switched.trigger.type).toBe('schedule');
    expect(switched.retiredApiToken).toEqual(original); // 归档保留密文

    automationService.update(created.id, { trigger: { type: 'api' } });
    const restored = db.find('automations', created.id);
    expect(restored.trigger.type).toBe('api');
    expect(restored.trigger.api.token).toEqual(original); // 恢复旧 Token，上游调用方不受影响
    expect(restored.retiredApiToken).toBeNull();
  });
});
