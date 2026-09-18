/**
 * 自主工作页：自动任务列表、启停、新建/编辑、运行历史、API 触发信息。
 * 触发时机由主进程调度器决定，本视图只负责配置与展示。
 */
window.VW = window.VW || {};

VW.views = VW.views || {};

VW.views.automations = (() => {
  const { escapeHtml, formatTime, statusBadge, assigneeLabel } = VW.util;
  const store = VW.store;

  /** 当前编辑中的自动任务 id；为空表示新建 */
  let editingId = null;

  const pad = (number) => String(number).padStart(2, '0');

  // ==================== 数据 ====================

  async function refresh() {
    try {
      const [list, stats, runtime] = await Promise.all([
        VW.api.automation.list(store.state.filters.automation),
        VW.api.automation.stats(),
        VW.api.automation.runtime()
      ]);
      store.set({ automations: list.items, automationStats: stats, apiServer: runtime.apiServer });
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  // ==================== 渲染 ====================

  function renderStats() {
    const stats = store.state.automationStats;
    document.getElementById('auto-stat-total').textContent = String(stats.total);
    document.getElementById('auto-stat-enabled').textContent = String(stats.enabled);
    document.getElementById('auto-stat-worker').textContent = String(stats.workerCount);
    document.getElementById('auto-stat-flow').textContent = String(stats.flowCount);
  }

  /** 存在 API 型自动任务时才提示本地端点状态，避免干扰其他用户 */
  function renderApiStatus() {
    const hint = document.getElementById('api-status');
    const server = store.state.apiServer;
    const hasApi = store.state.automations.some((item) => item.trigger.type === 'api');
    if (!hasApi) {
      hint.classList.add('hidden');
      return;
    }
    hint.classList.remove('hidden');
    hint.classList.toggle('error', !server.running);
    hint.innerHTML = server.running
      ? `本地触发端点运行中：<code>http://127.0.0.1:${server.port}</code>（仅本机可访问，需携带 Token）`
      : `本地触发端点未启动：${escapeHtml(server.error || '未知原因')}`;
  }

  function cardHtml(automation) {
    const port = store.state.apiServer.port || '';
    const showEndpoint = automation.trigger.type === 'api' && automation.endpoint;
    const endpoint = showEndpoint ? `http://127.0.0.1:${port}${automation.endpoint}` : '';
    const token = automation.trigger.api?.token || '';

    return `
      <div class="automation-card" data-id="${automation.id}">
        <div class="automation-head">
          <div class="automation-title-wrap">
            <span class="automation-title">${escapeHtml(automation.name)}</span>
            <span class="status-badge ${automation.enabled ? 'status-running' : 'status-canceled'}">
              ${automation.enabled ? '已启用' : '已停用'}
            </span>
          </div>
          <label class="switch" title="${automation.enabled ? '点击停用' : '点击启用'}">
            <input type="checkbox" data-act="toggle" ${automation.enabled ? 'checked' : ''} />
            <span class="switch-track"></span>
          </label>
        </div>
        <div class="automation-meta">
          <span class="meta-chip">${escapeHtml(automation.triggerLabel)}</span>
          <span>${escapeHtml(automation.triggerText)}</span>
          ${
            automation.enabled && automation.nextRunAt
              ? `<span class="meta-next">下次 ${formatTime(automation.nextRunAt)}</span>`
              : ''
          }
        </div>
        <div class="automation-body">
          ${automation.desc ? `<div class="automation-line">${escapeHtml(automation.desc)}</div>` : ''}
          <div class="automation-line">执行者：${escapeHtml(assigneeLabel(automation.executor))}</div>
          <div class="automation-line">任务目标：${escapeHtml(automation.input.goal)}</div>
          ${
            showEndpoint
              ? `<div class="automation-endpoint">
                   <code>POST ${endpoint}</code>
                   <code class="token-code">Token: ${escapeHtml(token)}</code>
                   <button class="mini-btn" data-act="copy" data-endpoint="${escapeHtml(endpoint)}" data-token="${escapeHtml(token)}">复制调用命令</button>
                 </div>`
              : ''
          }
        </div>
        <div class="automation-foot">
          <span class="automation-stats">已运行 ${automation.runCount} 次${
            automation.lastRunAt ? ` · 最近 ${formatTime(automation.lastRunAt)}` : ''
          }${automation.lastRunReason ? ` · ${escapeHtml(automation.lastRunReason)}` : ''}</span>
          <div class="worker-card-actions">
            <button class="mini-btn" data-act="history">运行历史</button>
            <button class="mini-btn" data-act="edit">编辑</button>
            <button class="mini-btn" data-act="remove">删除</button>
          </div>
        </div>
      </div>`;
  }

  function render() {
    renderStats();
    renderApiStatus();

    const list = document.getElementById('automation-list');
    const empty = document.getElementById('automation-empty');
    const items = store.state.automations;

    if (!items.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.innerHTML = items.map(cardHtml).join('');
  }

  /** 执行者筛选器：随 Worker/Group 数据变化重建 */
  function renderExecutorFilter() {
    const current = store.state.filters.automation.executorId;
    const effective = VW.assigneeSelect.fill('auto-filter-executor', { placeholder: '全部执行者', selectedId: current });
    if (effective !== current) store.setFilters('automation', { executorId: effective });
  }

  // ==================== 弹窗 ====================

  function setSelect(select, value) {
    select.value = value;
    VW.dropdown.refresh(select); // 程序化赋值不会触发 change，需手动同步自定义下拉的显示值
  }

  function fillExecutorSelect(selectedId) {
    VW.assigneeSelect.fill('automation-executor', { selectedId });
  }

  function fillEventAssigneeSelect(selectedId) {
    VW.assigneeSelect.fill('automation-event-assignee', { placeholder: '不限', selectedId });
  }

  /** 按触发方式与重复方式显示对应字段 */
  function applyVisibility() {
    const form = document.getElementById('automation-form');
    const type = form.triggerType.value;
    const mode = form.scheduleMode.value;

    form.querySelectorAll('[data-group]').forEach((field) => {
      const groups = field.dataset.group.split(' ');
      if (!groups.includes(type)) {
        field.classList.add('hidden');
        return;
      }
      const modes = field.dataset.mode ? field.dataset.mode.split(' ') : null;
      field.classList.toggle('hidden', Boolean(modes) && !modes.includes(mode));
    });
  }

  function toLocalInput(iso) {
    const date = new Date(iso);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
      date.getMinutes()
    )}`;
  }

  function fillForm(automation) {
    const form = document.getElementById('automation-form');
    form.reset();
    fillExecutorSelect(automation.executor.id);
    fillEventAssigneeSelect(automation.trigger.event?.assigneeId);

    form.name.value = automation.name;
    form.desc.value = automation.desc || '';
    form.goal.value = automation.input.goal;
    form.workspace.value = automation.input.workspace || '';
    form.confirmFirst.checked = Boolean(automation.input.confirmFirst);
    setSelect(form.priority, automation.input.priority);
    setSelect(form.triggerType, automation.trigger.type);

    if (automation.trigger.type === 'schedule') {
      const schedule = automation.trigger.schedule || {};
      setSelect(form.scheduleMode, schedule.mode || 'daily');
      form.everyMinutes.value = schedule.everyMinutes || 30;
      form.time.value = `${pad(schedule.hour ?? 9)}:${pad(schedule.minute ?? 0)}`;
      setSelect(form.weekday, String(schedule.weekday ?? 1));
      form.at.value = schedule.at ? toLocalInput(schedule.at) : '';
    } else if (automation.trigger.type === 'event') {
      setSelect(form.eventSource, automation.trigger.event.source);
    }
  }

  function openModal(automation) {
    if (!store.assigneeOptions().length) {
      VW.toast.show('请先创建 Worker 或 Group');
      return;
    }
    editingId = automation ? automation.id : null;
    const form = document.getElementById('automation-form');
    document.getElementById('automation-modal-title').textContent = automation ? '编辑自动任务' : '新建自动任务';

    if (automation) {
      fillForm(automation);
    } else {
      form.reset();
      fillExecutorSelect();
      fillEventAssigneeSelect();
    }
    applyVisibility();
    VW.modal.open('automation-modal');
  }

  function readForm() {
    const form = document.getElementById('automation-form');
    const type = form.triggerType.value;
    const [hour, minute] = String(form.time.value || '09:00').split(':').map(Number);

    const trigger =
      type === 'schedule'
        ? {
            type,
            schedule: {
              mode: form.scheduleMode.value,
              everyMinutes: Number(form.everyMinutes.value),
              hour,
              minute,
              weekday: Number(form.weekday.value),
              at: form.at.value ? new Date(form.at.value).toISOString() : ''
            }
          }
        : type === 'event'
          ? { type, event: { source: form.eventSource.value, assigneeId: form.eventAssignee.value } }
          : { type };

    return {
      name: form.name.value,
      desc: form.desc.value,
      executorId: form.executorId.value,
      trigger,
      input: {
        goal: form.goal.value,
        workspace: form.workspace.value,
        priority: form.priority.value,
        confirmFirst: form.confirmFirst.checked
      }
    };
  }

  async function submitForm(event) {
    event.preventDefault();
    const payload = readForm();
    try {
      if (editingId) {
        await VW.api.automation.update(editingId, payload);
        VW.toast.show('自动任务已更新');
      } else {
        const created = await VW.api.automation.create(payload);
        VW.toast.show(
          created.trigger.type === 'api' ? '已创建，API Token 可在卡片上复制' : `自动任务「${created.name}」已创建`
        );
      }
      VW.modal.close('automation-modal');
      await refresh();
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  // ==================== 运行历史 ====================

  async function openHistory(id) {
    try {
      const { automation, runs } = await VW.api.automation.detail(id);
      document.getElementById('automation-history-title').textContent = `运行历史 · ${automation.name}`;
      const body = document.getElementById('automation-history-body');
      body.innerHTML = runs.length
        ? `<div class="detail-section">
             <div class="detail-label">最近 ${runs.length} 次触发</div>
             ${runs
               .map(
                 (task) => `
               <div class="history-item">
                 <div class="history-main">
                   <span class="history-title">${escapeHtml(task.title)}</span>
                   <span class="history-meta">${formatTime(task.createdAt)} · ${escapeHtml(
                     task.input?.payload?.reason || task.trigger.label
                   )}</span>
                 </div>
                 ${statusBadge(task.status)}
                 <button class="mini-btn" data-act="open-task" data-task="${task.id}">查看任务</button>
               </div>`
               )
               .join('')}
           </div>`
        : '<div class="detail-section"><p class="detail-sub">该自动任务还没有触发记录，等它开工后这里会显示每次运行的任务。</p></div>';
      VW.modal.open('automation-history-modal');
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  // ==================== 初始化 ====================

  function init() {
    const openNew = () => openModal(null);
    document.getElementById('new-automation-btn').addEventListener('click', openNew);
    document.getElementById('automation-empty-action').addEventListener('click', openNew);
    document.getElementById('automation-modal-close').addEventListener('click', () => VW.modal.close('automation-modal'));
    document.getElementById('automation-modal-cancel').addEventListener('click', () => VW.modal.close('automation-modal'));
    document.getElementById('automation-history-close').addEventListener('click', () =>
      VW.modal.close('automation-history-modal')
    );
    document.getElementById('automation-history-ok').addEventListener('click', () =>
      VW.modal.close('automation-history-modal')
    );

    const form = document.getElementById('automation-form');
    form.addEventListener('submit', submitForm);
    form.triggerType.addEventListener('change', applyVisibility);
    form.scheduleMode.addEventListener('change', applyVisibility);
    applyVisibility();

    // 筛选器
    document.getElementById('auto-filter-trigger').addEventListener('change', (event) => {
      store.setFilters('automation', { triggerType: event.target.value });
      refresh();
    });
    document.getElementById('auto-filter-status').addEventListener('change', (event) => {
      store.setFilters('automation', { status: event.target.value });
      refresh();
    });
    document.getElementById('auto-filter-sort').addEventListener('change', (event) => {
      store.setFilters('automation', { sort: event.target.value });
      refresh();
    });
    document.getElementById('auto-filter-executor').addEventListener('change', (event) => {
      store.setFilters('automation', { executorId: event.target.value });
      refresh();
    });

    // 卡片操作（事件委托）
    const list = document.getElementById('automation-list');
    list.addEventListener('change', (event) => {
      const toggle = event.target.closest('[data-act="toggle"]');
      if (!toggle) return;
      const id = toggle.closest('.automation-card').dataset.id;
      VW.api.automation
        .toggle(id, toggle.checked)
        .then(async (automation) => {
          VW.toast.show(automation.enabled ? '已启用' : '已停用');
          await refresh();
        })
        .catch(async (error) => {
          VW.toast.show(error.message);
          await refresh(); // 失败时回滚界面开关状态
        });
    });

    list.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const id = button.closest('.automation-card').dataset.id;

      if (button.dataset.act === 'history') return openHistory(id);
      if (button.dataset.act === 'edit') {
        const automation = store.state.automations.find((item) => item.id === id);
        if (automation) openModal(automation);
        return undefined;
      }
      if (button.dataset.act === 'copy') {
        const command = `curl -X POST ${button.dataset.endpoint} -H "X-VirtWorker-Token: ${button.dataset.token}" -H "Content-Type: application/json" -d "{\\"goal\\":\\"\\"}"`;
        try {
          await VW.api.copyText(command);
          VW.toast.show('调用命令已复制到剪贴板');
        } catch (error) {
          VW.toast.show(error.message);
        }
        return undefined;
      }
      if (button.dataset.act === 'remove') {
        if (!window.confirm('确认删除该自动任务？已产生的任务记录不会被删除。')) return undefined;
        try {
          await VW.api.automation.remove(id);
          VW.toast.show('自动任务已删除');
          await refresh();
        } catch (error) {
          VW.toast.show(error.message);
        }
      }
      return undefined;
    });

    // 从运行历史跳到任务详情
    document.getElementById('automation-history-body').addEventListener('click', (event) => {
      const button = event.target.closest('[data-act="open-task"]');
      if (!button) return;
      VW.modal.close('automation-history-modal');
      document.querySelector('.nav-item[data-page="dashboard"]').click();
      VW.views.dashboard.openDetail(button.dataset.task);
    });

    store.on(['automations', 'automationStats', 'apiServer'], render);
    store.on(['workers', 'groups'], renderExecutorFilter);

    renderExecutorFilter();
    render();
  }

  return { init, refresh, render };
})();