/**
 * 任务归档策略测试（BUG-20 写放大治理 + BUG-27 终态退出通道）
 * 归档收「已定格终态超 30 天」的任务：succeeded 要求已查收（未查收不退出），
 * failed/canceled 无查收语义、按 finishedAt 计龄。验证归档迁移、合并读取（getTask/list/stats/detail）、
 * 归档任务的 ack 幂等与变更守卫、purgeExpired/purgePreview/purgeOrphanEvents 对归档集合的覆盖。
 * 时间由 resultAckedAt/finishedAt 直写控制（与 task-input.test.js 同款 db.update 手法）。
 */

import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import { initTempDb, cleanupTempDb, db, workerService, taskService } from './setup.js';

const dir = initTempDb();
afterAll(() => cleanupTempDb(dir));

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

let worker;

beforeEach(() => {
  ['workers', 'tasks', 'tasks-archive', 'taskevents'].forEach((name) => db.removeWhere(name, () => true));
  worker = workerService.createWorker({ name: '归档执行者' });
});

/** 直写任务状态与查收时间（绕过运行时）。ackedDaysAgo 传数字表示查收发生在 N 天前，
 *  同时把 createdAt 置为查收前 2 天——真实时间线里 createdAt ≤ resultAckedAt，
 *  且 list/stats 按 createdAt 过滤，必须一致置旧才能模拟「真实的旧任务」。 */
function makeTask(title, { status = 'succeeded', ackedDaysAgo = null } = {}) {
  const task = taskService.create({ goal: title, assigneeId: worker.id });
  const patch = { status };
  if (ackedDaysAgo !== null) {
    patch.createdAt = daysAgo(ackedDaysAgo + 2);
    patch.finishedAt = daysAgo(ackedDaysAgo);
    patch.resultAckedAt = daysAgo(ackedDaysAgo);
  }
  db.update('tasks', task.id, patch);
  return task;
}

describe('archiveAged 归档迁移', () => {
  test('归档已查收超 30 天的 succeeded 与超 30 天的 failed/canceled，其余留在活跃集合', () => {
    const oldAcked = makeTask('老任务', { ackedDaysAgo: 40 });
    const recentAcked = makeTask('新任务', { ackedDaysAgo: 10 });
    const failed = makeTask('失败任务', { status: 'failed', ackedDaysAgo: 40 });
    const unacked = makeTask('未查收任务', { ackedDaysAgo: null });

    const { archived, threshold } = taskService.archiveAged();
    expect(threshold).toBe(taskService.ARCHIVE_AFTER_DAYS);
    expect(archived).toBe(2); // BUG-27：failed 无查收语义，按 finishedAt 走同一归档通道

    const activeIds = db.all('tasks').map((task) => task.id);
    const archiveIds = db.all('tasks-archive').map((task) => task.id);
    expect(archiveIds).toEqual([oldAcked.id, failed.id]);
    expect(activeIds).toContain(recentAcked.id);
    expect(activeIds).toContain(unacked.id); // 未查收结果用户还没看，不归档
  });

  test('归档幂等：重复执行不再迁移', () => {
    makeTask('只会归档一次', { ackedDaysAgo: 60 });
    expect(taskService.archiveAged().archived).toBe(1);
    expect(taskService.archiveAged().archived).toBe(0);
  });

  test('BUG-26 先入后出：活跃与归档短暂双份（崩溃残留）时幂等去重，不产生重复归档', () => {
    const task = makeTask('双份残留任务', { ackedDaysAgo: 40 });
    // 模拟「insert 归档已落盘、remove 活跃未落盘」崩溃窗口的残留状态
    db.insert('tasks-archive', db.find('tasks', task.id));

    const result = taskService.archiveAged();
    expect(result.archived).toBe(1);
    const archiveIds = db.all('tasks-archive').map((item) => item.id);
    expect(archiveIds.filter((id) => id === task.id).length).toBe(1); // 恰好一份
    expect(db.find('tasks', task.id)).toBeNull(); // 活跃集合已清除
  });

  test('归档后任务仍可通过 getTask/detail 读取，时间线完整', () => {
    const task = makeTask('归档后可读', { ackedDaysAgo: 45 });
    taskService.archiveAged();

    expect(taskService.getTask(task.id)?.id).toBe(task.id); // 活跃未命中 → 归档命中
    const detail = taskService.detail(task.id);
    expect(detail.task.id).toBe(task.id);
    expect(detail.task.events.length).toBeGreaterThan(0); // 时间线仍在 taskevents
    expect(detail.task.events.every((event) => event.taskId === task.id)).toBe(true);
  });
});

