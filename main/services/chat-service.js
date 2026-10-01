/**
 * @Worker（会话接入）领域服务
 * 职责：IM 连接管理（凭据经安全保险箱加密）、聊天接入申请审批、聊天绑定 CRUD、
 *       会话消息接入（解析 @ 提及 → 统一创建 chat 触发任务）与统计。
 * 说明：与自动化服务同理，本服务只负责「配置与解析」，任务执行共用 task-service / task-runtime 链路；
 *       入站消息统一走 ingest() 单一入口，mock 适配器与未来的真实平台适配器（Webhook/长连接）都汇到这里。
 */

const db = require('../store/db');
const bus = require('../runtime/event-bus');
const imAdapter = require('../runtime/im-adapter');
const vault = require('../util/secret-vault');
const taskService = require('./task-service');
const { createId } = require('../util/id');
const { requiredText, assertUniqueName } = require('../util/validate');
const { nowIso } = require('../util/time');
const { fail } = require('../util/errors');

/** 平台目录：available=false 的平台目录可见但暂不可创建（真实适配器后续版本接入） */
const PLATFORM_CATALOG = [
  { key: 'mock', label: '模拟 IM（内置）', requiresCredential: false, available: true },
  { key: 'feishu', label: '飞书', requiresCredential: true, available: false },
  { key: 'dingtalk', label: '钉钉', requiresCredential: true, available: false },
  { key: 'wecom', label: '企业微信', requiresCredential: true, available: false },
  { key: 'slack', label: 'Slack', requiresCredential: true, available: false }
];

const CHAT_TYPES = ['group', 'direct'];
const CHAT_TYPE_LABEL = { group: '群聊', direct: '单聊' };
const REQUEST_STATUS = { pending: 'pending', approved: 'approved', rejected: 'rejected' };

/** @ 提及匹配：@ 后跟 1-20 个非空白字符（与 Worker 名称长度上限一致） */
const MENTION_RE = /@([^\s@]{1,20})/g;
/** 群聊中的通用 @ 点名（不指定具体 Worker 时视为呼叫绑定的 Worker） */
const GENERIC_MENTION = 'Worker';

const MAX_TEXT = 2000;
const MAX_GOAL = 500;

// ==================== 内部工具 ====================

/** 原始集合读取（不做装饰与过滤），对应 automation-service 的 listAll 约定 */
function allConnections() {
  return db.all('chatconnections');
}

function allRequests() {
  return db.all('chatrequests');
}

function allBindings() {
  return db.all('chatbindings');
}

function getConnection(id) {
  return db.find('chatconnections', id);
}

