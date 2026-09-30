/**
 * 任务运行时端到端冒烟测试（对应优化项 #4）
 * 验证 async 改造后完整生命周期仍可用：创建 → 派发 → 逐步执行 → 收口成功，
 * 以及中途取消能中断执行。使用一个最小快速执行器，不依赖 mock 的随机延时。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  initTempDb,
  cleanupTempDb,
  db,
  workerService,
  flowService,
  taskService,
  executor,
  runtime
} from './setup.js';

let dir;

/** 最小执行器：两步、无延时、不注入用户操作 */
const fastExecutor = {
  name: 'fast-test',
  buildSteps: () => [
    { step: 1, title: '步骤一', status: 'pending', startedAt: null, finishedAt: null, log: '', citations: [] },
    { step: 2, title: '步骤二', status: 'pending', startedAt: null, finishedAt: null, log: '', citations: [] }
  ],
  buildFlowSteps: (task, plan) => fastExecutor.buildSteps(task, plan),
  stepDelay: () => 1,
  runStep: (task, step) => ({ log: `完成 ${step.title}`, citations: [] }),
  maybeAction: () => null,
  buildResult: (task) => ({ summary: 'done', text: 'done', artifacts: [], capabilities: {} })
};

/** 轮询等待任务进入目标状态（runtime 是异步的） */
async function waitForStatus(taskId, status, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = db.find('tasks', taskId);
    if (task && task.status === status) return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待任务 ${taskId} 进入 ${status} 超时，当前：${db.find('tasks', taskId)?.status}`);
}

beforeAll(() => {
  dir = initTempDb();
  executor.register(fastExecutor, { activate: true });
  runtime.start();
});

afterAll(() => {
  runtime.shutdown(); // 清理离线重试等定时器，避免测试进程挂起
  cleanupTempDb(dir);
});

describe('task-runtime 端到端', () => {
  test('在线 Worker 的任务能完整执行到 succeeded', async () => {
    const worker = workerService.createWorker({ name: '执行者' });
    const task = taskService.create({ goal: '写一份周报', assigneeId: worker.id });

    const finished = await waitForStatus(task.id, 'succeeded');
    expect(finished.status).toBe('succeeded');
    expect(finished.steps.every((s) => s.status === 'done')).toBe(true);
    expect(finished.result.summary).toBe('done');
  });

  test('离线 Worker 的任务保持 queued（不丢失）', () => {
    const worker = workerService.createWorker({ name: '离线者' });
    workerService.updateWorker(worker.id, { status: 'offline' });
    const task = taskService.create({ goal: '离线目标', assigneeId: worker.id });

    const stored = db.find('tasks', task.id);
    expect(stored.status).toBe('queued');
  });

  test('取消执行中的任务后不再推进到 succeeded', async () => {
    const worker = workerService.createWorker({ name: '可取消' });
    // 用较慢的执行器制造取消窗口
    const slow = { ...fastExecutor, name: 'slow-test', stepDelay: () => 40 };
    executor.register(slow);
    executor.setActive('slow-test');

    const task = taskService.create({ goal: '长任务', assigneeId: worker.id });
    await waitForStatus(task.id, 'running');
    taskService.cancel(task.id, '用户取消');

    // 取消后等待一段时间，任务不应变成 succeeded
    await new Promise((r) => setTimeout(r, 200));
    const stored = db.find('tasks', task.id);
    expect(stored.status).toBe('canceled');

    executor.setActive('fast-test');
  });

  test('并发上限：同时运行的任务数不超过 MAX_CONCURRENT', () => {
    // 用慢执行器让任务保持 running，便于同步观察并发占用
    const hold = { ...fastExecutor, name: 'hold-test', stepDelay: () => 5000 };
    executor.register(hold);
    executor.setActive('hold-test');
    db.removeWhere('tasks', () => true);

    const worker = workerService.createWorker({ name: '并发者' });
    const created = [];
    for (let i = 0; i < runtime.MAX_CONCURRENT + 2; i += 1) {
      created.push(taskService.create({ goal: `并发任务 ${i}`, assigneeId: worker.id }));
    }

    const running = created.filter((t) => db.find('tasks', t.id).status === 'running').length;
    const queued = created.filter((t) => db.find('tasks', t.id).status === 'queued').length;
    expect(running).toBe(runtime.MAX_CONCURRENT);
    expect(queued).toBe(2);

    // 清理：取消这些占位任务，恢复快速执行器
    created.forEach((t) => taskService.cancel(t.id, '测试清理'));
    executor.setActive('fast-test');
  });

  test('派发失败兜底：执行器构建步骤抛错时任务落为 failed 而非卡在排队中', async () => {
    const worker = workerService.createWorker({ name: '异常执行者' });
    const boom = {
      ...fastExecutor,
      name: 'boom-test',
      buildSteps: () => {
        throw new Error('构建步骤失败');
      }
    };
    executor.register(boom);
    executor.setActive('boom-test');

    const task = taskService.create({ goal: '派发即失败', assigneeId: worker.id });
    const finished = await waitForStatus(task.id, 'failed');
    expect(finished.error.code).toBe('RUNTIME_ERROR');
    expect(finished.error.message).toBe('构建步骤失败');
    executor.setActive('fast-test');
  });

  test('派发失败兜底：Flow 在排队等待期间被删除，槽位释放派发时任务应失败', async () => {
    const hold = { ...fastExecutor, name: 'hold-test', stepDelay: () => 5000 };
    executor.register(hold);
    executor.setActive('hold-test');
    db.removeWhere('tasks', () => true);

    // 占满全部并发槽位
    const worker = workerService.createWorker({ name: '占位执行者' });
    const holders = [];
    for (let i = 0; i < runtime.MAX_CONCURRENT; i += 1) {
      holders.push(taskService.create({ goal: `占位 ${i}`, assigneeId: worker.id }));
    }

    // 槽位已满，Flow 任务进入等待队列
    const flowWorker = workerService.createWorker({ name: '流程节点' });
    const flow = flowService.create({
      name: `待删流程 ${Date.now()}`,
      nodes: [{ title: '第一步', workerId: flowWorker.id, instruction: '执行指令' }]
    });
    const flowTask = taskService.create({ goal: '流程任务', assigneeId: flow.id });
    expect(db.find('tasks', flowTask.id).status).toBe('queued');

    // 排队期间 Flow 被删除；随后取消一个占位任务释放槽位，触发 drainWaiting 派发
    db.remove('flows', flow.id);
    taskService.cancel(holders[0].id, '释放槽位');

    const finished = await waitForStatus(flowTask.id, 'failed');
    expect(finished.error.code).toBe('RUNTIME_ERROR');

    // 兜底应清理中间态：后续任务仍可正常派发（并发槽位未泄漏）
    const next = taskService.create({ goal: '槽位回收验证', assigneeId: worker.id });
    await waitForStatus(next.id, 'running');

    holders.slice(1).forEach((t) => taskService.cancel(t.id, '测试清理'));
    executor.setActive('fast-test');
  });

  test('派发兜底：执行者 Worker 被删除后，任务应失败而非永久排队', async () => {
    const worker = workerService.createWorker({ name: '将被删除的执行者' });
    workerService.updateWorker(worker.id, { status: 'offline' });
    const task = taskService.create({ goal: '孤儿任务', assigneeId: worker.id });
    expect(db.find('tasks', task.id).status).toBe('queued');

    // 排队期间执行者被删除；重新派发（启动恢复/退避重试都会走到）应判失败而非无限离线重试
    workerService.removeWorker(worker.id);
    runtime.dispatch(task.id);

    const finished = await waitForStatus(task.id, 'failed');
    expect(finished.error.code).toBe('VALIDATION_FAILED');
    expect(finished.error.message).toMatch(/执行者/);
  });

  test('空 Group 不能作为执行者创建任务（创建时即拒绝）', () => {
    const group = workerService.createGroup({ name: `空组 ${Date.now()}` });
    expect(() => taskService.create({ goal: '空组任务', assigneeId: group.id })).toThrow(/没有成员/);
  });
});

describe('need_action 暂停与恢复（核心卖点路径，蓝图测试要点）', () => {
  test('进入 need_action → 提交操作 → 恢复执行到 succeeded', async () => {
    const worker = workerService.createWorker({ name: '审批执行者' });
    const pausing = {
      ...fastExecutor,
      name: 'pausing-test',
      stepDelay: () => 5,
      // 第 2 步注入确认（必须尊重 ctx.actionUsed，与生产执行器语义一致，否则恢复后无限暂停）
      maybeAction: (task, step, ctx) =>
        step.step === 2 && !ctx.actionUsed
          ? {
              type: 'confirm',
              title: '确认继续？',
              options: [{ value: 'yes', label: '继续' }],
              defaultValue: 'yes'
            }
          : null
    };
    executor.register(pausing);
    executor.setActive('pausing-test');

    const task = taskService.create({ goal: '需要确认的任务', assigneeId: worker.id });
    const paused = await waitForStatus(task.id, 'need_action');
    expect(paused.actionRequest).toBeTruthy();
    expect(paused.actionRequest.answer).toBeNull();

    // 暂停态必须稳定停留（不会自行恢复或误转终态）
    await new Promise((r) => setTimeout(r, 60));
    expect(db.find('tasks', task.id).status).toBe('need_action');

    taskService.answer({ taskId: task.id, answer: { value: 'yes' } });

    const finished = await waitForStatus(task.id, 'succeeded');
    expect(finished.actionRequest.answer.value).toBe('yes');
    expect(finished.steps.every((s) => s.status === 'done')).toBe(true);
    executor.setActive('fast-test');
  });
});

describe('执行异常路径（并发槽位必须释放，否则失败任务累积会锁死运行时）', () => {
  test('runStep 抛错后任务落为 failed，且槽位释放、后续任务仍可派发', async () => {
    db.removeWhere('tasks', () => true);
    const worker = workerService.createWorker({ name: '炸点执行者' });
    const exploding = {
      ...fastExecutor,
      name: 'explode-test',
      stepDelay: () => 5,
      runStep: (task, step) => {
        if (step.step === 2) throw new Error('步骤执行炸了');
        return { log: 'ok', citations: [] };
      }
    };
    executor.register(exploding);
    executor.setActive('explode-test');

    const first = taskService.create({ goal: '执行即失败', assigneeId: worker.id });
    const done = await waitForStatus(first.id, 'failed');
    expect(done.error.code).toBe('RUNTIME_ERROR');
    expect(done.error.message).toBe('步骤执行炸了');

    // 连续失败 MAX_CONCURRENT 次：修复前每次失败泄漏一个槽位，第 6 个任务将永久排队
    for (let i = 0; i < runtime.MAX_CONCURRENT; i += 1) {
      const t = taskService.create({ goal: `连炸任务 ${i}`, assigneeId: worker.id });
      await waitForStatus(t.id, 'failed');
    }

    executor.setActive('fast-test');
    const survivor = taskService.create({ goal: '幸存任务', assigneeId: worker.id });
    await waitForStatus(survivor.id, 'running');
    await waitForStatus(survivor.id, 'succeeded');
  });

  test('runStep 挂起超过执行器超时时间后任务按 STEP_TIMEOUT 失败并释放槽位', async () => {
    db.removeWhere('tasks', () => true);
    const worker = workerService.createWorker({ name: '挂起执行者' });
    const hanging = {
      ...fastExecutor,
      name: 'hang-test',
      stepDelay: () => 1,
      stepTimeoutMs: () => 50,
      runStep: () => new Promise(() => {}) // 永不返回，模拟网络黑洞
    };
    executor.register(hanging);
    executor.setActive('hang-test');

    const task = taskService.create({ goal: '挂起任务', assigneeId: worker.id });
    const done = await waitForStatus(task.id, 'failed', 3000);
    expect(done.error.code).toBe('STEP_TIMEOUT');

    executor.setActive('fast-test');
    const next = taskService.create({ goal: '超时后恢复', assigneeId: worker.id });
    await waitForStatus(next.id, 'running');
  });
});

describe('task-service 状态机终态守卫', () => {  test('succeeded 任务拒绝再变更（failTask/completeStep），ack 仍可查收', async () => {
    executor.setActive('fast-test');
    const worker = workerService.createWorker({ name: '守卫执行者' });
    const task = taskService.create({ goal: '守卫目标', assigneeId: worker.id });
    await waitForStatus(task.id, 'succeeded');

    expect(() => taskService.failTask(task.id, { code: 'RUNTIME_ERROR', message: '迟到失败' })).toThrow(
      /已结束/
    );
    expect(() => taskService.completeStep(task.id, 1, '迟到的日志')).toThrow(/已结束/);

    const stored = db.find('tasks', task.id);
    expect(stored.status).toBe('succeeded');
    expect(stored.error).toBeNull();

    const acked = taskService.ack(task.id);
    expect(acked.resultAckedAt).toBeTruthy();
  });

  test('canceled 任务不会被迟到的 failTask 改写为 failed', async () => {
    const hold = { ...fastExecutor, name: 'guard-hold', stepDelay: () => 5000 };
    executor.register(hold);
    executor.setActive('guard-hold');
    const worker = workerService.createWorker({ name: '取消守卫者' });
    const task = taskService.create({ goal: '取消守卫目标', assigneeId: worker.id });
    await waitForStatus(task.id, 'running');

    taskService.cancel(task.id, '用户取消');
    expect(() => taskService.failTask(task.id, { message: '迟到失败' })).toThrow(/已结束/);
    expect(db.find('tasks', task.id).status).toBe('canceled');

    executor.setActive('fast-test');
  });
});

describe('need_action 暂停不占用并发槽位（P1-7）', () => {
  // 用例批前清场：contexts/waiting 是模块级状态，前序用例的残留会干扰并发断言
  beforeAll(() => {
    runtime.shutdown();
  });

  /** 在第 1 步注入确认并保持较慢节奏的执行器 */
  function pausingHoldExecutor(name) {
    return {
      ...fastExecutor,
      name,
      stepDelay: () => 60,
      maybeAction: (task, step, ctx) =>
        step.step === 1 && !ctx.actionUsed
          ? { type: 'confirm', title: '确认？', options: [{ value: 'yes', label: '继续' }], defaultValue: 'yes' }
          : null
    };
  }

  function cleanup(tasks) {
    tasks.forEach((task) => {
      const current = db.find('tasks', task.id);
      if (current && !['succeeded', 'failed', 'canceled'].includes(current.status)) {
        taskService.cancel(task.id, '测试清理');
      }
    });
  }

  test('全部任务进入人工等待后，新任务仍可立即派发', async () => {
    db.removeWhere('tasks', () => true);
    const worker = workerService.createWorker({ name: '暂停占位者' });
    const pausingHold = pausingHoldExecutor('pausing-hold');
    executor.register(pausingHold);
    executor.setActive('pausing-hold');

    const paused = [];
    for (let i = 0; i < runtime.MAX_CONCURRENT; i += 1) {
      paused.push(taskService.create({ goal: `暂停占位 ${i}`, assigneeId: worker.id }));
    }
    for (const task of paused) await waitForStatus(task.id, 'need_action');

    // 修复前：暂停任务持有 context 占满槽位，新任务永久排队
    executor.setActive('hold-test');
    const extra = taskService.create({ goal: '插队任务', assigneeId: worker.id });
    await waitForStatus(extra.id, 'running');

    cleanup([...paused, extra]);
    executor.setActive('fast-test');
  });

  test('恢复时槽位已满则进入等待队列，槽位释放后自动继续执行', async () => {
    db.removeWhere('tasks', () => true);
    const worker = workerService.createWorker({ name: '恢复排队者' });
    executor.register(pausingHoldExecutor('pausing-hold-2'));
    executor.setActive('pausing-hold-2');

    const pausedTask = taskService.create({ goal: '要暂停的任务', assigneeId: worker.id });
    await waitForStatus(pausedTask.id, 'need_action');

    executor.setActive('hold-test');
    const holders = [];
    for (let i = 0; i < runtime.MAX_CONCURRENT; i += 1) {
      holders.push(taskService.create({ goal: `占满 ${i}`, assigneeId: worker.id }));
    }
    holders.forEach((task) => expect(db.find('tasks', task.id).status).toBe('running'));

    // 提交操作恢复任务：状态置 running 但槽位满 → 排队等待，不产生任何执行推进
    // （恢复时按当前 active 执行器重新接管，先切回快速执行器保证断言窗口内可完成）
    executor.setActive('fast-test');
    taskService.answer({ taskId: pausedTask.id, answer: { value: 'yes' } });
    expect(db.find('tasks', pausedTask.id).status).toBe('running');
    await new Promise((r) => setTimeout(r, 150));
    const queuedTask = db.find('tasks', pausedTask.id);
    expect(queuedTask.steps.every((step) => step.status !== 'done')).toBe(true);
    expect(queuedTask.progress).toBe(0);

    // 释放一个槽位 → drainWaiting 自动恢复执行（actionUsed 已带 answer 语义，不再二次暂停）
    taskService.cancel(holders[0].id, '释放槽位');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const current = db.find('tasks', pausedTask.id);
      if (current.steps.some((step) => step.status === 'done')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(db.find('tasks', pausedTask.id).steps.some((step) => step.status === 'done')).toBe(true);

    cleanup([pausedTask, ...holders]);
    executor.setActive('fast-test');
  });
});

describe('等待队列按优先级派发（P1-13）', () => {
  beforeAll(() => {
    runtime.shutdown(); // 清空上一用例批的模块级中间态
  });

  test('urgent 先于 low 获得释放的槽位，同级按创建顺序', () => {
    const hold = { ...fastExecutor, name: 'prio-hold', stepDelay: () => 5000 };
    executor.register(hold);
    executor.setActive('prio-hold');
    db.removeWhere('tasks', () => true);

    const worker = workerService.createWorker({ name: '优先级执行者' });
    const holders = [];
    for (let i = 0; i < runtime.MAX_CONCURRENT; i += 1) {
      holders.push(taskService.create({ goal: `占位 ${i}`, assigneeId: worker.id }));
    }

    // 低优先级先排队、紧急后排队；释放槽位后 urgent 必须先被派发
    const low = taskService.create({ goal: '低优先级任务', assigneeId: worker.id, priority: 'low' });
    const urgent = taskService.create({ goal: '紧急任务', assigneeId: worker.id, priority: 'urgent' });
    expect(db.find('tasks', low.id).status).toBe('queued');
    expect(db.find('tasks', urgent.id).status).toBe('queued');

    taskService.cancel(holders[0].id, '释放槽位');
    expect(db.find('tasks', urgent.id).status).toBe('running');
    expect(db.find('tasks', low.id).status).toBe('queued');

    taskService.cancel(holders[1].id, '释放槽位');
    expect(db.find('tasks', low.id).status).toBe('running');

    cleanupTasks([...holders, urgent, low]);
    executor.setActive('fast-test');
  });

  function cleanupTasks(tasks) {
    tasks.forEach((task) => {
      const current = db.find('tasks', task.id);
      if (current && !['succeeded', 'failed', 'canceled'].includes(current.status)) {
        taskService.cancel(task.id, '测试清理');
      }
    });
  }
});

describe('执行器锁定（P1-14）', () => {
  beforeAll(() => {
    runtime.shutdown();
  });

  test('任务执行中途切换 active 执行器，进行中的任务仍由原执行器完成', async () => {
    const lockA = {
      ...fastExecutor,
      name: 'lock-a',
      stepDelay: () => 100,
      buildResult: () => ({ summary: 'from-a', text: '', artifacts: [], capabilities: {} })
    };
    executor.register(lockA);
    executor.setActive('lock-a');

    const worker = workerService.createWorker({ name: '锁定执行者' });
    const task = taskService.create({ goal: '锁定目标', assigneeId: worker.id });
    await waitForStatus(task.id, 'running');

    executor.setActive('fast-test'); // 中途切换执行器
    const finished = await waitForStatus(task.id, 'succeeded');
    expect(finished.result.summary).toBe('from-a'); // 结果必须仍来自派发时锁定的执行器
  });
});
