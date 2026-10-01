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

describe('taskService.exportTasks 任务历史导出（F5）', () => {
  let worker;

  beforeEach(() => {
    ['workers', 'tasks', 'taskevents'].forEach((name) => db.removeWhere(name, () => true));
    worker = workerService.createWorker({ name: '导出执行者' });
  });

  test('导出全部历史（忽略分页参数），记录并入完整时间线', () => {
    for (let i = 0; i < 3; i += 1) {
      taskService.create({ goal: `导出任务 ${i}`, assigneeId: worker.id });
    }

    const payload = taskService.exportTasks({ period: '', page: 1, pageSize: 2 });

    expect(payload.count).toBe(3); // page/pageSize 被忽略：导出即全量口径
    expect(payload.total).toBe(3);
    expect(payload.exportedAt).toBeTruthy();
    payload.records.forEach((task) => {
      expect(task.events.length).toBeGreaterThan(0); // 时间线并入（tasks 集合本身不含 events）
      expect(task.events.every((event) => event.taskId === task.id)).toBe(true);
    });
  });

  test('导出遵循筛选口径（period / status）', () => {
    taskService.create({ goal: '筛选导出任务', assigneeId: worker.id });
    const payload = taskService.exportTasks({ period: '', status: 'finished' });
    expect(payload.count).toBe(0); // 刚创建的任务未结束，按「已结束」筛选导出为空
  });

  test('时间线索引化：各任务仅并入自己的事件（BUG-18）', () => {
    const taskA = taskService.create({ goal: '任务A', assigneeId: worker.id });
    const taskB = taskService.create({ goal: '任务B', assigneeId: worker.id });
    const payload = taskService.exportTasks({ period: '' });
    const recordA = payload.records.find((task) => task.id === taskA.id);
    const recordB = payload.records.find((task) => task.id === taskB.id);
    expect(recordA.events.length).toBeGreaterThan(0);
    expect(recordA.events.every((event) => event.taskId === taskA.id)).toBe(true);
    expect(recordB.events.every((event) => event.taskId === taskB.id)).toBe(true);
    // 事件与任务严格一一对应：重复导出 A 的事件数不变（索引化不会串集）
    const countA = recordA.events.length;
    const payload2 = taskService.exportTasks({ period: '' });
    expect(payload2.records.find((task) => task.id === taskA.id).events.length).toBe(countA);
  });
});

describe('taskService.retry 任务重试（F1）', () => {
  let worker;

  beforeEach(() => {
    ['workers', 'tasks', 'taskevents'].forEach((name) => db.removeWhere(name, () => true));
    worker = workerService.createWorker({ name: '重试执行者' });
  });

  function makeFailedTask() {
    const source = taskService.create({ goal: '会失败的任务', assigneeId: worker.id, tags: ['回归'] });
    db.update('tasks', source.id, { status: 'failed' });
    return source;
  }

  test('重试创建新任务重新入队，并通过 retryOf 与原任务时间线关联', () => {
    const source = makeFailedTask();
    const retried = taskService.retry(source.id);

    expect(retried.id).not.toBe(source.id);
    expect(retried.retryOf).toBe(source.id);
    expect(retried.goal).toBe(source.goal);
    expect(retried.assignee.id).toBe(source.assignee.id);
    expect(retried.tags).toContain('回归');
    expect(retried.status).toBe('queued');

    const sourceEvents = taskService.detail(source.id).task.events;
    expect(sourceEvents.some((event) => event.type === 'retried' && event.message.includes(retried.id))).toBe(true);
  });

  test('fromStep="failed" 按原任务首个未完成步骤设置断点', () => {
    const source = makeFailedTask();
    db.update('tasks', source.id, {
      steps: [
        { step: 1, title: '步骤一', status: 'done', log: '已完成', citations: [], startedAt: null, finishedAt: null },
        { step: 2, title: '步骤二', status: 'failed', log: '', citations: [], startedAt: null, finishedAt: null }
      ]
    });
    const retried = taskService.retry(source.id, { fromStep: 'failed' });
    expect(retried.input.retryFromStep).toBe(2);
  });

  test('非终态任务不能重试', () => {
    const task = taskService.create({ goal: '进行中的任务', assigneeId: worker.id });
    expect(() => taskService.retry(task.id)).toThrow(/仅失败或已取消/);
  });
});

describe('taskService 列表检索与批量查收（O8/F8）', () => {
  let worker;

  beforeEach(() => {
    ['workers', 'tasks', 'taskevents'].forEach((name) => db.removeWhere(name, () => true));
    worker = workerService.createWorker({ name: '检索执行者' });
  });

  test('关键词检索覆盖 tags（激活原先只写不读的死字段）', () => {
    taskService.create({ goal: '季度报表任务', assigneeId: worker.id, tags: ['数据', '周报'] });
    taskService.create({ goal: '无关任务', assigneeId: worker.id });

    const byTag = taskService.list({ period: '', keyword: '周报' });
    expect(byTag.items.length).toBe(1);
    expect(byTag.items[0].tags).toContain('数据');
  });

  test('list 支持按 tag 精确筛选', () => {
    taskService.create({ goal: '打标任务', assigneeId: worker.id, tags: ['重要'] });
    taskService.create({ goal: '未标任务', assigneeId: worker.id });

    expect(taskService.list({ period: '', tag: '重要' }).items.length).toBe(1);
    expect(taskService.list({ period: '', tag: '不存在' }).items.length).toBe(0);
  });

  test('ackAll 一键查收周期内全部待查收结果，已查收的不重复计入', () => {
    const t1 = taskService.create({ goal: '完成一', assigneeId: worker.id });
    const t2 = taskService.create({ goal: '完成二', assigneeId: worker.id });
    taskService.create({ goal: '进行中', assigneeId: worker.id });
    taskService.succeed(t1.id, { summary: 'ok' });
    taskService.succeed(t2.id, { summary: 'ok' });
    taskService.ack(t1.id); // 已手动查收

    const result = taskService.ackAll('');
    expect(result.acked).toBe(1);
    expect(db.find('tasks', t2.id).resultAckedAt).toBeTruthy();
    expect(db.find('tasks', t1.id).resultAckedAt).toBeTruthy();
    // 进行中的任务不受影响
    expect(db.countWhere('tasks', { 'assignee.id': worker.id })).toBe(3);
  });
});
