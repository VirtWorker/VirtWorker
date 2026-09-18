/**
 * 任务看板页：工作记录统计、需要操作 / 查收结果队列、全部任务（列表视图 + 看板视图）、
 * 任务创建与详情弹窗。
 * 口径说明：统计与筛选全部由主进程计算，本视图只负责渲染与提交操作。
 */
window.VW = window.VW || {};

VW.views = VW.views || {};

VW.views.dashboard = (() => {
  const { escapeHtml, debounce, formatTime, statusBadge, statusMeta, assigneeLabel, PRIORITY_LABEL, ACTION_LABEL } = VW.util;
  const store = VW.store;

  /** 详情弹窗当前展示的任务（含待操作请求），提交操作时读取 */
  let detailState = null;

  // ==================== 数据 ====================

  async function refresh(options = {}) {
    const { task: filters, statsPeriod } = store.state.filters;
    try {
      const [periodTasks, stats, filtered] = await Promise.all([
        VW.api.task.list({ period: statsPeriod }),
        VW.api.task.stats({ period: statsPeriod }),
        VW.api.task.list(filters)
      ]);
      store.set({
        stats,
        tasks: filtered.items,
        queue: {
          action: periodTasks.items.filter((task) => task.status === 'need_action'),
          result: periodTasks.items.filter((task) => task.status === 'succeeded' && !task.resultAckedAt)
        }
      });
    } catch (error) {
      if (!options.silent) VW.toast.show(error.message);
      console.error('[dashboard] 任务数据刷新失败:', error);
    }
  }

  const refreshSoon = debounce(() => refresh({ silent: true }), 120);

  // ==================== 统计与页签 ====================

  function renderStats() {
    const stats = store.state.stats;
    document.getElementById('stat-total').textContent = String(stats.total);
    document.getElementById('stat-running').textContent = String(stats.running);
    document.getElementById('stat-action').textContent = String(stats.needAction);
    document.getElementById('stat-finished').textContent = String(stats.finished);
    document.getElementById('record-foot-text').textContent = stats.running
      ? `${stats.workingWorkers} 个 Worker 正在工作`
      : 'Worker 们正在休息';
  }

  function renderTabs() {
    const queue = store.state.queue;
    document.querySelector('#dashboard-tabs [data-count="action"]').textContent = String(queue.action.length);
    document.querySelector('#dashboard-tabs [data-count="result"]').textContent = String(queue.result.length);

    const tab = store.state.ui.dashboardTab;
    const list = tab === 'result' ? queue.result : queue.action;
    const empty = document.getElementById('dashboard-tab-empty');
    const container = document.getElementById('dashboard-tab-list');

    if (!list.length) {
      container.innerHTML = '';
      empty.classList.remove('hidden');
      empty.querySelector('.empty-title').textContent =
        tab === 'result' ? '暂无可查收的结果' : '暂无需要操作的任务';
      empty.querySelector('.empty-desc').textContent =
        tab === 'result'
          ? 'Worker 完成任务后，结果会显示在这里供你查收。'
          : '需要你确认、回答或补充信息的任务会显示在这里。';
      return;
    }

    empty.classList.add('hidden');
    container.innerHTML = list
      .map((task) => (tab === 'result' ? resultItemHtml(task) : actionItemHtml(task)))
      .join('');
  }

  /** 需要操作：按请求类型渲染选项 / 输入框 */
  function actionItemHtml(task) {
    const request = task.actionRequest || {};
    return `
      <div class="queue-item" tabindex="0" data-id="${task.id}">
        <div class="queue-head">
          <span class="queue-title">${escapeHtml(task.title)}</span>
          ${statusBadge(task.status)}
        </div>
        <div class="queue-meta">${escapeHtml(assigneeLabel(task.assignee))} · ${ACTION_LABEL[request.type] || '操作'} · ${formatTime(
          task.createdAt
        )}</div>
        ${actionBlockHtml(request)}
        <div class="queue-foot">
          <button class="mini-btn" data-act="detail">查看详情</button>
          <button class="btn btn-primary btn-sm" data-act="submit">提交</button>
        </div>
      </div>`;
  }

  /** 操作请求主体：选中后提交，与任务详情弹窗共用同一份渲染逻辑 */
  function actionBlockHtml(request = {}, options = {}) {
    const choices = request.options || [];
    const useChoices = request.type === 'selection' || request.type === 'confirm';

    const body = useChoices
      ? `<div class="choice-row">${choices
          .map(
            (option) => `<button type="button" class="choice-btn${
              option.value === request.defaultValue ? ' active' : ''
            }" data-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</button>`
          )
          .join('')}</div>`
      : request.type === 'question'
        ? `<textarea class="request-input" data-field="value" rows="2" placeholder="填写你的回答"></textarea>`
        : `<div class="field-row">${(request.form || [])
            .map(
              (field) =>
                `<input class="request-input" data-field="${escapeHtml(field.name)}" placeholder="${escapeHtml(
                  field.label
                )}${field.required ? '（必填）' : ''}" />`
            )
            .join('')}</div>`;

    return `
      <div class="request-block">
        <div class="request-title">${escapeHtml(request.title || '')}</div>
        ${request.detail ? `<div class="request-detail">${escapeHtml(request.detail)}</div>` : ''}
        ${body}
        ${
          options.submit
            ? `<div class="request-submit"><button class="btn btn-primary btn-sm" data-act="submit-answer">提交</button></div>`
            : ''
        }
      </div>`;
  }

  /** 查收结果 */
  function resultItemHtml(task) {
    const result = task.result || {};
    return `
      <div class="queue-item" tabindex="0" data-id="${task.id}">
        <div class="queue-head">
          <span class="queue-title">${escapeHtml(task.title)}</span>
          ${statusBadge(task.status)}
        </div>
        <div class="queue-meta">${escapeHtml(assigneeLabel(task.assignee))} · 完成于 ${formatTime(task.finishedAt)}</div>
        <div class="request-block">
          <div class="result-summary">${escapeHtml(result.summary || '任务已完成')}</div>
          ${result.text ? `<div class="request-detail">${escapeHtml(result.text)}</div>` : ''}
          <div class="chip-row">${(result.artifacts || [])
            .map((artifact) => `<span class="chip">${escapeHtml(artifact)}</span>`)
            .join('')}</div>
        </div>
        <div class="queue-foot">
          <button class="mini-btn" data-act="detail">查看详情</button>
          <button class="btn btn-primary btn-sm" data-act="ack">已查收</button>
        </div>
      </div>`;
  }

  // ==================== 全部任务 ====================

  function progressHtml(task) {
    const width = Math.max(0, Math.min(100, task.progress || 0));
    return `<div class="progress"><span style="width:${width}%"></span></div><span class="progress-text">${width}%</span>`;
  }

  function rowActionsHtml(task) {
    const actions = ['<button class="mini-btn" data-act="detail">详情</button>'];
    if (task.status === 'succeeded' && !task.resultAckedAt) {
      actions.push('<button class="mini-btn" data-act="ack">查收</button>');
    }
    if (['queued', 'running', 'need_action'].includes(task.status)) {
      actions.push('<button class="mini-btn" data-act="cancel">取消</button>');
    }
    return actions.join('');
  }

  function renderTaskList() {
    const container = document.getElementById('task-list-view');
    const board = document.getElementById('task-board-view');
    const empty = document.getElementById('task-list-empty');
    const tasks = store.state.tasks;
    const isBoard = store.state.settings.taskView === 'board';

    document.querySelectorAll('#task-view-toggle .view-btn').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === (isBoard ? 'board' : 'list'));
    });
    container.classList.toggle('hidden', isBoard);
    board.classList.toggle('hidden', !isBoard);

    if (!tasks.length) {
      container.innerHTML = '';
      board.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    if (!isBoard) {
      container.innerHTML = tasks
        .map(
          (task) => `
        <div class="task-row" tabindex="0" data-id="${task.id}">
          <div class="task-row-main">
            <div class="task-row-title">${escapeHtml(task.title)}</div>
            <div class="task-row-meta">${escapeHtml(assigneeLabel(task.assignee))} · ${escapeHtml(
              task.trigger.label
            )} · ${formatTime(task.createdAt)}</div>
          </div>
          <div class="task-row-progress">${progressHtml(task)}</div>
          <div class="task-row-status">${statusBadge(task.status)}</div>
          <div class="task-row-actions">${rowActionsHtml(task)}</div>
        </div>`
        )
        .join('');
      return;
    }

    const columns = [
      { key: 'active', title: '进行中', match: ['queued', 'running'] },
      { key: 'action', title: '需要操作', match: ['need_action'] },
      { key: 'finished', title: '已结束', match: ['succeeded', 'failed', 'canceled'] }
    ];
    board.innerHTML = columns
      .map((column) => {
        const items = tasks.filter((task) => column.match.includes(task.status));
        return `
        <div class="board-col">
          <div class="board-col-head"><span>${column.title}</span><span class="board-count">${items.length}</span></div>
          <div class="board-col-body">
            ${
              items.length
                ? items
                    .map(
                      (task) => `
              <div class="board-card" tabindex="0" data-id="${task.id}">
                <div class="board-card-title">${escapeHtml(task.title)}</div>
                <div class="board-card-meta">${escapeHtml(assigneeLabel(task.assignee))} · ${statusMeta(task.status).label}</div>
                ${progressHtml(task)}
              </div>`
                    )
                    .join('')
                : '<p class="board-empty">暂无任务</p>'
            }
          </div>
        </div>`;
      })
      .join('');
  }

  function renderAll() {
    renderStats();
    renderTabs();
    renderTaskList();
  }

  // ==================== 操作提交 ====================

  /** 从容器中读取用户填写的操作内容 */
  function readAnswer(scope) {
    const choice = scope.querySelector('.choice-btn.active');
    if (choice) return { value: choice.dataset.value };
    const valueField = scope.querySelector('[data-field="value"]');
    if (valueField) return { value: valueField.value };
    const form = {};
    scope.querySelectorAll('[data-field]').forEach((input) => {
      if (input.dataset.field !== 'value') form[input.dataset.field] = input.value;
    });
    return { form, value: '' };
  }

  async function submitAnswer(scope, task, request) {
    try {
      await VW.api.task.answer({ taskId: task.id, actionId: request.id, answer: readAnswer(scope) });
      VW.toast.show('已提交，任务继续执行');
      if (VW.modal.isOpen('task-detail-modal')) await openDetail(task.id);
      await refresh({ silent: true });
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  async function ackTask(id) {
    try {
      await VW.api.task.ack(id);
      VW.toast.show('已查收');
      if (VW.modal.isOpen('task-detail-modal')) await openDetail(id);
      await refresh({ silent: true });
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  async function cancelTask(id) {
    if (!window.confirm('确认取消该任务？取消后不可恢复。')) return;
    try {
      await VW.api.task.cancel(id, '用户在看板取消');
      VW.toast.show('任务已取消');
      VW.modal.close('task-detail-modal');
      await refresh({ silent: true });
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  /** 执行结果中体现实际用到的能力与知识引用 */
  function capabilityBlockHtml(capabilities) {
    if (!capabilities) return '';
    const rows = [];
    if (capabilities.skills?.length) rows.push(`Skill：${capabilities.skills.join('、')}`);
    if (capabilities.connectors?.length) rows.push(`连接器：${capabilities.connectors.join('、')}`);
    if (capabilities.knowledge?.length) rows.push(`知识库：${capabilities.knowledge.join('、')}`);
    const citations = capabilities.citations || [];
    if (!rows.length && !citations.length) return '';
    return `
      <div class="capability-block">
        ${rows.map((row) => `<div class="automation-line">${escapeHtml(row)}</div>`).join('')}
        ${
          citations.length
            ? `<div class="citation-list">${citations
                .map(
                  (hit) => `<div class="knowledge-hit">
                    <div class="hit-file">${escapeHtml(hit.file)} · ${escapeHtml(hit.library)}</div>
                    <div class="hit-snippet">${escapeHtml(hit.snippet)}</div>
                  </div>`
                )
                .join('')}</div>`
            : ''
        }
      </div>`;
  }

  // ==================== 任务详情 ====================

  async function openDetail(id) {
    try {
      const { task, actionRequest } = await VW.api.task.detail(id);
      detailState = { task, actionRequest };
      renderDetail();
      VW.modal.open('task-detail-modal');
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  function renderDetail() {
    if (!detailState) return;
    const { task, actionRequest } = detailState;
    const body = document.getElementById('task-detail-body');
    const footerCancel = document.getElementById('task-detail-cancel-task');

    document.getElementById('task-detail-title').textContent = task.title;
    footerCancel.classList.toggle('hidden', !['queued', 'running', 'need_action'].includes(task.status));

    const steps = (task.steps || [])
      .map(
        (step) => `
        <div class="step-item step-${step.status}">
          <span class="step-name">${escapeHtml(step.title)}</span>
          <span class="step-state">${step.status === 'done' ? '已完成' : step.status === 'running' ? '执行中' : '待执行'}</span>
          ${step.log ? `<div class="step-log">${escapeHtml(step.log)}</div>` : ''}
        </div>`
      )
      .join('');

    const events = (task.events || [])
      .slice()
      .reverse()
      .map(
        (event) => `<li class="event-item"><span class="event-time">${formatTime(event.at)}</span>${escapeHtml(
          event.message
        )}</li>`
      )
      .join('');

    body.innerHTML = `
      <div class="detail-meta">
        ${statusBadge(task.status)}
        <span>${escapeHtml(assigneeLabel(task.assignee))}</span>
        <span>${escapeHtml(task.trigger.label)}</span>
        <span>优先级 ${escapeHtml(PRIORITY_LABEL[task.priority] || task.priority || '未知')}</span>
        <span>创建于 ${formatTime(task.createdAt)}</span>
      </div>
      <div class="detail-section">
        <div class="detail-label">任务目标</div>
        <p class="detail-text">${escapeHtml(task.goal)}</p>
        ${task.workspace && task.workspace.cwd ? `<p class="detail-sub">工作目录：${escapeHtml(task.workspace.cwd)}</p>` : ''}
      </div>
      ${
        task.status === 'need_action' && actionRequest
          ? `<div class="detail-section">
               <div class="detail-label">需要你的操作</div>
               ${actionBlockHtml(actionRequest, { submit: true })}
             </div>`
          : ''
      }
      ${
        task.status === 'succeeded' && task.result
          ? `<div class="detail-section">
               <div class="detail-label">执行结果</div>
               <div class="result-summary">${escapeHtml(task.result.summary || '')}</div>
               ${task.result.text ? `<div class="request-detail">${escapeHtml(task.result.text)}</div>` : ''}
               <div class="chip-row">${(task.result.artifacts || [])
                 .map((artifact) => `<span class="chip">${escapeHtml(artifact)}</span>`)
                 .join('')}</div>
               ${capabilityBlockHtml(task.result.capabilities)}
             </div>`
          : ''
      }
      <div class="detail-section">
        <div class="detail-label">执行步骤 <span class="progress-text">${task.progress || 0}%</span></div>
        <div class="step-list">${steps || '<p class="detail-sub">尚未开始执行</p>'}</div>
      </div>
      <div class="detail-section">
        <div class="detail-label">时间线</div>
        <ul class="event-list">${events}</ul>
      </div>`;
  }

  // ==================== 新建任务 ====================

  function assigneeOptions() {
    return store.assigneeOptions();
  }

  function fillAssigneeSelect(selectedId) {
    const select = document.getElementById('task-assignee');
    const options = assigneeOptions();
    select.innerHTML = options.map((item) => `<option value="${item.value}">${escapeHtml(item.label)}</option>`).join('');
    if (selectedId && options.some((item) => item.value === selectedId)) select.value = selectedId;
    VW.dropdown.refresh(select);
  }

  function openCreateTask(assigneeId) {
    if (!assigneeOptions().length) {
      VW.toast.show('请先创建 Worker 或 Group');
      return;
    }
    document.getElementById('task-form').reset();
    fillAssigneeSelect(assigneeId);
    VW.modal.open('task-modal');
  }

  function submitCreate(event) {
    event.preventDefault();
    const form = event.target;
    VW.api.task
      .create({
        assigneeId: form.assigneeId.value,
        goal: form.goal.value,
        workspace: form.workspace.value,
        priority: form.priority.value,
        confirmFirst: form.confirmFirst.checked
      })
      .then(async (task) => {
        VW.modal.close('task-modal');
        VW.toast.show(`任务「${task.title}」已创建`);
        await refresh({ silent: true });
      })
      .catch((error) => VW.toast.show(error.message));
  }

  // ==================== 初始化 ====================

  function init() {
    // 页签
    document.querySelectorAll('#dashboard-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#dashboard-tabs .tab').forEach((item) => item.classList.toggle('active', item === tab));
        store.merge('ui', { dashboardTab: tab.dataset.tab });
      });
    });

    // 视图切换（选择结果持久化到设置）
    document.querySelectorAll('#task-view-toggle .view-btn').forEach((button) => {
      button.addEventListener('click', () => {
        const view = button.dataset.view;
        store.merge('settings', { taskView: view });
        VW.api.settings.update({ taskView: view }).catch(() => {});
      });
    });

    // 统计周期
    const statsPeriod = document.getElementById('stats-period');
    statsPeriod.value = store.state.filters.statsPeriod;
    statsPeriod.addEventListener('change', (event) => {
      store.state.filters.statsPeriod = event.target.value;
      VW.api.settings.update({ period: event.target.value }).catch(() => {});
      refresh({ silent: true });
    });

    // 筛选栏
    const filters = store.state.filters.task;
    filters.period = statsPeriod.value;
    const filterPeriod = document.getElementById('filter-period');
    filterPeriod.value = filters.period;
    filterPeriod.addEventListener('change', (event) => {
      filters.period = event.target.value;
      refresh();
    });

    document.getElementById('task-search').addEventListener(
      'input',
      debounce((event) => {
        filters.keyword = event.target.value.trim();
        refresh();
      }, 200)
    );
    ['triggerType', 'status'].forEach((key) => {
      const id = key === 'triggerType' ? 'filter-trigger' : 'filter-status';
      document.getElementById(id).addEventListener('change', (event) => {
        filters[key] = event.target.value;
        refresh();
      });
    });
    document.getElementById('filter-assignee').addEventListener('change', (event) => {
      filters.assigneeId = event.target.value;
      refresh();
    });

    // 队列操作（事件委托）
    document.getElementById('dashboard-tab-list').addEventListener('click', (event) => {
      const item = event.target.closest('.queue-item');
      if (!item) return;
      const task = store.state.queue.action.concat(store.state.queue.result).find((t) => t.id === item.dataset.id);
      const action = event.target.closest('[data-act]')?.dataset.act;
      if (!action) return;
      if (action === 'detail') return openDetail(item.dataset.id);
      if (action === 'ack') return ackTask(item.dataset.id);
      if (action === 'submit' && task) return submitAnswer(item, task, task.actionRequest);
      return undefined;
    });

    // 队列内选项切换
    document.getElementById('dashboard-tab-list').addEventListener('click', (event) => {
      const choice = event.target.closest('.choice-btn');
      if (!choice) return;
      choice.parentElement.querySelectorAll('.choice-btn').forEach((item) => item.classList.remove('active'));
      choice.classList.add('active');
    });

    // 全部任务：行内操作 + 点击行查看详情
    ['task-list-view', 'task-board-view'].forEach((id) => {
      document.getElementById(id).addEventListener('click', (event) => {
        const holder = event.target.closest('[data-id]');
        if (!holder) return;
        const action = event.target.closest('[data-act]')?.dataset.act || 'detail';
        if (action === 'ack') return ackTask(holder.dataset.id);
        if (action === 'cancel') return cancelTask(holder.dataset.id);
        return openDetail(holder.dataset.id);
      });
    });

    // 任务详情
    document.getElementById('task-detail-body').addEventListener('click', (event) => {
      const choice = event.target.closest('.choice-btn');
      if (choice) {
        choice.parentElement.querySelectorAll('.choice-btn').forEach((item) => item.classList.remove('active'));
        choice.classList.add('active');
        return;
      }
      if (event.target.closest('[data-act="submit-answer"]') && detailState) {
        submitAnswer(document.getElementById('task-detail-body'), detailState.task, detailState.actionRequest);
      }
    });
    document.getElementById('task-detail-close').addEventListener('click', () => VW.modal.close('task-detail-modal'));
    document.getElementById('task-detail-ok').addEventListener('click', () => VW.modal.close('task-detail-modal'));
    document.getElementById('task-detail-cancel-task').addEventListener('click', () => {
      if (detailState) cancelTask(detailState.task.id);
    });

    // 新建任务
    document.getElementById('new-task-btn').addEventListener('click', () => openCreateTask());
    document.getElementById('task-form').addEventListener('submit', submitCreate);
    document.getElementById('task-modal-close').addEventListener('click', () => VW.modal.close('task-modal'));
    document.getElementById('task-modal-cancel').addEventListener('click', () => VW.modal.close('task-modal'));

    // 派发者下拉里的 Worker/Group 列表变化时同步刷新
    store.on(['workers', 'groups'], () => {
      if (VW.modal.isOpen('task-modal')) fillAssigneeSelect(document.getElementById('task-assignee').value);
      renderAssigneeFilter();
    });
    store.on(['queue', 'ui', 'stats'], () => {
      renderTabs();
      renderStats();
    });
    store.on('tasks', renderTaskList);
    store.on('settings', renderTaskList);

    renderAll();
  }

  /** 「全部任务」的执行者筛选器：随 Worker/Group 数据变化重建 */
  function renderAssigneeFilter() {
    const select = document.getElementById('filter-assignee');
    const current = store.state.filters.task.assigneeId;
    select.innerHTML = ['<option value="">全部</option>']
      .concat(assigneeOptions().map((item) => `<option value="${item.value}">${escapeHtml(item.label)}</option>`))
      .join('');
    if (current && assigneeOptions().some((item) => item.value === current)) select.value = current;
    else if (current) {
      store.state.filters.task.assigneeId = '';
    }
    VW.dropdown.refresh(select);
  }

  /** 事件驱动的详情刷新：仅刷新当前打开的任务，且用户正在填写操作时不打断 */
  function syncDetail(taskId) {
    if (!detailState || detailState.task.id !== taskId) return;
    const pending = detailState.task.status === 'need_action' && !detailState.actionRequest?.answeredAt;
    if (pending) return;
    openDetail(taskId);
  }

  return { init, refresh, refreshSoon, openCreateTask, openDetail, syncDetail, renderAssigneeFilter };
})();