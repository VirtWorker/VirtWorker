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

  test('平台目录：mock 与通用 Webhook 可用，专属平台目录可见但不可创建', () => {
    const platforms = chatService.platformCatalog();
    expect(platforms.find((item) => item.key === 'mock').available).toBe(true);
    const webhook = platforms.find((item) => item.key === 'webhook');
    expect(webhook.available).toBe(true); // E1：通用 Webhook 桥接已可用
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

  test('webhook 适配器：listChats 返回稳定默认目标，sendMessage 推送到凭据 URL（E1）', async () => {
    const connection = chatService.createConnection({
      platform: 'webhook',
      name: `Webhook连接 ${Date.now()}`,
      secret: 'https://hook.example.com/robot'
    });
    expect(connection.status).toBe('connected');
    // 凭据不出服务层：decorateConnection 将 credential 置为 undefined，仅暴露掩码
    expect(connection.credential).toBeUndefined();
    expect(connection.credentialMask).toContain('•');

    const chats = chatService.listChats(connection.id).chats;
    expect(chats.length).toBe(1);
    expect(chats[0].chatId).toBe(`${connection.id}:default`);

    // sendMessage：解封凭据 URL 并 POST { chatId, text }
    const raw = db.find('chatconnections', connection.id);
    let captured = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200 };
    };
    try {
      const result = await imAdapter.resolve('webhook').sendMessage(raw, 'room-1', '任务已完成');
      expect(result.ok).toBe(true);
      expect(captured.url).toBe('https://hook.example.com/robot');
      expect(captured.body).toEqual({ chatId: 'room-1', text: '任务已完成' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('webhook 适配器：凭据非 URL 时出站静默跳过（仅入站 Token 场景）', async () => {
    const connection = chatService.createConnection({
      platform: 'webhook',
      name: `Token连接 ${Date.now()}`,
      secret: 'inbound-shared-token'
    });
    const raw = db.find('chatconnections', connection.id);
    let fetchCalled = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled += 1;
      return { ok: true, status: 200 };
    };
    try {
      const result = await imAdapter.resolve('webhook').sendMessage(raw, 'room-1', 'hi');
      expect(result.skipped).toBe(true);
      expect(fetchCalled).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    // 与上一用例共用同一绑定（A3 节流以 lastMessageAt 为锚点）：回拨到最小间隔之外
    db.update('chatbindings', chatService.listBindings().items.find((item) => item.chatId === `${connection.id}:group-bound`).id, {
      lastMessageAt: new Date(Date.now() - chatService.CHAT_TASK_MIN_INTERVAL_MS - 1000).toISOString()
    });
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
    // 与「群聊 @Worker」用例共用同一绑定（A3 节流以 lastMessageAt 为锚点）：回拨到最小间隔之外
    db.update('chatbindings', chatService.listBindings().items.find((item) => item.chatId === `${connection.id}:group-bound`).id, {
      lastMessageAt: new Date(Date.now() - chatService.CHAT_TASK_MIN_INTERVAL_MS - 1000).toISOString()
    });
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

  test('ingest：同一聊天最小间隔内重复触发被限流（A3），不建任务并回复提示', () => {
    const chatId = `${connection.id}:group-throttle`;
    const binding = chatService.createBinding({
      connectionId: connection.id,
      chatId,
      chatName: '限流群',
      chatType: 'group',
      workerId
    });
    imAdapter.clearOutbox();
    const first = chatService.ingest({
      connectionId: connection.id,
      chatId,
      chatName: '限流群',
      chatType: 'group',
      sender: '王工',
      text: `@${workerName} 第一条`
    });
    expect(first.kind).toBe('task_created');

    // 最小间隔内的第二条：不建任务、reason=rate_limited，并经适配器回复「未生成任务」提示
    const second = chatService.ingest({
      connectionId: connection.id,
      chatId,
      chatName: '限流群',
      chatType: 'group',
      sender: '王工',
      text: `@${workerName} 第二条`
    });
    expect(second.kind).toBe('skipped');
    expect(second.reason).toBe('rate_limited');
    expect(imAdapter.listOutbox(connection.id).some((m) => m.content.includes('未生成任务'))).toBe(true);

    // 节流锚点不推进：窗口过后下一条消息可正常触发
    db.update('chatbindings', binding.id, {
      lastMessageAt: new Date(Date.now() - chatService.CHAT_TASK_MIN_INTERVAL_MS - 1000).toISOString()
    });
    const third = chatService.ingest({
      connectionId: connection.id,
      chatId,
      chatName: '限流群',
      chatType: 'group',
      sender: '王工',
      text: `@${workerName} 第三条`
    });
    expect(third.kind).toBe('task_created');
    imAdapter.clearOutbox();
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

  test('answerPendingAction：最新任务已终态而更早任务等待操作时仍可应答（BUG-24）', () => {
    const worker = workerService.createWorker({ name: '跨任务回流' });
    const connection = chatService.createConnection({ platform: 'mock', name: `跨任务连接 ${Date.now()}` });
    const binding = chatService.createBinding({
      connectionId: connection.id,
      chatId: `${connection.id}:direct-cross`,
      chatName: '跨任务',
      workerId: worker.id
    });

    // 任务 A 进入 need_action
    const inboundA = chatService.ingest({
      connectionId: connection.id,
      chatId: binding.chatId,
      chatType: 'direct',
      sender: '张三',
      text: '任务A'
    });
    taskService.requestAction(inboundA.taskId, {
      type: 'input',
      title: '补充A',
      form: [{ name: 'note', label: '说明', required: false, type: 'text' }]
    });

    // 每绑定建任务有最小间隔节流（A3）：用例需要连续建任务，把节流锚点回拨到窗口之外
    db.update('chatbindings', binding.id, {
      lastMessageAt: new Date(Date.now() - chatService.CHAT_TASK_MIN_INTERVAL_MS - 1000).toISOString()
    });

    // 任务 B（最新）直接完成：lastTaskId 指向已终态任务
    const inboundB = chatService.ingest({
      connectionId: connection.id,
      chatId: binding.chatId,
      chatType: 'direct',
      sender: '张三',
      text: '任务B'
    });
    taskService.succeed(inboundB.taskId, { summary: 'B 完成' });
    expect(db.find('chatbindings', binding.id).lastTaskId).toBe(inboundB.taskId);

    // 旧逻辑只认 lastTaskId（B，已终态）→ 误报"没有等待操作的任务"；现在应答到更早的 A
    const answered = chatService.answerPendingAction(binding.id, '补充内容');
    expect(answered.taskId).toBe(inboundA.taskId);
    expect(db.find('tasks', inboundA.taskId).status).toBe('running');
  });

  test('answerPendingAction：多个等待任务并存时先应答最新创建的一个（BUG-24）', () => {
    const worker = workerService.createWorker({ name: '多在途回流' });
    const connection = chatService.createConnection({ platform: 'mock', name: `多在途连接 ${Date.now()}` });
    const binding = chatService.createBinding({
      connectionId: connection.id,
      chatId: `${connection.id}:direct-multi`,
      chatName: '多在途',
      workerId: worker.id
    });
    const options = [
      { value: 'amount', label: '按金额' },
      { value: 'count', label: '按条数' }
    ];

    const first = chatService.ingest({
      connectionId: connection.id,
      chatId: binding.chatId,
      chatType: 'direct',
      sender: '张三',
      text: '先问的任务'
    });
    taskService.requestAction(first.taskId, { type: 'selection', title: '口径一', options, defaultValue: 'amount' });
    // 节流锚点回拨到窗口之外（A3 节流落地后连续建任务需绕开最小间隔）
    db.update('chatbindings', binding.id, {
      lastMessageAt: new Date(Date.now() - chatService.CHAT_TASK_MIN_INTERVAL_MS - 1000).toISOString()
    });
    const second = chatService.ingest({
      connectionId: connection.id,
      chatId: binding.chatId,
      chatType: 'direct',
      sender: '张三',
      text: '后问的任务'
    });
    taskService.requestAction(second.taskId, { type: 'selection', title: '口径二', options, defaultValue: 'amount' });

    // 两个任务可能在同一毫秒内创建，createdAt 打平时「最新」排序不稳定：
    // 显式回拨 first 的 createdAt，让 answerPendingAction 的"回复最新请求"口径可确定断言
    db.update('tasks', first.taskId, { createdAt: new Date(Date.now() - 60 * 1000).toISOString() });

    // 第一次回复命中最新（second），第二次回复才轮到 first——与其余入口"回复最新请求"心智一致
    const answerLatest = chatService.answerPendingAction(binding.id, '按金额');
    expect(answerLatest.taskId).toBe(second.taskId);
    const answerOlder = chatService.answerPendingAction(binding.id, '按条数');
    expect(answerOlder.taskId).toBe(first.taskId);
  });
});

describe('chat-service：接入申请保留期清理（E5）', () => {
  let tempDir;
  let connection;
  let workerId;

  beforeAll(() => {
    tempDir = initTempDb();
    workerId = workerService.createWorker({ name: '清理审批员', role: '数据分析' }).id;
    connection = chatService.createConnection({ platform: 'mock', name: '清理测试连接' });
  });

  afterAll(() => {
    db.flush();
    cleanupTempDb(tempDir);
  });

  test('已处理且超出保留期的申请被清理，挂起中的永不清理，重复执行幂等', () => {
    const approved = chatService.ingest({
      connectionId: connection.id, chatId: 'chat-purge-a', chatName: '审批群A', chatType: 'group', text: '申请A'
    });
    const rejected = chatService.ingest({
      connectionId: connection.id, chatId: 'chat-purge-b', chatName: '审批群B', chatType: 'group', text: '申请B'
    });
    const pending = chatService.ingest({
      connectionId: connection.id, chatId: 'chat-purge-c', chatName: '审批群C', chatType: 'group', text: '申请C'
    });
    chatService.approveRequest(approved.requestId, { workerId });
    chatService.rejectRequest(rejected.requestId);

    // 回拨已处理申请的 resolvedAt 到保留期之外
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.update('chatrequests', approved.requestId, { resolvedAt: old });
    db.update('chatrequests', rejected.requestId, { resolvedAt: old });

    const { removed, retention } = chatService.purgeExpiredRequests(90);
    expect(retention).toBe(90);
    expect(removed).toBe(2); // 已同意 + 已拒绝
    expect(db.find('chatrequests', pending.requestId)).not.toBeNull(); // 挂起中的不受清理影响

    expect(chatService.purgeExpiredRequests(90).removed).toBe(0); // 幂等
  });
});

describe('批次一修复回归（A9）', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = initTempDb();
  });

  afterAll(() => {
    db.flush();
    cleanupTempDb(tempDir);
  });

  test('parseMention 支持含空格的 Worker 整名 @（BUG-36）', () => {
    const parsed = chatService.parseMention('@数据分析 小王 请整理本周数据', '数据分析 小王');
    expect(parsed.aimed).toBe(true);
    expect(parsed.goal).toBe('请整理本周数据');

    // 通用点名仍走原路径；部分名字不命中（与原语义一致：必须 @ 完整名字）
    expect(chatService.parseMention('@Worker 干活', '数据分析 小王').aimed).toBe(true);
    expect(chatService.parseMention('@小王 开会', '数据分析 小王').aimed).toBe(false);
  });

  test('聊天应答与任务应答口径统一：selection 无选项时回退自由文本（F1 收编闭环）', () => {
    const worker = workerService.createWorker({ name: '口径执行者' });
    const connection = chatService.createConnection({ platform: 'mock', name: `口径连接 ${Date.now()}` });
    const binding = chatService.createBinding({
      connectionId: connection.id,
      chatId: 'chat-a9-answer',
      chatName: '口径测试群',
      workerId: worker.id
    });
    const task = taskService.create({
      goal: '口径确认目标',
      assigneeId: worker.id,
      trigger: { type: 'chat', refId: binding.id }
    });
    db.update('tasks', task.id, {
      status: 'need_action',
      actionRequest: {
        id: 'ar_a9',
        taskId: task.id,
        type: 'selection',
        title: '确认口径',
        options: [],
        defaultValue: null,
        answer: null,
        createdAt: nowIso(),
        answeredAt: null
      }
    });

    // 修复前：聊天侧自行匹配选项，无选项 + 自由文本直接抛「请回复有效选项」，
    // 而应用内同一输入可通过——两端口径分裂。修复后统一走 taskService.normalizeAnswer
    const result = chatService.answerPendingAction(binding.id, '就按方案二执行');
    expect(result.answer.value).toBe('就按方案二执行');
  });

  test('审批幂等：绑定被删后可重新审批开通（BUG-35）', () => {
    const worker = workerService.createWorker({ name: '重审批执行者' });
    const connection = chatService.createConnection({ platform: 'mock', name: `重审批连接 ${Date.now()}` });

    // 未绑定聊天先产生接入申请
    const ingest = chatService.ingest({
      connectionId: connection.id,
      chatId: 'chat-a9-reapprove',
      chatName: '重审批群',
      chatType: 'group',
      sender: '同事',
      text: '@Worker 帮忙'
    });
    expect(ingest.kind).toBe('request_created');

    const first = chatService.approveRequest(ingest.requestId, { workerId: worker.id });
    expect(first.binding.id).toMatch(/^cb_/);

    // 删除绑定后再审批：修复前抛「该申请已处理」，申请永久卡死只能走向导绕行
    chatService.removeBinding(first.binding.id);
    const second = chatService.approveRequest(ingest.requestId, { workerId: worker.id });
    expect(second.binding.id).not.toBe(first.binding.id);
    expect(second.request.status).toBe('approved');
  });
});
