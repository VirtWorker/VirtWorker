/**
 * 执行者下拉组件：任务派发、自动任务执行者/事件限定、执行者筛选器等共用。
 * 统一「重建选项 + 保留有效选中值 + 同步自定义下拉显示」的样板逻辑。
 */
window.VW = window.VW || {};

VW.assigneeSelect = (() => {
  /**
   * 填充执行者下拉。
   * @param {string} selectId   select 元素 id
   * @param {object} [options]
   *   - placeholder: 顶部附加空选项文本（如「全部执行者」「不限」），不传则无空选项
   *   - selectedId:  期望选中的值；无效（已删除）时回退到第一项/空选项
   * @returns {string} 实际生效的选中值
   */
  function fill(selectId, { placeholder, selectedId } = {}) {
    const select = document.getElementById(selectId);
    if (!select) return '';
    const options = VW.store.assigneeOptions();
    const head = placeholder ? [`<option value="">${VW.util.escapeHtml(placeholder)}</option>`] : [];
    select.innerHTML = head
      .concat(options.map((item) => `<option value="${item.value}">${VW.util.escapeHtml(item.label)}</option>`))
      .join('');
    const valid = selectedId && options.some((item) => item.value === selectedId);
    select.value = valid ? selectedId : placeholder ? '' : options[0]?.value || '';
    VW.dropdown.refresh(select);
    return valid ? selectedId : select.value;
  }

  /** 程序化赋值后同步自定义下拉显示值（不触发 change） */
  function set(select, value) {
    select.value = value;
    VW.dropdown.refresh(select);
  }

  return { fill, set };
})();
