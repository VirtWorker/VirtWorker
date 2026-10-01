/**
 * 通用工具：转义、防抖、时间格式化、任务状态/优先级的展示元数据。
 * 展示措辞集中在此，避免散落在各视图中。
 */
window.VW = window.VW || {};

VW.util = (() => {
  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    // textContent→innerHTML 只转义 & < >，不转义引号；本函数大量用于双引号属性内
    // （如 value="${escapeHtml(...)}"），必须补齐引号转义，否则输入 " 即可逃逸属性注入事件
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 样式值白名单校验：用于把外部数据安全地插入 style 属性。
   * 只允许颜色/渐变等安全字符（不含引号、尖括号、冒号、& 等可逃逸属性的字符），
   * 校验失败返回兜底值，作为服务端白名单之外的纵深防御。
   */
  const SAFE_STYLE_RE = /^[#a-zA-Z0-9(),.\s%/-]+$/;
  function safeStyle(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text && SAFE_STYLE_RE.test(text) ? text : fallback;
  }

  function debounce(fn, wait = 200) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function formatTime(iso) {
    if (!iso) return '-';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '-';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  const STATUS_META = {
    queued: { label: '排队中', cls: 'status-queued' },
    running: { label: '进行中', cls: 'status-running' },
    need_action: { label: '需要操作', cls: 'status-action' },
    succeeded: { label: '已完成', cls: 'status-done' },
    failed: { label: '失败', cls: 'status-failed' },
    canceled: { label: '已取消', cls: 'status-canceled' }
  };

  const PRIORITY_LABEL = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
  const ACTION_LABEL = { confirm: '确认', question: '回答', input: '补充信息', selection: '选择' };

  function statusMeta(status) {
    return STATUS_META[status] || { label: status || '未知', cls: 'status-queued' };
  }

  function statusBadge(status) {
    const meta = statusMeta(status);
    return `<span class="status-badge ${meta.cls}">${meta.label}</span>`;
  }

  const ASSIGNEE_TYPE_LABEL = { worker: 'Worker', group: 'Group', flow: 'WorkerFlow' };

  /** 执行者展示文案：非单个 Worker 时带类型前缀，避免误认 */
  function assigneeLabel(assignee) {
    if (!assignee) return '-';
    const prefix = assignee.type && assignee.type !== 'worker' ? `${ASSIGNEE_TYPE_LABEL[assignee.type] || assignee.type} · ` : '';
    return `${prefix}${assignee.name || ''}`;
  }

  /**
   * 任务历史列表（最近任务弹窗 / 自动任务运行历史共用）。
   * @param {object[]} tasks 任务数组
   * @param {object} [options]
   *   - label:    顶部说明文案（如「最近 20 条任务」）
   *   - metaOf:   (task) => string，第二行元信息文案
   *   - btnText:  右侧按钮文案（默认「查看」）
   *   - btnAttrs: 按钮附加属性串（如自动任务用 `data-act="open-task"`，其事件委托选择器依赖它）
   *   - emptyText: 空列表提示
   */
  function historyListHtml(tasks, { label, metaOf, btnText = '查看', btnAttrs = '', emptyText = '还没有任务记录。' } = {}) {
    if (!tasks.length) return `<div class="detail-section"><p class="detail-sub">${escapeHtml(emptyText)}</p></div>`;
    return `<div class="detail-section">
             <div class="detail-label">${escapeHtml(label)}</div>
             ${tasks
               .map(
                 (task) => `
               <div class="history-item">
                 <div class="history-main">
                   <span class="history-title">${escapeHtml(task.title)}</span>
                   <span class="history-meta">${escapeHtml(metaOf ? metaOf(task) : formatTime(task.createdAt))}</span>
                 </div>
                 ${statusBadge(task.status)}
                 <button class="mini-btn" ${btnAttrs} data-task="${escapeHtml(task.id)}">${escapeHtml(btnText)}</button>
               </div>`
               )
               .join('')}
           </div>`;
  }

  /**
   * 列表渲染样板（O14）：innerHTML 重建 + 空态显隐的统一实现。
   * 此前该三行组合散落在 10+ 个视图中。
   * @returns {number} 渲染的条数
   */
  function renderList({ container, empty, items, itemHtml }) {
    container.innerHTML = items.map(itemHtml).join('');
    if (empty) empty.classList.toggle('hidden', items.length > 0);
    return items.length;
  }

  /**
   * 操作提交样板（O14）：await action → 成功提示 / 失败 toast。
   * success 可为文案字符串或 (result) => string；rethrow 时调用方可追加处理（如刷新）。
   * 破坏性操作的确认（window.confirm）由调用方在 action 之前自行判断。
   */
  async function submitAction(action, { success, rethrow = false } = {}) {
    try {
      const result = await action();
      if (success) VW.toast.show(typeof success === 'function' ? success(result) : success);
      return result;
    } catch (error) {
      VW.toast.fromError(error);
      if (rethrow) throw error;
      return undefined;
    }
  }

  /**
   * 表单提交在途锁（OPT-4）：await 期间再次提交直接忽略，防止双击重复创建任务/Worker 等。
   * 以 form 元素为锁粒度，并在途时禁用提交按钮给出视觉反馈；结束（含失败）后恢复。
   * 失败统一经 toast.fromError 提示（与 submitAction 同款约定），不向调用方抛出。
   */
  async function withSubmitting(form, action) {
    if (!form || form.dataset.submitting === '1') return;
    form.dataset.submitting = '1';
    const submitBtn = form.querySelector('[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      await action();
    } catch (error) {
      VW.toast.fromError(error);
    } finally {
      delete form.dataset.submitting;
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  return {
    escapeHtml,
    safeStyle,
    debounce,
    formatTime,
    statusMeta,
    statusBadge,
    assigneeLabel,
    historyListHtml,
    renderList,
    submitAction,
    withSubmitting,
    PRIORITY_LABEL,
    ACTION_LABEL
  };
})();