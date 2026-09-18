/**
 * 轻提示组件
 * 每条提示独立计时：新提示不会打断旧提示的显示，多条并发时依次排队展示，
 * 避免共用单个定时器导致互相覆盖（后到的提示会立刻顶掉前一条）。
 */
window.VW = window.VW || {};

VW.toast = (() => {
  const DURATION = 2200;
  const MAX_VISIBLE = 3; // 同屏最多堆叠条数，超出时移除最早的
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

  function show(message) {
    const stack = ensureContainer();
    while (stack.children.length >= MAX_VISIBLE) stack.removeChild(stack.firstElementChild);

    const item = document.createElement('div');
    item.className = 'toast';
    item.textContent = message;
    stack.appendChild(item);

    setTimeout(() => {
      item.classList.add('toast-hide');
      setTimeout(() => item.remove(), 220);
    }, DURATION);
  }

  return { show };
})();
