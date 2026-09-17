/**
 * 通用工具：转义、防抖、时间格式化、任务状态/优先级的展示元数据。
 * 展示措辞集中在此，避免散落在各视图中。
 */
window.VW = window.VW || {};

VW.util = (() => {
  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
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

  return { escapeHtml, debounce, formatTime, statusMeta, statusBadge, assigneeLabel, PRIORITY_LABEL, ACTION_LABEL };
})();