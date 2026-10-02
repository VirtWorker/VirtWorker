/**
 * Worker 级联删除测试（对应优化项 #2）
 * 验证：删除 Worker 时，流程引用被阻止、关联自动任务被停用、Group 成员被摘除。
 * 注意：生产模块统一经 setup.js 的 createRequire 导出，确保与运行时共享同一 db 单例。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  initTempDb,
  cleanupTempDb,
  db,
  workerService,
  automationService,
  flowService,
  chatService,
  taskService
} from './setup.js';

let dir;

beforeAll(() => {
  dir = initTempDb();
});

afterAll(() => {
  cleanupTempDb(dir);
});

describe('removeWorker 级联处理', () => {
  beforeEach(() => {
    ['workers', 'groups', 'automations', 'flows', 'capabilities'].forEach((name) =>
      db.removeWhere(name, () => true)
    );
  });

  test('被流程引用的 Worker 不允许删除', () => {
    const worker = workerService.createWorker({ name: '小明' });
    flowService.create({
      name: '日报流程',
      nodes: [{ workerId: worker.id, instruction: '生成日报' }]
    });

    expect(() => workerService.removeWorker(worker.id)).toThrow(/正被流程/);
    expect(workerService.getWorker(worker.id)).toBeTruthy();
  });

  test('删除 Worker 会停用直接绑定它的自动任务', () => {
    const worker = workerService.createWorker({ name: '小红' });
    const automation = automationService.create({
      name: '定时巡检',
      executorId: worker.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '每日巡检' }
    });
    expect(automation.enabled).toBe(true);

    const result = workerService.removeWorker(worker.id);

    expect(result.disabledAutomations).toEqual([automation.id]);
    expect(db.find('automations', automation.id).enabled).toBe(false);
    expect(db.find('automations', automation.id).nextRunAt).toBe(null);
  });

  test('删除 Worker 会摘除 Group 成员并停用绑定空 Group 的自动任务', () => {
    const w1 = workerService.createWorker({ name: '成员A' });
    const group = workerService.createGroup({ name: '唯一组', memberIds: [w1.id] });
    const automation = automationService.create({
      name: '组任务',
      executorId: group.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '组协作目标' }
    });

    const result = workerService.removeWorker(w1.id);

    expect(db.find('groups', group.id).memberIds).toEqual([]);
    expect(result.disabledAutomations).toEqual([automation.id]);
    expect(db.find('automations', automation.id).enabled).toBe(false);
  });

  test('删除 Worker 不影响未绑定的自动任务', () => {
    const w1 = workerService.createWorker({ name: '被删者' });
    const w2 = workerService.createWorker({ name: '幸存者' });
    const automation = automationService.create({
      name: '无关任务',
      executorId: w2.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '目标' }
    });

    const result = workerService.removeWorker(w1.id);

    expect(result.disabledAutomations).toEqual([]);
    expect(db.find('automations', automation.id).enabled).toBe(true);
  });
});

describe('removeWorker / updateGroup / 事件触发器级联（O4 补齐）', () => {
  beforeEach(() => {
    ['workers', 'groups', 'automations', 'flows', 'capabilities', 'tasks', 'taskevents'].forEach((name) =>
      db.removeWhere(name, () => true)
    );
  });

  test('删除 Worker 会取消其名下在途任务，不再产生"延迟僵尸"（O4）', () => {
    const worker = workerService.createWorker({ name: '在途执行者' });
    const queued = taskService.create({ goal: '排队中的任务', assigneeId: worker.id });
    const finished = taskService.create({ goal: '已完成的任务', assigneeId: worker.id });
    db.update('tasks', finished.id, { status: 'succeeded' }); // 终态任务不受级联影响

    const result = workerService.removeWorker(worker.id);

    expect(result.canceledTasks).toEqual([queued.id]);
    expect(db.find('tasks', queued.id).status).toBe('canceled');
    expect(db.find('tasks', finished.id).status).toBe('succeeded');
  });

  test('updateGroup 清空成员会停用绑定该 Group 的自动任务并取消在途任务（O4）', () => {
    const w1 = workerService.createWorker({ name: '将被移出的成员' });
    const group = workerService.createGroup({ name: '清空测试组', memberIds: [w1.id] });
    const automation = automationService.create({
      name: '清空组任务',
      executorId: group.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '组目标' }
    });
    const task = taskService.create({ goal: '组在途任务', assigneeId: group.id });

    const result = workerService.updateGroup(group.id, { memberIds: [] });

    // 修复前：清空成员不停用自动化，调度器每次触发都因「该 Group 没有成员」失败且用户无感知
    expect(result.disabledAutomations).toEqual([automation.id]);
    expect(db.find('automations', automation.id).enabled).toBe(false);
    expect(result.canceledTasks).toEqual([task.id]);
    expect(db.find('tasks', task.id).status).toBe('canceled');
  });

  test('updateGroup 未清空成员时不触发级联', () => {
    const w1 = workerService.createWorker({ name: '保留成员' });
    const w2 = workerService.createWorker({ name: '新增成员' });
    const group = workerService.createGroup({ name: '正常调整组', memberIds: [w1.id] });
    const automation = automationService.create({
      name: '正常组任务',
      executorId: group.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '组目标' }
    });

    const result = workerService.updateGroup(group.id, { memberIds: [w1.id, w2.id] });

    expect(result.disabledAutomations).toEqual([]);
    expect(db.find('automations', automation.id).enabled).toBe(true);
  });

  test('删除 Worker 会清空事件触发器中指向它的限定执行者（避免静默失效）（O4）', () => {
    const w1 = workerService.createWorker({ name: '事件限定者' });
    const w2 = workerService.createWorker({ name: '其他执行者' });
    const automation = automationService.create({
      name: '事件限定任务',
      executorId: w2.id,
      trigger: { type: 'event', event: { source: 'task_succeeded', assigneeId: w1.id } },
      input: { goal: '事件目标' }
    });

    workerService.removeWorker(w1.id);

    const stored = db.find('automations', automation.id);
    expect(stored.enabled).toBe(true); // 事件自动化本身不受影响
    expect(stored.trigger.event.assigneeId).toBe(''); // 限定已清空，不再悬空
  });
});

describe('removeGroup / flow.remove / 聊天绑定级联（与 removeWorker 对称，P0-4 补齐）', () => {
  beforeEach(() => {
    [
      'workers',
      'groups',
      'automations',
      'flows',
      'capabilities',
      'tasks',
      'taskevents',
      'chatconnections',
      'chatbindings',
      'chatrequests'
    ].forEach((name) => db.removeWhere(name, () => true));
  });

  test('删除 Group 会停用执行者绑定该 Group 的自动任务', () => {
    const w1 = workerService.createWorker({ name: '组长甲' });
    const group = workerService.createGroup({ name: '将被删除的组', memberIds: [w1.id] });
    const automation = automationService.create({
      name: '组级任务',
      executorId: group.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '组协作目标' }
    });
    expect(automation.enabled).toBe(true);

    const result = workerService.removeGroup(group.id);

    expect(result.disabledAutomations).toEqual([automation.id]);
    expect(db.find('automations', automation.id).enabled).toBe(false);
    expect(db.find('automations', automation.id).nextRunAt).toBe(null);
  });

  test('删除 Group 不影响其他执行者的自动任务', () => {
    const w1 = workerService.createWorker({ name: '独立工' });
    const automation = automationService.create({
      name: '独立任务',
      executorId: w1.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '目标' }
    });
    const group = workerService.createGroup({ name: '旁观的组', memberIds: [w1.id] });

    workerService.removeGroup(group.id);

    expect(db.find('automations', automation.id).enabled).toBe(true);
  });

  test('删除 WorkerFlow 会停用引用该流程的自动任务', () => {
    const w1 = workerService.createWorker({ name: '流程工' });
    const flow = flowService.create({
      name: '将被删除的流程',
      nodes: [{ workerId: w1.id, instruction: '执行指令' }]
    });
    const automation = automationService.create({
      name: '流程任务',
      executorId: flow.id,
      trigger: { type: 'schedule', schedule: { mode: 'daily', hour: 9, minute: 0 } },
      input: { goal: '流程目标' }
    });

    const result = flowService.remove(flow.id);

    expect(result.disabledAutomations).toEqual([automation.id]);
    expect(db.find('automations', automation.id).enabled).toBe(false);
  });

  test('删除 Worker 会清理其聊天绑定（避免 @Worker 悬空引用）', () => {
    const w1 = workerService.createWorker({ name: '绑定工' });
    const connection = chatService.createConnection({ platform: 'mock', name: `级联连接 ${Date.now()}` });
    chatService.createBinding({
      connectionId: connection.id,
      chatId: 'chat-cascade',
      chatName: '级联测试群',
      workerId: w1.id
    });
    expect(chatService.listBindings().items.length).toBe(1);

    const result = workerService.removeWorker(w1.id);

    expect(result.removedBindings).toBe(1);
    expect(chatService.listBindings().items.length).toBe(0);
  });

  test('删除 Group 会取消其名下在途任务（BUG-31，与 removeWorker 对称）', () => {
    const w1 = workerService.createWorker({ name: '在途组长' });
    const group = workerService.createGroup({ name: '在途删除组', memberIds: [w1.id] });
    const task = taskService.create({ goal: '组在途任务', assigneeId: group.id });

    const result = workerService.removeGroup(group.id);

    expect(result.canceledTasks).toEqual([task.id]);
    expect(db.find('tasks', task.id).status).toBe('canceled');
  });

  test('删除 WorkerFlow 会取消执行者为该流程的在途任务（BUG-31）', () => {
    const w1 = workerService.createWorker({ name: '在途流程工' });
    const flow = flowService.create({
      name: '在途删除流程',
      nodes: [{ workerId: w1.id, instruction: '执行指令' }]
    });
    const task = taskService.create({ goal: '流程在途任务', assigneeId: flow.id });

    const result = flowService.remove(flow.id);

    expect(result.canceledTasks).toEqual([task.id]);
    expect(db.find('tasks', task.id).status).toBe('canceled');
  });
});
