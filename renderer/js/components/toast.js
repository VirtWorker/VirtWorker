/**
 * 轻提示组件
 */
window.VW = window.VW || {};

VW.toast = (() => {
  let timer = null;

  function show(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  return { show };
})();