describe('归档合并读取', () => {
  test('list：全部历史口径包含归档任务，近期周期不包含', () => {
    const oldAcked = makeTask('归档列表任务', { ackedDaysAgo: 40 });
    taskService.archiveAged();

    const all = taskService.list({ period: '' });
    expect(all.items.map((task) => task.id)).toContain(oldAcked.id);

    const recent = taskService.list({ period: 'week' });
    expect(recent.items.map((task) => task.id)).not.toContain(oldAcked.id);
  });

  test('list 归档合并后不产生重复（任务只存在于一个集合）', () => {
    makeTask('无重复任务', { ackedDaysAgo: 40 });
    taskService.archiveAged();
    const all = taskService.list({ period: '' });
    const ids = all.items.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('stats：quarter 窗口统计含归档任务，week 窗口不含', () => {
    makeTask('归档统计任务', { ackedDaysAgo: 40 });
    taskService.archiveAged();

    expect(taskService.stats('quarter').total).toBe(1);
    expect(taskService.stats('quarter').finished).toBe(1);
    expect(taskService.stats('week').total).toBe(0);
  });

  test('归档任务的 ack 幂等早返回，不抛错不落写', () => {
    const task = makeTask('归档后查收', { ackedDaysAgo: 35 });
    taskService.archiveAged();
    expect(taskService.ack(task.id).id).toBe(task.id); // 已查收 → 幂等返回
  });

  test('归档任务拒绝状态变更（mutate 终态守卫仍然生效）', async () => {
    const task = makeTask('归档后取消', { ackedDaysAgo: 35 });
    taskService.archiveAged();
    expect(() => taskService.cancel(task.id, '试试')).toThrow(/已结束/);
    // 归档集合未被误写
    expect(db.all('tasks-archive').find((item) => item.id === task.id)?.status).toBe('succeeded');
  });
});

describe('归档集合的清理路径', () => {
  test('purgeExpired 同时清理活跃与归档集合中超出保留期的任务（含时间线）', () => {
    const oldFailed = makeTask('活跃过期', { status: 'failed', ackedDaysAgo: 100 }); // BUG-27：failed 也归档
    const oldArchived = makeTask('归档过期', { ackedDaysAgo: 100 });
    const keep = makeTask('保留期内', { ackedDaysAgo: 10 });
    taskService.archiveAged(); // oldArchived 与 oldFailed 均进归档
    const { removed } = taskService.purgeExpired(90);
    expect(removed).toBe(2);

    const activeIds = db.all('tasks').map((task) => task.id);
    const archiveIds = db.all('tasks-archive').map((task) => task.id);
    expect(activeIds).not.toContain(oldFailed.id);
    expect(archiveIds).not.toContain(oldArchived.id);
    expect(archiveIds).not.toContain(oldFailed.id);
    expect(activeIds).toContain(keep.id);
    // 时间线连带清理：过期任务的事件不存在，保留任务的事件仍在
    expect(db.where('taskevents', { taskId: oldArchived.id })).toEqual([]);
    expect(db.where('taskevents', { taskId: keep.id }).length).toBeGreaterThan(0);
  });

  test('purgePreview 合并活跃与归档口径', () => {
    makeTask('预览任务A', { ackedDaysAgo: 100 });
    makeTask('预览任务B', { ackedDaysAgo: 100 });
    taskService.archiveAged(); // 两条全部归档
    const preview = taskService.purgePreview(90);
    expect(preview.removable).toBe(2);
  });

  test('purgeOrphanEvents 保留归档任务的时间线，只清扫真孤儿', () => {
    const task = makeTask('归档时间线保留', { ackedDaysAgo: 40 });
    taskService.archiveAged();
    // 构造孤儿事件：taskId 指向不存在的任务
    db.append('taskevents', { id: 'ev_orphan', taskId: 'tk_ghost', type: 'log', message: '孤儿', at: daysAgo(1) });

    const removed = taskService.purgeOrphanEvents();
    expect(removed).toBe(1);
    expect(db.where('taskevents', { taskId: task.id }).length).toBeGreaterThan(0); // 归档任务时间线完好
    expect(db.where('taskevents', { taskId: 'tk_ghost' })).toEqual([]);
  });
});

describe('归档不影响重试路径', () => {
  test('BUG-27 失败任务按 finishedAt 归档，重试链路照常（含归档集合写回）', () => {
    const failed = makeTask('可重试任务', { status: 'failed', ackedDaysAgo: 40 });
    taskService.archiveAged();

    expect(db.all('tasks-archive').map((task) => task.id)).toContain(failed.id); // 失败任务已归档
    // retry 经 getTask 合并读取归档任务；补记「已发起重试」时间线的 mutate
    // 必须写回归档集合（mutate 集合定位修复），不再抛「记录不存在」
    const retried = taskService.retry(failed.id);
    expect(retried.retryOf).toBe(failed.id);
    expect(retried.status).toBe('queued');
    expect(db.find('tasks-archive', failed.id)).not.toBeNull();
  });
});
