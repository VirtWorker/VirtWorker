/**
 * 弹窗组件：统一显隐、遮罩点击与 Esc 关闭（下拉展开时优先由下拉组件处理 Esc）。
 */
window.VW = window.VW || {};

VW.modal = (() => {
  function el(id) {
    return typeof id === 'string' ? document.getElementById(id) : id;
  }

  function open(id) {
    const target = el(id);
    if (!target) return;
    target.classList.remove('hidden');
    target.querySelector('input:not([type="checkbox"]), textarea, select')?.focus();
  }

  function close(id) {
    el(id)?.classList.add('hidden');
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
    if (event.key !== 'Escape') return;
    if (VW.dropdown && VW.dropdown.isOpen()) return; // Esc 先关下拉
    const opened = Array.from(document.querySelectorAll('.modal-mask')).filter(
      (mask) => !mask.classList.contains('hidden')
    );
    if (opened.length) close(opened[opened.length - 1].id);
  });

  return { open, close, isOpen, isAnyOpen };
})();