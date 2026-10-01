/**
 * IM 适配器注册中心：定义 chat-service 与 IM 平台适配器之间的统一接口契约。
 *
 * 与 executor 注册中心同构：Alpha 阶段仅内置 mock 适配器（可演示、可控），
 * 接入真实平台（飞书 / 钉钉 / Slack 等）时实现同一契约后 register() 即可，无需改动上层。
 *
 * 接口契约：
 * - key: string                    适配器唯一标识，与 IMConnection.platform 对应
 * - label: string                  平台展示名
 * - listChats(connection)          拉取该连接下可选的聊天列表 → [{ chatId, chatName, chatType }]
 *                                  chatType: 'group' 群聊 | 'direct' 单聊
 * - receiveSupported(connection)   该连接当前能否接收入站消息（mock 恒为 true）
 * - sendMessage(connection, chatId, content)        出站文本消息（F3 双向回执，必须实现）
 * - deliverAction?(connection, chatId, request)     出站操作请求（need_action 推送；
 *                                  平台支持交互卡片时实现，缺省降级为 sendMessage 文本）
 *
 * 入站消息不经过适配器接口：统一由 chat-service.ingest() 收敛，
 * 真实适配器（Webhook / 长连接）收到事件后调用同一入口，保证解析与建任务逻辑单点维护；
 * 聊天内对操作请求的应答由适配器映射后调用 chatService.answerPendingAction() 回流（F3）。
 */

const { createId } = require('../util/id');
const { nowIso } = require('../util/time');

/** @type {Map<string, object>} */
const adapters = new Map();

function validate(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('IM 适配器必须是对象');
  if (!adapter.key) throw new Error('IM 适配器必须提供 key 标识');
  const required = ['listChats', 'sendMessage'];
  const missing = required.filter((method) => typeof adapter[method] !== 'function');
  if (missing.length) throw new Error(`IM 适配器「${adapter.key}」缺少方法：${missing.join('、')}`);
}

function register(adapter) {
  validate(adapter);
  adapters.set(adapter.key, adapter);
  return adapter;
}

/** 按平台取适配器；未注册的平台返回 null，由调用方决定降级行为 */
function resolve(platform) {
  return adapters.get(platform) || null;
}

function registeredKeys() {
  return [...adapters.keys()];
}

/** 出站消息存根（mock）：真实适配器调用平台 API 发送；mock 记入内存 outbox 供演示与测试断言 */
const outbox = [];

function listOutbox(connectionId) {
  const items = connectionId ? outbox.filter((message) => message.connectionId === connectionId) : [...outbox];
  return items;
}

function clearOutbox() {
  outbox.length = 0;
}

function mockSend(connection, chatId, content) {
  const message = {
    id: createId('im'),
    connectionId: connection?.id || '',
    chatId: String(chatId ?? ''),
    content: String(content ?? '').slice(0, 2000),
    at: nowIso()
  };
  outbox.push(message);
  return message;
}

/** 内置模拟适配器：按连接生成稳定的演示聊天列表（同一连接多次拉取结果一致） */
const mockAdapter = register({
  key: 'mock',
  label: '模拟 IM',
  listChats(connection) {
    const suffix = String(connection?.name || '').trim();
    return [
      { chatId: `${connection.id}:group-dev`, chatName: suffix ? `产品研发群（${suffix}）` : '产品研发群', chatType: 'group' },
      { chatId: `${connection.id}:group-feedback`, chatName: '客户反馈交流群', chatType: 'group' },
      { chatId: `${connection.id}:direct-zhang`, chatName: '张三', chatType: 'direct' }
    ];
  },
  receiveSupported() {
    return true;
  },
  sendMessage(connection, chatId, content) {
    return mockSend(connection, chatId, content);
  },
  deliverAction(connection, chatId, actionRequest) {
    const options = (actionRequest.options || []).map((option) => option.label).join(' / ');
    const content = `【需要操作】${actionRequest.title}${options ? `（回复：${options}）` : ''}`;
    return mockSend(connection, chatId, content);
  }
});

module.exports = { register, resolve, registeredKeys, mockAdapter, listOutbox, clearOutbox };
