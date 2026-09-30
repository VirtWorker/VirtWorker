/**
 * 任务创建入参收敛测试（对应优化项 #14）
 * 验证：payload 深度/规模限制、tags 字符串化去重、workspace 截断。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initTempDb, cleanupTempDb, db, workerService, taskService } from './setup.js';

let dir;

beforeAll(() => {
  dir = initTempDb();
});

afterAll(() => {
  cleanupTempDb(dir);
});

describe('taskService.create 入参收敛', () => {
  let worker;

  beforeEach(() => {
    ['workers', 'tasks'].forEach((name) => db.removeWhere(name, () => true));
    worker = workerService.createWorker({ name: '测试者' });
  });

  test('payload 超深嵌套被裁剪', () => {
    const deep = { a: { b: { c: { d: { e: 'too-deep' } } } } };
    const task = taskService.create({ goal: '深结构', assigneeId: worker.id, payload: deep });
    const stored = db.find('tasks', task.id);
    // 深度限制：a.b.c 保留到第 3 层，其下的 d 被整体丢弃
    expect(stored.input.payload.a.b.c).toEqual({});
  });

  test('payload 中的函数/符号被丢弃', () => {
    const task = taskService.create({
      goal: '含函数',
      assigneeId: worker.id,
      payload: { keep: 'ok', fn: () => {}, sym: Symbol('x') }
    });
    const stored = db.find('tasks', task.id);
    expect(stored.input.payload.keep).toBe('ok');
    expect('fn' in stored.input.payload).toBe(false);
    expect('sym' in stored.input.payload).toBe(false);
  });

  test('payload 超长字符串被截断', () => {
    const long = 'x'.repeat(5000);
    const task = taskService.create({ goal: '超长', assigneeId: worker.id, payload: { text: long } });
    const stored = db.find('tasks', task.id);
    expect(stored.input.payload.text.length).toBeLessThanOrEqual(2000);
  });

  test('tags 字符串化、去重、去空、限长', () => {
    const task = taskService.create({
      goal: '标签',
      assigneeId: worker.id,
      tags: ['a', 'a', '', 123, 'd'.repeat(50)]
    });
    const stored = db.find('tasks', task.id);
    expect(stored.tags).toEqual(['a', '123', 'd'.repeat(20)]);
  });

  test('非对象 payload 归一为空对象', () => {
    const task = taskService.create({ goal: '标量', assigneeId: worker.id, payload: 'not-an-object' });
    const stored = db.find('tasks', task.id);
    expect(stored.input.payload).toEqual({});
  });

  test('trigger.depth 钳制到非负区间（负值会使事件触发链上限失效）', () => {
    const negative = taskService.create({
      goal: '负深度',
      assigneeId: worker.id,
      trigger: { type: 'event', depth: -100 }
    });
    expect(db.find('tasks', negative.id).trigger.depth).toBe(0);

    const huge = taskService.create({
      goal: '超深',
      assigneeId: worker.id,
      trigger: { type: 'event', depth: 999999 }
    });
    expect(db.find('tasks', huge.id).trigger.depth).toBe(3); // 与 scheduler 的 MAX_CHAIN_DEPTH 统一口径
  });
});

describe('taskService.queue 与列表分页（P3-21）', () => {
  let worker;

  beforeEach(() => {
    ['workers', 'tasks', 'taskevents'].forEach((name) => db.removeWhere(name, () => true));
    worker = workerService.createWorker({ name: '队列测试者' });
  });

  test('queue 返回需要操作与待查收结果两队，主进程一次算完', () => {
    const queuedTask = taskService.create({ goal: '排队任务', assigneeId: worker.id });
    const doneTask = taskService.create({ goal: '完成任务', assigneeId: worker.id });
    taskService.markRunning(doneTask.id, [{ step: 1, title: 's', status: 'pending', startedAt: null, finishedAt: null, log: '', citations: [] }], '');
    taskService.succeed(doneTask.id, { summary: '完成', text: '', artifacts: [], capabilities: {} });

    const actionTask = taskService.create({ goal: '待操作任务', assigneeId: worker.id });
    taskService.markRunning(actionTask.id, [{ step: 1, title: 's', status: 'pending', startedAt: null, finishedAt: null, log: '', citations: [] }], '');
    taskService.requestAction(actionTask.id, {
      type: 'confirm',
      title: '确认？',
      options: [{ value: 'yes', label: '继续' }],
      defaultValue: 'yes'
    });

    const queue = taskService.queue('');
    expect(queue.result.map((task) => task.id)).toContain(doneTask.id);
    expect(queue.action.map((task) => task.id)).toContain(actionTask.id);
    expect(queue.action.some((task) => task.id === queuedTask.id)).toBe(false);
    expect(queue.result.some((task) => task.id === actionTask.id)).toBe(false);
  });

  test('list 支持 page/pageSize 分页（蓝图 task:list 契约）', () => {
    for (let i = 0; i < 5; i += 1) {
      taskService.create({ goal: `分页任务 ${i}`, assigneeId: worker.id });
    }
    const page2 = taskService.list({ period: '', page: 2, pageSize: 2 });
    expect(page2.items.length).toBe(2);
    expect(page2.total).toBe(5);
    expect(page2.page).toBe(2);
    expect(page2.pageSize).toBe(2);
    expect(page2.totalPages).toBe(3);
    // 第一页与第二页不重叠
    const page1 = taskService.list({ period: '', page: 1, pageSize: 2 });
    const ids1 = new Set(page1.items.map((task) => task.id));
    expect(page2.items.some((task) => ids1.has(task.id))).toBe(false);
  });

  test('任务时间线存独立集合，detail 按需组装', () => {
    const task = taskService.create({ goal: '时间线任务', assigneeId: worker.id });
    const stored = db.find('tasks', task.id);
    expect(stored).not.toHaveProperty('events');

    const detail = taskService.detail(task.id);
    expect(detail.task.events.length).toBeGreaterThan(0);
    expect(detail.task.events[0].type).toBe('created');
    expect(detail.task.events.every((event) => event.taskId === task.id)).toBe(true);
  });
});
