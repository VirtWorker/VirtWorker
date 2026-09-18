/**
 * 弹窗组件：统一显隐、遮罩点击与 Esc 关闭（下拉展开时优先由下拉组件处理 Esc）。
 * 无障碍：打开时动态补全 role="dialog"/aria-modal，Tab 焦点圈闭在弹窗内，关闭后焦点还原。
 */
window.VW = window.VW || {};

VW.modal = (() => {
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** 打开栈：记录每个弹窗的触发元素，支持多层弹窗逐层还原焦点 */
  const openStack = [];

  function el(id) {
    return typeof id === 'string' ? document.getElementById(id) : id;
  }

  function topmost() {
    return document.querySelector('.modal-mask:not(.hidden)');
  }

  function open(id) {
    const target = el(id);
    if (!target) return;
    target.classList.remove('hidden');
    target.setAttribute('role', 'dialog');
    target.setAttribute('aria-modal', 'true');
    openStack.push({ id: target.id, trigger: document.activeElement });
    const first = target.querySelector('input:not([type="checkbox"]), textarea, select') || target.querySelector(FOCUSABLE);
    first?.focus();
  }

  function close(id) {
    const target = el(id);
    if (!target || target.classList.contains('hidden')) return;
    target.classList.add('hidden');
    // 从栈中弹出该弹窗（含其上层），把焦点还给打开前的元素
    let entry = null;
    while (openStack.length) {
      entry = openStack.pop();
      if (entry.id === target.id) break;
    }
    if (entry?.trigger && document.contains(entry.trigger)) entry.trigger.focus();
  }

  function isOpen(id) {
    const target = el(id);
    return Boolean(target) && !target.classList.contains('hidden');
  }

  function isAnyOpen() {
    return Array.from(document.querySelectorAll('.modal-mask')).some((mask) => !mask.classList.contains('hidden'));
  }

  document.addEventListener('click', (event) => {
    const mask = event.target.closest('.modal-mask');
    if (mask && event.target === mask) close(mask.id);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (VW.dropdown && VW.dropdown.isOpen()) return; // Esc 先关下拉
      const opened = Array.from(document.querySelectorAll('.modal-mask')).filter(
        (mask) => !mask.classList.contains('hidden')
      );
      if (opened.length) close(opened[opened.length - 1].id);
      return;
    }

    // Tab 焦点圈闭：把焦点限制在当前弹窗内
    if (event.key !== 'Tab') return;
    const modal = topmost();
    if (!modal) return;
    const focusables = Array.from(modal.querySelectorAll(FOCUSABLE)).filter((item) => item.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !modal.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  return { open, close, isOpen, isAnyOpen };
})();
