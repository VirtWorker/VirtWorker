/**
 * 自定义下拉菜单组件
 * 将原生 <select> 增强为统一风格的下拉：原生 select 保留在 DOM 中（隐藏）以同步值，
 * 保证 form.xxx.value 等既有用法不受影响；选项动态变化后调用 VW.dropdown.refresh(select) 重建。
 */
window.VW = window.VW || {};

VW.dropdown = (() => {
  let openDropdown = null;

  const CHEVRON_SVG =
    '<svg class="dropdown-chevron" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  const CHECK_SVG =
    '<svg class="check" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  // 统一复用 util.js 的转义实现（加载顺序保证 VW.util 先于本文件）
  const escapeHtml = VW.util.escapeHtml;

  function closeAll() {
    if (!openDropdown) return;
    openDropdown.classList.remove('open');
    openDropdown.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
    openDropdown = null;
  }

  function enhance(select) {
    if (select.classList.contains('dropdown-native')) return;
    select.classList.add('dropdown-native');

    const isBlock = select.classList.contains('modal-select');
    const wrap = document.createElement('span');
    wrap.className = 'dropdown' + (isBlock ? ' dropdown-block' : '');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dropdown-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = `<span class="dropdown-value"></span>${CHEVRON_SVG}`;

    const menu = document.createElement('span');
    menu.className = 'dropdown-menu';
    menu.setAttribute('role', 'listbox');

    const valueEl = trigger.querySelector('.dropdown-value');

    function renderValue() {
      const option = select.options[select.selectedIndex];
      valueEl.textContent = option ? option.textContent : '';
      menu.querySelectorAll('.dropdown-option').forEach((item, index) => {
        const selected = index === select.selectedIndex;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
    }

    function buildMenu() {
      menu.innerHTML = '';
      Array.from(select.options).forEach((option, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'dropdown-option';
        item.setAttribute('role', 'option');
        item.tabIndex = -1;
        item.innerHTML = `<span>${escapeHtml(option.textContent)}</span>${CHECK_SVG}`;
        item.addEventListener('click', () => {
          select.selectedIndex = index;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          renderValue();
          closeAll();
          trigger.focus();
        });
        menu.appendChild(item);
      });
      renderValue();
    }

    function open() {
      if (openDropdown === wrap) {
        closeAll();
        return;
      }
      closeAll();
      // 面板展开后超出视口右缘时改为右对齐
      menu.classList.remove('align-right');
      const anchor = menu.offsetParent || wrap;
      const rect = anchor.getBoundingClientRect();
      if (rect.left + menu.offsetWidth > window.innerWidth - 12) menu.classList.add('align-right');
      wrap.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      openDropdown = wrap;
      const focused = menu.querySelector('.dropdown-option.selected');
      (focused || menu.querySelector('.dropdown-option'))?.focus({ preventScroll: true });
    }

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      open();
    });

    // 点击容器标签文字区域同样可展开下拉
    const container = select.closest('label');
    if (container) {
      container.addEventListener('click', (event) => {
        if (event.target.closest('.dropdown-menu') || event.target.closest('.dropdown-trigger')) return;
        event.preventDefault();
        open();
      });
    }

    // 键盘交互：上下移动焦点，Enter 选中，Esc 关闭
    menu.addEventListener('keydown', (event) => {
      const items = Array.from(menu.querySelectorAll('.dropdown-option'));
      const index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[Math.min(index + 1, items.length - 1)]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[Math.max(index - 1, 0)]?.focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        document.activeElement?.click();
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        closeAll();
        trigger.focus();
      }
    });

    select.addEventListener('change', renderValue);
    buildMenu();

    select.parentElement.insertBefore(wrap, select);
    wrap.append(trigger, menu, select); // 隐藏的原生 select 一并移入组件内

    // 供选项动态变化后重建
    select.__vwRebuild = buildMenu;
  }

  function enhanceAll(root = document) {
    root.querySelectorAll('select').forEach(enhance);
  }

  /** 选项增删后重建面板（触发按钮上的当前值同步刷新） */
  function refresh(select) {
    if (select && typeof select.__vwRebuild === 'function') select.__vwRebuild();
  }

  function isOpen() {
    return Boolean(openDropdown);
  }

  // 点击组件外部收起；Esc 关闭
  document.addEventListener('click', (event) => {
    if (openDropdown && !openDropdown.contains(event.target)) closeAll();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAll();
  });

  return { enhanceAll, refresh, isOpen, closeAll };
})();