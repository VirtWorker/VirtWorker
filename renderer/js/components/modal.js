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

  /** 栈顶弹窗：以 openStack（打开顺序）为准——DOM 顺序在叠加弹窗时不可靠（O18） */
  function topmost() {
    const entry = openStack[openStack.length - 1];
    return entry ? el(entry.id) : null;
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
    // 只移除该弹窗自己的栈条目：交叉关闭时不能误伤其上层弹窗的焦点还原记录
    const index = openStack.findIndex((entry) => entry.id === target.id);
    const entry = index >= 0 ? openStack.splice(index, 1)[0] : null;
    // 关闭栈顶（splice 后 index === 栈长）才把焦点还原到它的触发元素；
    // 关闭中间层时上层弹窗仍持有焦点语义，不做还原
    if (entry && index === openStack.length && entry.trigger && document.contains(entry.trigger)) {
      entry.trigger.focus();
    }
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
      // 按打开顺序关栈顶弹窗（O18）：此前按 DOM 顺序取最后者，
      // 叠加弹窗（如向导上打开连接弹窗）时 Esc 会关错层
      const entry = openStack[openStack.length - 1];
      if (entry) close(entry.id);
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
