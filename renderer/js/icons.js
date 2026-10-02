/**
 * 共享 SVG 图标常量（F3 收编）：同一图标此前在多个视图逐字重复（Group 图标 ×2、PLUS 等），
 * 维护时容易只改一处。加载顺序：util 之后、视图之前（build-renderer.js FILES）。
 */
window.VW = window.VW || {};

VW.icons = (() => {
  /** Group 图标：size 传渲染尺寸（侧边栏 14 / 卡片 18） */
  function groupIcon(size = 18) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 19v-1a6 6 0 0 1 12 0v1"/><circle cx="18" cy="10" r="2.4"/></svg>`;
  }

  const PLUS_ICON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  return { groupIcon, PLUS_ICON };
})();
