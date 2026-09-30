/**
 * 轻提示组件
 * 每条提示独立计时：新提示不会打断旧提示的显示，多条并发时依次排队展示，
 * 避免共用单个定时器导致互相覆盖（后到的提示会立刻顶掉前一条）。
 * 级别（23）：error 提示更长时延、role=alert、可手动关闭；warn 黄色短延；info 默认。
 */
window.VW = window.VW || {};

VW.toast = (() => {
  const DURATION = 2200;
  const ERROR_DURATION = 6000;
  const WARN_DURATION = 4000;
  const MAX_VISIBLE = 3; // 同屏最多堆叠条数，超出时移除最早的
  const timers = new WeakMap();
  let container = null;

  function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    const existing = document.getElementById('toast-stack');
    if (existing) {
      container = existing;
      return container;
    }
    container = document.createElement('div');
    container.id = 'toast-stack';
    container.className = 'toast-stack';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
    return container;
  }

  function dismiss(item) {
    const timer = timers.get(item);
    if (timer) {
      clearTimeout(timer);
      timers.delete(item);
    }
    item.classList.add('toast-hide');
    setTimeout(() => item.remove(), 220);
  }

  /**
   * 显示提示。
   * @param {string} message 文案
   * @param {{ level?: 'info'|'warn'|'error', duration?: number }} [options]
   */
  function show(message, options = {}) {
    const level = options.level === 'error' || options.level === 'warn' ? options.level : 'info';
    const stack = ensureContainer();
    while (stack.children.length >= MAX_VISIBLE) stack.removeChild(stack.firstElementChild);

    const item = document.createElement('div');
    item.className = `toast toast-${level}`;
    if (level === 'error') item.setAttribute('role', 'alert');

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    item.appendChild(text);

    // 错误/警告可手动关闭：长文案（如导入校验的多警告拼接）不再只能干等
    if (level !== 'info') {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'toast-close';
      close.setAttribute('aria-label', '关闭提示');
      close.textContent = '×';
      close.addEventListener('click', () => dismiss(item));
      item.appendChild(close);
    }

    stack.appendChild(item);
    const duration = options.duration ?? (level === 'error' ? ERROR_DURATION : level === 'warn' ? WARN_DURATION : DURATION);
    timers.set(item, setTimeout(() => dismiss(item), duration));
  }

  /** 错误码 → 级别：渲染层只按 code 决定提示策略（蓝图 5.4），不解析 message 文本 */
  const ERROR_CODES = new Set(['INTERNAL', 'STORAGE_ERROR', 'RUNTIME_ERROR', 'STEP_TIMEOUT']);
  const WARN_CODES = new Set(['VALIDATION_FAILED', 'CONFLICT', 'INVALID_STATE']);

  /** 统一错误提示入口：catch 块里用 fromError(error) 替代 show(error.message) */
  function fromError(error) {
    const code = error?.code || 'INTERNAL';
    const level = ERROR_CODES.has(code) ? 'error' : WARN_CODES.has(code) ? 'warn' : 'info';
    show(error?.message || '操作失败', { level });
  }

  return { show, fromError };
})();