function connectionOrThrow(id) {
  const connection = getConnection(id);
  if (!connection) throw fail.notFound('IM 连接不存在');
  return connection;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 归一化模型名：留空取默认；真实 LLM 执行器接入后按此字段路由模型 */
function normalizeModel(model) {
  const value = String(model ?? '').trim();
  if (!value) return '默认';
  return value.slice(0, 40);
}

/**
 * 解析群聊消息中的 @ 提及：
 * 命中通用点名（@Worker）或绑定 Worker 的名字 → aimed=true，并从文本中剥离该提及得到任务目标。
 */
function parseMention(text, workerName) {
  const targets = [];
  MENTION_RE.lastIndex = 0;
  let match;
  while ((match = MENTION_RE.exec(text))) targets.push(match[1]);
  const hit = targets.find((name) => name === GENERIC_MENTION || (workerName && name === workerName));
  if (!hit) return { aimed: false, goal: text };
  const stripped = text.replace(new RegExp(`@${escapeRegExp(hit)}`, 'g'), '');
  return { aimed: true, goal: stripped.replace(/\s+/g, ' ').trim() };
}

// ==================== 装饰（对外输出） ====================

function decorateConnection(connection) {
  const platform = PLATFORM_CATALOG.find((item) => item.key === connection.platform);
  return {
    ...connection,
    credential: undefined,
    platformLabel: platform ? platform.label : connection.platform,
    receiveSupported: Boolean(imAdapter.resolve(connection.platform)?.receiveSupported(connection)),
    credentialMask: connection.credential ? connection.credential.mask : '',
    encrypted: Boolean(connection.credential && connection.credential.sealed.mode === 'encrypted')
  };
}

function decorateBinding(binding) {
  const connection = getConnection(binding.connectionId);
  const worker = db.find('workers', binding.workerId);
  return {
    ...binding,
    connectionName: connection ? connection.name : '（连接已删除）',
    workerName: worker ? worker.name : '（Worker 已删除）',
    chatTypeLabel: CHAT_TYPE_LABEL[binding.chatType] || binding.chatType,
    /** 健康态结构化输出：渲染层不再依赖「（已删除）」文案反推 */
    healthy: Boolean(connection && worker)
  };
}

function decorateRequest(request) {
  const connection = getConnection(request.connectionId);
  return {
    ...request,
    connectionName: connection ? connection.name : '（连接已删除）',
    chatTypeLabel: CHAT_TYPE_LABEL[request.chatType] || request.chatType
  };
}

function publish(eventType, payload) {
  bus.emit(eventType, payload);
}

// ==================== IM 连接 ====================

function platformCatalog() {
  return PLATFORM_CATALOG.map((item) => ({ ...item }));
}

function createConnection(params = {}) {
  const platform = PLATFORM_CATALOG.find((item) => item.key === params.platform);
  if (!platform) throw fail.validation('请选择 IM 平台');
  if (!platform.available) throw fail.validation(`${platform.label}适配器将在后续版本接入，当前请使用模拟 IM`);

  const name = requiredText(params.name, { label: '连接名称', max: 40 });
  assertUniqueName(allConnections(), name, { label: '连接' });

  let credential = null;
  if (platform.requiresCredential) {
    const secret = String(params.secret ?? '').trim();
    if (!secret) throw fail.validation('请填写访问凭据');
    if (secret.length > 2048) throw fail.validation('凭据长度超出限制');
    const sealed = vault.seal(secret);
    credential = { sealed, mask: vault.mask(secret), mode: sealed.mode };
    // 系统密钥链不可用时凭据仅做 base64 编码（伪加密），必须让用户知情
    if (sealed.mode !== 'encrypted') console.warn('[chat] 系统密钥链不可用，凭据将以 base64 形式保存');
  }

  const connection = {
    id: createId('imc'),
    platform: platform.key,
    name,
    credential,
    status: 'connected',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  db.insert('chatconnections', connection);
  publish('chat:connection-created', decorateConnection(connection));
  return decorateConnection(connection);
}

function updateConnection(id, patch = {}) {
  const connection = connectionOrThrow(id);
  const next = { ...connection };

  if (patch.name !== undefined) {
    const name = requiredText(patch.name, { label: '连接名称', max: 40 });
    assertUniqueName(allConnections(), name, { label: '连接', exceptId: id });
    next.name = name;
  }
  // 凭据轮换：仅在提供非空新凭据时更换（换 Token 不必删连接重建，避免丢失全部聊天绑定）
  const secret = String(patch.secret ?? '').trim();
  if (secret) {
    const platform = PLATFORM_CATALOG.find((item) => item.key === connection.platform);
    if (!platform?.requiresCredential) throw fail.validation('该平台无需访问凭据');
    if (secret.length > 2048) throw fail.validation('凭据长度超出限制');
    const sealed = vault.seal(secret);
    next.credential = { sealed, mask: vault.mask(secret), mode: sealed.mode };
    if (sealed.mode !== 'encrypted') console.warn('[chat] 系统密钥链不可用，凭据将以 base64 形式保存');
  }
  next.updatedAt = nowIso();
  db.update('chatconnections', id, next);
  publish('chat:connection-updated', decorateConnection(next));
  return decorateConnection(next);
}

/** 删除连接：级联清理该连接下的绑定与申请，避免悬挂引用 */
function removeConnection(id) {
  connectionOrThrow(id);
  db.remove('chatconnections', id);
  const removedBindings = db.removeWhere('chatbindings', (item) => item.connectionId === id);
  db.removeWhere('chatrequests', (item) => item.connectionId === id);
  publish('chat:connection-removed', { id });
  if (removedBindings.removed) publish('chat:binding-removed', { connectionId: id, cascade: removedBindings.removed });
  return { id, removedBindings: removedBindings.removed };
}

/** 拉取连接下可选聊天（委托平台适配器；平台未注册时返回空并给出原因） */
function listChats(connectionId) {
  const connection = connectionOrThrow(connectionId);
  const adapter = imAdapter.resolve(connection.platform);
  if (!adapter) {
    return { chats: [], supported: false, reason: `${connection.platform} 平台适配器未注册` };
  }
  return { chats: adapter.listChats(connection), supported: Boolean(adapter.receiveSupported(connection)), reason: '' };
}

// ==================== 聊天绑定 ====================

/** 校验并解析绑定/审批共用的执行者：仅允许单个 Worker（会话协作主体） */
function resolveWorker(workerId) {
  const assignee = taskService.resolveAssignee(workerId);
  if (assignee.type !== 'worker') throw fail.validation('聊天绑定只能选择单个 Worker');
  return assignee;
}

/** 归一化聊天标识入参（开通向导手填聊天时使用） */
function normalizeChat({ chatId, chatName, chatType }) {
  const id = String(chatId ?? '').trim();
  if (!id) throw fail.validation('请选择或填写要开通的聊天');
  if (id.length > 120) throw fail.validation('聊天标识最多 120 个字符');
  const name = String(chatName ?? '').trim().slice(0, 60) || id.slice(0, 60);
  return { chatId: id, chatName: name, chatType: CHAT_TYPES.includes(chatType) ? chatType : 'group' };
}

function assertChatFree(connectionId, chatId, exceptBindingId = null) {
  const clash = allBindings().find(
    (item) => item.connectionId === connectionId && item.chatId === chatId && item.id !== exceptBindingId
  );
  if (clash) throw fail.conflict('该聊天已开通 @Worker，一个聊天只能绑定一个 Worker');
}

function createBinding(params = {}) {
  const connection = connectionOrThrow(params.connectionId);
  const chat = normalizeChat(params);
  assertChatFree(connection.id, chat.chatId);
  const worker = resolveWorker(params.workerId);

  const binding = {
    id: createId('cb'),
    connectionId: connection.id,
    chatId: chat.chatId,
    chatName: chat.chatName,
    chatType: chat.chatType,
    workerId: worker.id,
    workspace: String(params.workspace ?? '').trim().slice(0, 300),
    model: normalizeModel(params.model),
    enabled: params.enabled === undefined ? true : Boolean(params.enabled),
    lastMessageAt: null,
    lastTaskId: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  db.insert('chatbindings', binding);
  publish('chat:binding-created', decorateBinding(binding));
  return decorateBinding(binding);
}

function getBindingOrThrow(id) {
  const binding = db.find('chatbindings', id);
  if (!binding) throw fail.notFound('聊天绑定不存在');
  return binding;
}

function updateBinding(id, patch = {}) {
  const binding = getBindingOrThrow(id);
  const next = { ...binding };

  if (patch.workerId !== undefined) {
    const worker = resolveWorker(patch.workerId);
    next.workerId = worker.id;
  }
  if (patch.workspace !== undefined) next.workspace = String(patch.workspace).trim().slice(0, 300);
  if (patch.model !== undefined) next.model = normalizeModel(patch.model);
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  next.updatedAt = nowIso();

  db.update('chatbindings', id, next);
  publish('chat:binding-updated', decorateBinding(next));
  return decorateBinding(next);
}

function toggleBinding(id, enabled) {
  return updateBinding(id, { enabled });
}

function removeBinding(id) {
  getBindingOrThrow(id);
  db.remove('chatbindings', id);
  publish('chat:binding-removed', { id });
  return { id };
}

/** 级联：删除 Worker 时清理其聊天绑定（worker-service.removeWorker 调用），
 *  否则悬空 workerId 会让该聊天的每条入站消息在建任务时撞 NOT_FOUND */
function removeBindingsByWorker(workerId) {
  const removed = db.removeWhere('chatbindings', (item) => item.workerId === workerId);
  if (removed.removed) publish('chat:binding-removed', { workerId, cascade: removed.removed });
  return removed.removed;
}

/** 列表查询（与 automation-service.list 同约定）：空 filter 返回全量装饰结果 */
function listBindings(filter = {}) {
  let items = allBindings().map(decorateBinding);
  const keyword = String(filter.keyword ?? '').trim().toLowerCase();
  if (keyword) {
    items = items.filter((item) =>
      `${item.chatName} ${item.connectionName} ${item.workerName} ${item.model}`.toLowerCase().includes(keyword)
    );
  }
  if (CHAT_TYPES.includes(filter.chatType)) items = items.filter((item) => item.chatType === filter.chatType);
  const model = String(filter.model ?? '').trim();
  if (model) items = items.filter((item) => item.model === model);
  // 状态筛选枚举（O12）：'' = 全部，'enabled' / 'disabled'
  if (filter.status === 'enabled') items = items.filter((item) => item.enabled);
  if (filter.status === 'disabled') items = items.filter((item) => !item.enabled);

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items, total: items.length };
}

// ==================== 接入申请 ====================

/** 申请列表查询：空 filter 返回全量装饰结果 */
function listRequests(filter = {}) {
  let items = allRequests().map(decorateRequest);
  const status = REQUEST_STATUS[filter.status] ? filter.status : null;
  if (status) items = items.filter((item) => item.status === status);
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items, total: items.length };
}

/** 收到未绑定聊天的消息 → 记录接入申请（同一聊天挂起中的申请只保留一条并刷新信息） */
function upsertPendingRequest({ connectionId, chat, sender, text }) {
  const existing = allRequests().find(
    (item) => item.connectionId === connectionId && item.chatId === chat.chatId && item.status === REQUEST_STATUS.pending
  );
  if (existing) {
    const next = { ...existing, chatName: chat.chatName, sender, message: text, updatedAt: nowIso() };
    db.update('chatrequests', existing.id, next);
    const decorated = decorateRequest(next);
    // 更新已存在的挂起申请同样广播，否则审批列表停留在首次内容
    publish('chat:request-updated', decorated);
    return decorated;
  }
  const request = {
    id: createId('car'),
    connectionId,
    chatId: chat.chatId,
    chatName: chat.chatName,
    chatType: chat.chatType,
    sender,
    message: text,
    status: REQUEST_STATUS.pending,
    bindingId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    resolvedAt: null
  };
  db.insert('chatrequests', request);
  const decorated = decorateRequest(request);
  publish('chat:request-created', decorated);
  publish('app:notice', { level: 'info', title: '收到聊天接入申请', body: `「${chat.chatName}」申请接入 @Worker` });
  return decorated;
}

function approveRequest(id, params = {}) {
  const request = db.find('chatrequests', id);
  if (!request) throw fail.notFound('接入申请不存在');

  // 幂等（O13）：重复审批同一申请（绑定已生成）直接返回既有结果，
  // 而不是撞「该聊天已开通」的 CONFLICT 让用户以为操作失败
  if (request.status === REQUEST_STATUS.approved && request.bindingId) {
    const existing = db.find('chatbindings', request.bindingId);
    if (existing) return { request: decorateRequest(request), binding: existing };
  }
  if (request.status !== REQUEST_STATUS.pending) throw fail.invalidState('该申请已处理，请刷新列表');

  // 同意即开通：直接生成绑定；聊天已被占用（如先经向导开通）时按冲突提示
  assertChatFree(request.connectionId, request.chatId);
  const binding = createBinding({
    connectionId: request.connectionId,
    chatId: request.chatId,
    chatName: request.chatName,
    chatType: request.chatType,
    workerId: params.workerId,
    workspace: params.workspace,
    model: params.model
  });

  // 两步写补偿（O13）：申请状态更新失败时回滚绑定，
  // 避免「绑定已生效、申请仍 pending」且重试必撞 CONFLICT 的卡死状态
  let next;
  try {
    next = {
      ...request,
      status: REQUEST_STATUS.approved,
      bindingId: binding.id,
      resolvedAt: nowIso()
    };
    db.update('chatrequests', id, next);
  } catch (error) {
    try {
      removeBinding(binding.id);
    } catch (rollbackError) {
      console.error('[chat] 审批失败回滚绑定异常:', rollbackError.message || rollbackError);
    }
    throw error;
  }
  publish('chat:request-resolved', decorateRequest(next));
  return { request: decorateRequest(next), binding };
}

function rejectRequest(id) {
  const request = db.find('chatrequests', id);
  if (!request) throw fail.notFound('接入申请不存在');
  if (request.status !== REQUEST_STATUS.pending) throw fail.invalidState('该申请已处理，请刷新列表');
  const next = { ...request, status: REQUEST_STATUS.rejected, resolvedAt: nowIso() };
  db.update('chatrequests', id, next);
  publish('chat:request-resolved', decorateRequest(next));
  return decorateRequest(next);
}

// ==================== 会话消息接入（统一入口） ====================

/**
 * 接收一条 IM 消息并按绑定情况分流：
 * - 聊天未绑定 → 记录接入申请（待审批）；
 * - 绑定已停用 → 忽略（不建任务、不报错）；
 * - 群聊未 @ 提及绑定 Worker（或 @Worker）→ 忽略；单聊默认所有消息都交给 Worker；
 * - 命中 → 解析目标后经 task-service.create 创建会话触发任务，进入统一看板。
 */
function ingest(params = {}) {
  const connection = connectionOrThrow(params.connectionId);
  const chat = normalizeChat({
    chatId: params.chatId,
    chatName: params.chatName,
    chatType: params.chatType
  });
  const text = String(params.text ?? '').trim();
  if (!text) throw fail.validation('消息内容不能为空');
  if (text.length > MAX_TEXT) throw fail.validation(`消息内容最多 ${MAX_TEXT} 字`);
  const sender = String(params.sender ?? '').trim().slice(0, 40) || '同事';

  const binding = allBindings().find((item) => item.connectionId === connection.id && item.chatId === chat.chatId);
  if (!binding) {
    const request = upsertPendingRequest({ connectionId: connection.id, chat, sender, text });
    return { kind: 'request_created', requestId: request.id, request };
  }
  if (!binding.enabled) {
    return { kind: 'skipped', reason: 'binding_disabled', message: '该聊天已停用 @Worker，消息已忽略' };
  }

  const worker = db.find('workers', binding.workerId);
  let goal = text;
  if (chat.chatType === 'group') {
    const parsed = parseMention(text, worker ? worker.name : '');
    if (!parsed.aimed) return { kind: 'skipped', reason: 'no_mention', message: '群聊消息未 @ 绑定的 Worker，已忽略' };
    goal = parsed.goal;
  }
  if (!goal) return { kind: 'skipped', reason: 'empty_goal', message: '消息中没有可执行的内容，已忽略' };
  if (goal.length > MAX_GOAL) goal = goal.slice(0, MAX_GOAL);

  const task = taskService.create({
    title: goal.slice(0, 24),
    goal,
    assigneeId: binding.workerId,
    workspace: binding.workspace,
    trigger: { type: 'chat', refId: binding.id },
    payload: {
      source: 'im',
      connectionId: connection.id,
      connectionName: connection.name,
      chatId: chat.chatId,
      chatName: chat.chatName,
      chatType: chat.chatType,
      sender
    }
  });

  db.update('chatbindings', binding.id, {
    lastMessageAt: nowIso(),
    lastTaskId: task.id,
    updatedAt: nowIso()
  });
  publish('chat:message', { bindingId: binding.id, taskId: task.id, chatName: chat.chatName });
  return { kind: 'task_created', taskId: task.id, task };
}

// ==================== 统计 ====================

function stats() {
  const bindings = allBindings();
  return {
    connections: allConnections().length,
    bindings: bindings.length,
    enabled: bindings.filter((item) => item.enabled).length,
    pendingRequests: allRequests().filter((item) => item.status === REQUEST_STATUS.pending).length
  };
}

// ==================== 出站回执与应答回流（F3） ====================

let notifierWired = false;

/** 订阅任务事件并把回执推送到聊天（幂等，main.js 启动时调用一次） */
function startNotifier() {
  if (notifierWired) return;
  notifierWired = true;
  bus.onCommand('task:action-requested', (payload) => {
    try {
      notifyTaskEvent(payload);
    } catch (error) {
      console.warn('[chat] 操作请求回执推送失败:', error.message || error);
    }
  });
  bus.onCommand('task:finished', (payload) => {
    try {
      notifyTaskEvent(payload);
    } catch (error) {
      console.warn('[chat] 终态回执推送失败:', error.message || error);
    }
  });
}

/** 解析聊天来源任务对应的绑定 / 连接 / 适配器；非聊天任务或链路不可用返回 null */
function resolveOutboundTarget(taskId) {
  const task = db.find('tasks', taskId);
  if (!task || task.trigger.type !== 'chat') return null;
  const binding = db.find('chatbindings', task.trigger.refId);
  if (!binding || !binding.enabled) return null;
  const connection = db.find('chatconnections', binding.connectionId);
  if (!connection) return null;
  const adapter = imAdapter.resolve(connection.platform);
  if (!adapter || typeof adapter.sendMessage !== 'function') return null;
  return { task, binding, connection, adapter };
}

/** 出站回执：need_action 推送操作请求（支持交互卡片的平台走 deliverAction），终态推送结果摘要 */
function notifyTaskEvent(payload = {}) {
  const target = resolveOutboundTarget(payload.taskId);
  if (!target) return;
  const { task, binding, connection, adapter } = target;

  // need_action：推送操作请求（支持交互卡片的平台走 deliverAction）
  if (task.status === taskService.STATUS.needAction) {
    const request = task.actionRequest;
    if (!request) return;
    if (typeof adapter.deliverAction === 'function') {
      adapter.deliverAction(connection, binding.chatId, request);
    } else {
      adapter.sendMessage(connection, binding.chatId, `【需要操作】${request.title}——请在 VirtWorker 中处理`);
    }
    return;
  }

  // 终态：推送结果摘要（canceled 不推送——用户自己取消的无须回执）
  let content;
  if (task.status === taskService.STATUS.succeeded) {
    content = `「${task.title}」已完成：${task.result?.summary || '结果已生成，请在 VirtWorker 中查收'}`;
  } else if (task.status === taskService.STATUS.failed) {
    content = `「${task.title}」执行失败：${task.error?.message || '未知原因'}`;
  } else {
    return;
  }
  adapter.sendMessage(connection, binding.chatId, content);
}

/**
 * 应答回流（F3）：把聊天中的回复映射为该绑定在途任务的 need_action 应答。
 * 选项类请求按 label/value 精确匹配，自由文本作为回答内容；
 * 真实平台适配器在收到交互卡片回复 / 定向回复时调用，无在途操作请求时抛错提示。
 */
function answerPendingAction(bindingId, text) {
  const binding = db.find('chatbindings', bindingId);
  if (!binding) throw fail.notFound('聊天绑定不存在');
  const task = db.find('tasks', binding.lastTaskId);
  if (!task || task.status !== taskService.STATUS.needAction) {
    throw fail.invalidState('该聊天当前没有等待操作的任务');
  }
  const request = task.actionRequest;
  const value = String(text ?? '').trim();
  if (!value) throw fail.validation('请填写回复内容');
  let answer;
  if (request.type === 'selection' || request.type === 'confirm') {
    const option = (request.options || []).find((item) => item.value === value || item.label === value);
    if (!option) {
      throw fail.validation(`请回复有效选项：${(request.options || []).map((item) => item.label).join(' / ')}`);
    }
    answer = { value: option.value };
  } else {
    answer = { value: value.slice(0, 500) };
  }
  const result = taskService.answer({ taskId: task.id, answer });
  bus.emit('chat:answered', { bindingId: binding.id, taskId: task.id });
  return { taskId: task.id, answer: result.actionRequest.answer };
}

module.exports = {
  CHAT_TYPE_LABEL,
  GENERIC_MENTION,
  parseMention,
  platformCatalog,
  listChats,
  startNotifier,
  answerPendingAction,
  listConnections: () => allConnections().map(decorateConnection),
  createConnection,
  updateConnection,
  removeConnection,
  listBindings,
  createBinding,
  updateBinding,
  toggleBinding,
  removeBinding,
  removeBindingsByWorker,
  listRequests,
  approveRequest,
  rejectRequest,
  ingest,
  stats
};
