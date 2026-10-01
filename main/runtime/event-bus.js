/**
 * 事件总线
 * - emit / on：面向渲染层的事件广播（由 IPC 层转发到窗口）
 *   on(listener)            全局订阅：listener({ type, payload })
 *   on(type, listener)      按类型订阅（O17）：listener(payload)，事件量大时免于全量过滤
 * - command / onCommand：主进程内部指令通道（如「任务已创建→触发派发」），不跨进程传输
 */

const rendererListeners = new Set();
const typedListeners = new Map(); // type → Set<listener>
const commandHandlers = new Map();

function on(typeOrListener, maybeListener) {
  // 兼容全局订阅：on(fn)
  if (typeof typeOrListener === 'function') {
    const listener = typeOrListener;
    rendererListeners.add(listener);
    return () => rendererListeners.delete(listener);
  }
  // 按类型订阅：on(type, fn)
  const type = typeOrListener;
  const listener = maybeListener;
  if (!typedListeners.has(type)) typedListeners.set(type, new Set());
  typedListeners.get(type).add(listener);
  return () => typedListeners.get(type)?.delete(listener);
}

function emit(type, payload) {
  const typed = typedListeners.get(type);
  if (typed) {
    typed.forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        console.error('[bus] 事件处理失败:', type, error);
      }
    });
  }
  rendererListeners.forEach((listener) => {
    try {
      listener({ type, payload });
    } catch (error) {
      console.error('[bus] 事件处理失败:', type, error);
    }
  });
}

function onCommand(type, handler) {
  if (!commandHandlers.has(type)) commandHandlers.set(type, new Set());
  commandHandlers.get(type).add(handler);
  return () => commandHandlers.get(type)?.delete(handler);
}

function command(type, payload) {
  const handlers = commandHandlers.get(type);
  if (!handlers) return;
  handlers.forEach((handler) => {
    try {
      const result = handler(payload);
      // 兼容 async 指令处理器（如 runtime.dispatch 已异步化）：
      // 同步 try/catch 捕获不到 Promise 拒绝，放任不管会成为 unhandledRejection（日志层会记为 FATAL）
      if (result && typeof result.catch === 'function') {
        result.catch((error) => console.error('[bus] 指令处理失败:', type, error));
      }
    } catch (error) {
      console.error('[bus] 指令处理失败:', type, error);
    }
  });
}

module.exports = { on, emit, onCommand, command };