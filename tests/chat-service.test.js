/**
 * @Worker（会话接入）领域服务测试
 * 覆盖：IM 连接（凭据不回传明文）、聊天绑定唯一性、会话消息接入分流
 * （未绑定→申请 / 停用→忽略 / 群聊需 @ 提及 / 单聊直转）、申请审批、级联删除与统计。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { initTempDb, cleanupTempDb, db, workerService, taskService, chatService, bus, nowIso } from './setup.js';

const require = createRequire(import.meta.url);
const imAdapter = require('../main/runtime/im-adapter');

/** 断言业务异常错误码（渲染层只按 code 决定提示策略） */
function expectAppError(fn, code) {
  try {
    fn();
  } catch (error) {
    expect(error.name).toBe('AppError');
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code} 业务异常，但未抛出`);
}

describe('chat-service：IM 连接', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = initTempDb();
  });

  afterAll(() => {
    db.flush();
    cleanupTempDb(tempDir);
  });

  test('平台目录：mock 可用，真实平台目录可见但不可创建', () => {
    const platforms = chatService.platformCatalog();
    expect(platforms.find((item) => item.key === 'mock').available).toBe(true);
    const feishu = platforms.find((item) => item.key === 'feishu');
    expect(feishu.available).toBe(false);
    expect(feishu.label).toContain('飞书');
  });

  test('创建连接：mock 无需凭据，状态已连接', () => {
    const connection = chatService.createConnection({ platform: 'mock', name: '工作号机器人' });
    expect(connection.id).toMatch(/^imc_/);
    expect(connection.status).toBe('connected');
    expect(connection.platformLabel).toContain('模拟');
  });

  test('创建连接：对外输出不包含凭据原文（sealed 数据不出服务层）', () => {
    const connection = chatService.listConnections()[0];
    expect(connection.credential).toBeUndefined();
    expect(JSON.stringify(connection)).not.toContain('sealed');
  });

  test('重名连接返回 CONFLICT', () => {
    expectAppError(() => chatService.createConnection({ platform: 'mock', name: '工作号机器人' }), 'CONFLICT');
  });

  test('不可用平台与缺名称均被校验拦截', () => {
    expectAppError(() => chatService.createConnection({ platform: 'feishu', name: '飞书', secret: 'x' }), 'VALIDATION_FAILED');
    expectAppError(() => chatService.createConnection({ platform: 'mock', name: ' ' }), 'VALIDATION_FAILED');
  });

  test('listChats：mock 适配器返回稳定聊天列表（含群聊与单聊）', () => {
    const connection = chatService.listConnections()[0];
    const first = chatService.listChats(connection.id);
    const second = chatService.listChats(connection.id);
    expect(first.supported).toBe(true);
    expect(first.chats.length).toBe(3);
    expect(first.chats).toEqual(second.chats);
    expect(first.chats.some((chat) => chat.chatType === 'group')).toBe(true);
    expect(first.chats.some((chat) => chat.chatType === 'direct')).toBe(true);
  });

  test('listChats：连接不存在返回 NOT_FOUND', () => {
    expectAppError(() => chatService.listChats('imc_not_exist'), 'NOT_FOUND');
  });
});

describe('chat-service：聊天绑定与会话消息接入', () => {
  let tempDir;
  let connection;
  let workerId;
  let workerName;

  beforeAll(() => {
    tempDir = initTempDb();
    const worker = workerService.createWorker({ name: '调研员小张', role: '数据分析', env: 'local' });
    workerId = worker.id;
    workerName = worker.name;
    connection = chatService.createConnection({ platform: 'mock', name: '演示连接' });
  });

  afterAll(() => {
    db.flush();
    cleanupTempDb(tempDir);
  });

  test('创建绑定：装饰字段完整（连接名 / Worker 名 / 聊天类型）', () => {
    const chats = chatService.listChats(connection.id).chats;
    const groupChat = chats.find((chat) => chat.chatType === 'group');
    const binding = chatService.createBinding({
      connectionId: connection.id,
      chatId: groupChat.chatId,
      chatName: groupChat.chatName,
      chatType: groupChat.chatType,
      workerId
    });
    expect(binding.id).toMatch(/^cb_/);
    expect(binding.connectionName).toBe('演示连接');
    expect(binding.workerName).toBe(workerName);
    expect(binding.chatTypeLabel).toBe('群聊');
    expect(binding.model).toBe('默认');
    expect(binding.enabled).toBe(true);
  });

  test('同一聊天重复开通返回 CONFLICT', () => {
    const chats = chatService.listChats(connection.id).chats;
    const groupChat = chats.find((chat) => chat.chatType === 'group');
    expectAppError(
      () =>
        chatService.createBinding({
          connectionId: connection.id,
          chatId: groupChat.chatId,
          chatName: groupChat.chatName,
          chatType: 'group',
          workerId
        }),
      'CONFLICT'
    );
  });

  test('执行者只允许单个 Worker（Group / Flow 拒绝）', () => {
    const group = workerService.createGroup({ name: '调研组', memberIds: [workerId] });
    expectAppError(
      () =>
        chatService.createBinding({
          connectionId: connection.id,
          chatId: 'chat-with-group',
          chatName: '群',
          chatType: 'group',
          workerId: group.id
        }),
      'VALIDATION_FAILED'
    );
  });

  test('ingest：未绑定聊天 → 生成接入申请；重复消息只刷新挂起申请不重复插入', () => {
    const first = chatService.ingest({
      connectionId: connection.id,
      chatId: `${connection.id}:group-new`,
      chatName: '新聊天群',
      chatType: 'group',
      sender: '王工',
      text: '随便聊聊'
    });
    expect(first.kind).toBe('request_created');

    const second = chatService.ingest({
      connectionId: connection.id,
      chatId: `${connection.id}:group-new`,
      chatName: '新聊天群',
      chatType: 'group',
      sender: '李工',
      text: '再次询问'
    });
    expect(second.kind).toBe('request_created');
    expect(second.requestId).toBe(first.requestId);

    const requests = chatService.listRequests({ status: 'pending' }).items;
    expect(requests.filter((item) => item.chatId === `${connection.id}:group-new`).length).toBe(1);
    expect(requests.find((item) => item.id === first.requestId).message).toBe('再次询问');
  });

  test('ingest：群聊未 @ 提及 → 忽略', () => {
    const chats = chatService.listChats(connection.id).chats;
    const directChat = chats.find((chat) => chat.chatType === 'direct');
    chatService.createBinding({
      connectionId: connection.id,
      chatId: `${connection.id}:group-bound`,
      chatName: '已绑定群',
      chatType: 'group',
      workerId
    });
    const skipped = chatService.ingest({
      connectionId: connection.id,
      chatId: `${connection.id}:group-bound`,
      chatName: '已绑定群',
      chatType: 'group',
      text: '大家好，这条不涉及 Worker'
    });
    expect(skipped.kind).toBe('skipped');
    expect(skipped.reason).toBe('no_mention');
    expect(directChat).toBeTruthy();
  });

  test('ingest：群聊 @Worker → 创建会话触发任务，提及被剥离', () => {
    const chatId = `${connection.id}:group-bound`;
    const result = chatService.ingest({
      connectionId: connection.id,
      chatId,
      chatName: '已绑定群',
      chatType: 'group',
      sender: '王工',
      text: '@Worker 整理本周客户反馈，并给出优先级'
    });
    expect(result.kind).toBe('task_created');

    const task = taskService.detail(result.taskId).task;
    expect(task.trigger.type).toBe('chat');
    expect(task.trigger.label).toBe('会话触发');
    expect(task.trigger.refId).toBeTruthy();
    expect(task.goal).toBe('整理本周客户反馈，并给出优先级');
    expect(task.assignee.id).toBe(workerId);
    expect(task.input.payload.sender).toBe('王工');
    expect(task.input.payload.source).toBe('im');

    const binding = chatService.listBindings().items.find((item) => item.chatId === chatId);
    expect(binding.lastTaskId).toBe(result.taskId);
  });

  test('ingest：群聊 @ 具体 Worker 名同样命中', () => {
    const result = chatService.ingest({
      connectionId: connection.id,
      chatId: `${connection.id}:group-bound`,
      chatName: '已绑定群',
      chatType: 'group',
      text: `@${workerName} 汇总今天的测试结论`
    });
    expect(result.kind).toBe('task_created');
    expect(taskService.detail(result.taskId).task.goal).toBe('汇总今天的测试结论');
  });

  test('ingest：单聊无需 @ 提及，消息直接转任务', () => {
    chatService.createBinding({
      connectionId: connection.id,
      chatId: `${connection.id}:direct-zhang`,
      chatName: '张三',
      chatType: 'direct',
      workerId
    });
    const result = chatService.ingest({
      connectionId: connection.id,
      chatId: `${connection.id}:direct-zhang`,
      chatName: '张三',
      chatType: 'direct',
      text: '帮我把这份周报压缩成三句话'
    });
    expect(result.kind).toBe('task_created');
    expect(taskService.detail(result.taskId).task.goal).toBe('帮我把这份周报压缩成三句话');
  });

  test('ingest：停用的绑定 → 忽略，不建任务', () => {
    const binding = chatService.listBindings().items.find((item) => item.chatId === `${connection.id}:direct-zhang`);
    chatService.toggleBinding(binding.id, false);
    const skipped = chatService.ingest({
      connectionId: connection.id,
      chatId: `${connection.id}:direct-zhang`,
      chatName: '张三',
      chatType: 'direct',
      text: '这条应该被忽略'
    });
    expect(skipped.kind).toBe('skipped');
    expect(skipped.reason).toBe('binding_disabled');
    chatService.toggleBinding(binding.id, true);
  });

  test('ingest：超长消息截断到任务目标上限（500 字），不抛错', () => {
    const longText = `@Worker ${'测'.repeat(600)}`;
    const result = chatService.ingest({
      connectionId: connection.id,
      chatId: `${connection.id}:group-bound`,
      chatName: '已绑定群',
      chatType: 'group',
      text: longText
    });
    expect(result.kind).toBe('task_created');
    expect(taskService.detail(result.taskId).task.goal.length).toBe(500);
  });

  test('ingest：连接不存在返回 NOT_FOUND，空消息被校验拦截', () => {
    expectAppError(() => chatService.ingest({ connectionId: 'imc_x', chatId: 'c', text: 'hi' }), 'NOT_FOUND');
    expectAppError(
      () => chatService.ingest({ connectionId: connection.id, chatId: 'c', text: '   ' }),
      'VALIDATION_FAILED'
    );
  });
});

describe('chat-service：接入申请审批与级联删除', () => {
  let tempDir;
  let connection;
  let workerId;

  beforeAll(() => {
    tempDir = initTempDb();
    workerId = workerService.createWorker({ name: '审批员', role: '数据分析' }).id;
    connection = chatService.createConnection({ platform: 'mock', name: '审批连接' });
  });

  afterAll(() => {
    db.flush();
    cleanupTempDb(tempDir);
  });

  test('同意申请：生成绑定并回写 bindingId，重复审批幂等返回既有结果（O13）', () => {
    const request = chatService.ingest({
      connectionId: connection.id,
      chatId: 'chat-approve',
      chatName: '待审批群',
      chatType: 'group',
      text: '@Worker 你好'
    });

    const { request: resolved, binding } = chatService.approveRequest(request.requestId, {
      workerId,
      workspace: 'D:\\Work',
      model: '快速模型'
    });
    expect(resolved.status).toBe('approved');
    expect(resolved.bindingId).toBe(binding.id);
    expect(binding.workerId).toBe(workerId);
    expect(binding.model).toBe('快速模型');
    expect(binding.workspace).toBe('D:\\Work');

    // 重复审批：不再撞「该聊天已开通」的 CONFLICT/INVALID_STATE，而是幂等返回同一绑定
    const repeated = chatService.approveRequest(request.requestId, { workerId });
    expect(repeated.binding.id).toBe(binding.id);
    expect(repeated.request.status).toBe('approved');
    expectAppError(() => chatService.rejectRequest(request.requestId), 'INVALID_STATE');
  });

  test('同意时聊天已被占用返回 CONFLICT（向导先行开通同一聊天）', () => {
    const request = chatService.ingest({
      connectionId: connection.id,
      chatId: 'chat-clash',
      chatName: '占用群',
      chatType: 'group',
      text: '想接入'
    });
    expect(request.kind).toBe('request_created');
    // 申请挂起期间，同一聊天经开通向导被先绑定
    chatService.createBinding({
      connectionId: connection.id,
      chatId: 'chat-clash',
      chatName: '占用群',
      chatType: 'group',
      workerId
    });
    expectAppError(() => chatService.approveRequest(request.requestId, { workerId }), 'CONFLICT');
  });

  test('拒绝申请：状态置为 rejected', () => {
    const request = chatService.ingest({
      connectionId: connection.id,
      chatId: 'chat-reject',
      chatName: '被拒群',
      chatType: 'group',
      text: '想接入'
    });
    const rejected = chatService.rejectRequest(request.requestId);
    expect(rejected.status).toBe('rejected');
    expect(rejected.resolvedAt).toBeTruthy();
  });

  test('删除连接级联清理绑定与申请，避免悬挂引用', () => {
    const stats = chatService.stats();
    expect(stats.connections).toBeGreaterThan(0);
    expect(stats.bindings).toBeGreaterThan(0);

    const result = chatService.removeConnection(connection.id);
    expect(result.removedBindings).toBe(stats.bindings);
    expect(db.all('chatconnections').find((item) => item.id === connection.id)).toBeUndefined();
    expect(db.all('chatbindings').filter((item) => item.connectionId === connection.id).length).toBe(0);
    expect(db.all('chatrequests').filter((item) => item.connectionId === connection.id).length).toBe(0);
  });
});

describe('chat-service：连接编辑与凭据轮换、healthy 结构化输出、申请更新事件（P1-9/12/17）', () => {
  let tempDir;
  let busEvents;

  beforeAll(() => {
    tempDir = initTempDb();
    busEvents = [];
    bus.on((event) => busEvents.push(event));
  });

  afterAll(() => {
    db.flush();
    cleanupTempDb(tempDir);
  });

  test('updateConnection 支持改名与凭据轮换，明文不出服务层', () => {
    const connection = chatService.createConnection({ platform: 'mock', name: `待编辑连接${Date.now().toString(36)}` });

    // mock 平台无需凭据：提供凭据应被拒绝；仅改名正常
    expectAppError(() => chatService.updateConnection(connection.id, { name: 'x', secret: 'brand-new-secret' }), 'VALIDATION_FAILED');
    const renamed = chatService.updateConnection(connection.id, { name: '改名后的连接' });
    expect(renamed.name).toBe('改名后的连接');

    // 真实平台（requiresCredential）的凭据轮换：构造记录验证加密落盘与掩码输出
    const stamp = Date.now().toString(36);
    db.insert('chatconnections', {
      id: `imc_vault_${stamp}`,
      platform: 'feishu',
      name: `凭据轮换连接${stamp}`,
      credential: null,
      status: 'connected',
      createdAt: nowIso(),
      updatedAt: nowIso()
    });
    const updated = chatService.updateConnection(`imc_vault_${stamp}`, { secret: 'brand-new-secret' });
    expect(updated.credentialMask.endsWith('cret')).toBe(true);
    expect(JSON.stringify(updated)).not.toContain('brand-new-secret');

    const stored = db.find('chatconnections', `imc_vault_${stamp}`);
    expect(stored.credential.sealed).toBeTruthy();
    expect(JSON.stringify(stored.credential.sealed)).not.toContain('brand-new-secret');
    chatService.removeConnection(`imc_vault_${stamp}`);
  });

  test('绑定装饰输出 healthy 结构化字段，Worker 删除后为 false', () => {
    const worker = workerService.createWorker({ name: `健康工${Date.now().toString(36)}`.slice(0, 20) });
    const connection = chatService.createConnection({ platform: 'mock', name: `健康连接${Date.now().toString(36)}` });
    const binding = chatService.createBinding({
      connectionId: connection.id,
      chatId: `chat-healthy-${Date.now()}`,
      chatName: '健康测试群',
      workerId: worker.id
    });
    expect(chatService.listBindings().items.find((item) => item.id === binding.id).healthy).toBe(true);

    workerService.removeWorker(worker.id);
    expect(chatService.listBindings().items.find((item) => item.id === binding.id)).toBeUndefined(); // 已级联清理
  });

  test('重复消息刷新挂起申请时广播 chat:request-updated（审批列表可实时刷新）', () => {
    const connection = chatService.createConnection({ platform: 'mock', name: `申请更新连接${Date.now().toString(36)}` });
    const chatId = `chat-req-update-${Date.now()}`;
    chatService.ingest({ connectionId: connection.id, chatId, chatName: '申请群', chatType: 'group', text: '第一次' });
    busEvents.length = 0;
    chatService.ingest({ connectionId: connection.id, chatId, chatName: '申请群', chatType: 'group', sender: '新同事', text: '第二次' });

    const updated = busEvents.find((event) => event.type === 'chat:request-updated');
    expect(updated).toBeTruthy();
    expect(updated.payload.message).toBe('第二次');
    expect(updated.payload.sender).toBe('新同事');
  });
});

describe('chat-service：出站回执与应答回流（F3）', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = initTempDb();
    chatService.startNotifier();
    chatService.startNotifier(); // 幂等
    imAdapter.clearOutbox();
  });

  afterAll(() => {
    db.flush();
    cleanupTempDb(tempDir);
  });

  test('need_action 与终态回执推送到原聊天（mock outbox 记录）', () => {
    const worker = workerService.createWorker({ name: '回执执行者' });
    const connection = chatService.createConnection({ platform: 'mock', name: `回执连接 ${Date.now()}` });
    const binding = chatService.createBinding({
      connectionId: connection.id,
      chatId: `${connection.id}:group-dev`,
      chatName: '回执群',
      workerId: worker.id
    });
    const inbound = chatService.ingest({
      connectionId: connection.id,
      chatId: binding.chatId,
      chatName: '回执群',
      chatType: 'group',
      sender: '王工',
      text: `@${worker.name} 检查一下数据`
    });
    expect(inbound.kind).toBe('task_created');
    const taskId = inbound.taskId;
    expect(imAdapter.listOutbox(connection.id).length).toBe(0); // 尚无可回执的事件

    // 进入 need_action → 操作请求推送到聊天
    taskService.requestAction(taskId, {
      type: 'selection',
      title: '请选择统计口径',
      options: [
        { value: 'amount', label: '按金额' },
        { value: 'count', label: '按条数' }
      ],
      defaultValue: 'amount'
    });
    let messages = imAdapter.listOutbox(connection.id);
    expect(messages.length).toBe(1);
    expect(messages[0].chatId).toBe(binding.chatId);
    expect(messages[0].content).toContain('请选择统计口径');

    // 应答回流：按 label 匹配选项，任务恢复 running
    const answered = chatService.answerPendingAction(binding.id, '按条数');
    expect(answered.answer.value).toBe('count');
    expect(db.find('tasks', taskId).status).toBe('running');

    // 完成 → 结果摘要推送
    taskService.succeed(taskId, { summary: '数据处理完成' });
    messages = imAdapter.listOutbox(connection.id);
    expect(messages.length).toBe(2);
    expect(messages[1].content).toContain('已完成');
    expect(messages[1].content).toContain('数据处理完成');
  });

  test('answerPendingAction：无效选项与无在途任务时给出业务错误', () => {
    const worker = workerService.createWorker({ name: '回流执行者' });
    const connection = chatService.createConnection({ platform: 'mock', name: `回流连接 ${Date.now()}` });
    const binding = chatService.createBinding({
      connectionId: connection.id,
      chatId: `${connection.id}:direct-zhang`,
      chatName: '张三',
      workerId: worker.id
    });

    expectAppError(() => chatService.answerPendingAction(binding.id, '任意'), 'INVALID_STATE');

    const inbound = chatService.ingest({
      connectionId: connection.id,
      chatId: binding.chatId,
      chatType: 'direct',
      sender: '张三',
      text: '帮我整理数据'
    });
    taskService.requestAction(inbound.taskId, {
      type: 'selection',
      title: '选择口径',
      options: [{ value: 'amount', label: '按金额' }],
      defaultValue: 'amount'
    });
    expectAppError(() => chatService.answerPendingAction(binding.id, '乱写的'), 'VALIDATION_FAILED');
  });
});
