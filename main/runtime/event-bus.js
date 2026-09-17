/**
 * 事件总线
 * - emit / on：面向渲染层的事件广播（由 IPC 层转发到窗口）
 * - command / onCommand：主进程内部指令通道（如「任务已创建→触发派发」），不跨进程传输
 */

const rendererListeners = new Set();
const commandHandlers = new Map();

function on(listener) {
  rendererListeners.add(listener);
  return () => rendererListeners.delete(listener);
}

function emit(type, payload) {
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
      handler(payload);
    } catch (error) {
      console.error('[bus] 指令处理失败:', type, error);
    }
  });
}

module.exports = { on, emit, onCommand, command };