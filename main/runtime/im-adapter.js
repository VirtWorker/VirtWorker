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
 *
 * 入站消息不经过适配器接口：统一由 chat-service.ingest() 收敛，
 * 真实适配器（Webhook / 长连接）收到事件后调用同一入口，保证解析与建任务逻辑单点维护。
 */

/** @type {Map<string, object>} */
const adapters = new Map();

function validate(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('IM 适配器必须是对象');
  if (!adapter.key) throw new Error('IM 适配器必须提供 key 标识');
  if (typeof adapter.listChats !== 'function') throw new Error(`IM 适配器「${adapter.key}」缺少 listChats 方法`);
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
  }
});

module.exports = { register, resolve, registeredKeys, mockAdapter };
