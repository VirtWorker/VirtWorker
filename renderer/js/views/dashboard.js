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

  /** 列表分页：按 50/页增量加载（O8）。refresh 以「累计窗口」拉取（page=1 & pageSize=页数×50），
   *  事件驱动的刷新不会把用户已加载的多页内容折叠回第一页；窗口上限与主进程一致（200） */
  const PAGE_SIZE = 50;
  const PAGE_WINDOW_MAX = 200;
  let listPage = 1;

  async function refresh(options = {}) {
    const { task: filters, statsPeriod } = store.state.filters;
    try {
      // 过期响应防护统一走 api.latest（O9）：快速切换筛选时，后返回的过期响应不覆盖新状态
      await VW.api.latest(
        'dashboard',
        async () => {
          // 队列表由主进程一次算完（21）：不再拉全量周期任务后自行过滤
          const [queue, stats, filtered] = await Promise.all([
            VW.api.task.queue({ period: statsPeriod }),
            VW.api.task.stats({ period: statsPeriod }),
            VW.api.task.list({ ...filters, page: 1, pageSize: listPage * PAGE_SIZE })
          ]);
          return { queue, stats, filtered };
        },
        ({ queue, stats, filtered }) => {
          store.set({
            stats,
            tasks: filtered.items,
            queue,
            tasksMeta: { page: listPage, total: filtered.total, totalPages: filtered.totalPages || 1 }
          });
        }
      );
    } catch (error) {
      if (!options.silent) VW.toast.fromError(error);
      console.error('[dashboard] 任务数据刷新失败:', error);
    }
  }

  const refreshSoon = debounce(() => refresh({ silent: true }), 120);

  /** 轻量刷新：只拉统计（导航角标与统计卡片全局可见）。
   *  看板页隐藏时任务事件走这条路，替代原先的全量 3×IPC 刷新（O9） */
  async function refreshStats() {
    try {
      const stats = await VW.api.task.stats({ period: store.state.filters.statsPeriod });
      store.set({ stats });
    } catch (error) {
      console.error('[dashboard] 统计刷新失败:', error);
    }
  }

  /** 加载更多：扩大累计窗口再刷新（仍走 latest 防过期覆盖） */
  async function loadMore() {
    if (listPage * PAGE_SIZE >= PAGE_WINDOW_MAX) return;
    listPage += 1;
    await refresh({ silent: true });
  }

  /** 「加载更多」按钮的可见性与提示文案（在 renderTaskList 中调用） */
  function listFootState() {
    const meta = store.state.tasksMeta;
    const shown = meta.page * PAGE_SIZE;
    if (shown >= PAGE_WINDOW_MAX && meta.total > shown) {
      return { hasMore: false, hint: `已显示前 ${PAGE_WINDOW_MAX} 条（共 ${meta.total} 条），请缩小筛选范围` };
    }
    return { hasMore: shown < meta.total, hint: '' };
  }

  // ==================== 统计与页签 ====================

  /** 保留队列卡片中已填写的操作内容（重绘竞态防护，与审批弹窗 collectRequestFormState 同款思路）：
   *  任务执行期间 queue 切片变化会触发 renderTabs 全量重建 DOM，
   *  用户正在填写的回答/表单/选项不能因此被清空或在提交时读到空值 */
  function collectQueueFormState() {
    const saved = {};
    document.querySelectorAll('#dashboard-tab-list .queue-item[data-id]').forEach((item) => {
      const inputs = {};
      item.querySelectorAll('.request-input[data-field]').forEach((input) => {
        inputs[input.dataset.field] = input.value;
      });
      const choice = item.querySelector('.choice-btn.active');
      saved[item.dataset.id] = { inputs, choice: choice ? choice.dataset.value : null };
    });
    return saved;
  }

  function restoreQueueFormState(saved) {
    if (!saved) return;
    document.querySelectorAll('#dashboard-tab-list .queue-item[data-id]').forEach((item) => {
      const state = saved[item.dataset.id];
      if (!state) return;
      item.querySelectorAll('.request-input[data-field]').forEach((input) => {
        if (state.inputs[input.dataset.field] !== undefined) input.value = state.inputs[input.dataset.field];
      });
      // 已选中的选项一并恢复（按 value 匹配，选项集合变化时静默放弃）
      if (state.choice !== null) {
        const choice = item.querySelector(`.choice-btn[data-value="${CSS.escape(state.choice)}"]`);
        if (choice) activateChoice(choice);
      }
    });
  }

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

    // 一键查收（F8）：仅在「查收结果」页签且有待查收内容时出现
    const ackAllBtn = document.getElementById('ack-all-btn');
    if (ackAllBtn) {
      ackAllBtn.classList.toggle('hidden', !(store.state.ui.dashboardTab === 'result' && queue.result.length));
    }

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
    // 全量 innerHTML 重建前采集已填写的输入，重建后按 taskId 恢复（重绘竞态不丢用户输入）
    const savedForm = collectQueueFormState();
    container.innerHTML = list
      .map((task) => (tab === 'result' ? resultItemHtml(task) : actionItemHtml(task)))
      .join('');
    restoreQueueFormState(savedForm);
  }

  /** 需要操作：按请求类型渲染选项 / 输入框 */
  function actionItemHtml(task) {
    const request = task.actionRequest || {};
    return `
      <div class="queue-item" tabindex="0" role="button" aria-label="${escapeHtml(task.title)}" data-id="${task.id}">
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
      <div class="queue-item" tabindex="0" role="button" aria-label="${escapeHtml(task.title)}" data-id="${task.id}">
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
    if (['failed', 'canceled'].includes(task.status)) {
      actions.push('<button class="mini-btn" data-act="retry">重试</button>');
    }
    return actions.join('');
  }

  function renderTaskList() {
    const container = document.getElementById('task-list-view');
    const board = document.getElementById('task-board-view');
    const empty = document.getElementById('task-list-empty');
    const foot = document.getElementById('task-list-foot');
    const tasks = store.state.tasks;
    const isBoard = store.state.settings.taskView === 'board';

    document.querySelectorAll('#task-view-toggle .view-btn').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === (isBoard ? 'board' : 'list'));
    });
    container.classList.toggle('hidden', isBoard);
    board.classList.toggle('hidden', !isBoard);

    // 分页窗口尾部（O8）：加载更多 / 截断提示
    const { hasMore, hint } = listFootState();
    if (foot) {
      foot.classList.toggle('hidden', !tasks.length);
      foot.innerHTML = hint
        ? `<span class="form-hint">${escapeHtml(hint)}</span>`
        : hasMore
          ? '<button type="button" class="btn btn-outline btn-sm" id="load-more-btn">加载更多</button>'
          : '';
    }

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
        <div class="task-row" tabindex="0" role="button" aria-label="${escapeHtml(task.title)}" data-id="${task.id}">
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
              <div class="board-card" tabindex="0" role="button" aria-label="${escapeHtml(task.title)}" data-id="${task.id}">
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

  /** 单选按钮组：点中一个即高亮它、取消同组其余（队列与详情弹窗共用） */
  function activateChoice(choice) {
    choice.parentElement.querySelectorAll('.choice-btn').forEach((item) => item.classList.remove('active'));
    choice.classList.add('active');
  }

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
      VW.toast.fromError(error);
    }
  }

  async function ackTask(id) {
    await VW.util.submitAction(() => VW.api.task.ack(id), { success: '已查收' });
    if (VW.modal.isOpen('task-detail-modal')) await openDetail(id);
    await refresh({ silent: true });
  }

  /** 重试失败/已取消任务（F1）：创建新任务重新入队；fromStep='failed' 时从失败步骤断点重跑 */
  async function retryTask(id, { fromStep = null } = {}) {
    const message = fromStep === 'failed'
      ? '确认从失败步骤重试？将创建新任务并沿用此前步骤的结果。'
      : '确认重试该任务？将创建一个新任务重新入队。';
    if (!window.confirm(message)) return;
    const task = await VW.util.submitAction(() => VW.api.task.retry(id, fromStep));
    if (!task) return;
    VW.toast.show(`重试任务「${task.title}」已创建`);
    VW.modal.close('task-detail-modal');
    await refresh({ silent: true });
  }

  /** 一键查收当前周期内全部待查收结果（F8）：批量且不可逆，操作前确认 */
  async function ackAll() {
    const count = store.state.queue.result.length;
    if (!window.confirm(`确认一键查收当前周期内全部 ${count} 条任务结果？查收后将从队列移除。`)) return;
    await VW.util.submitAction(() => VW.api.task.ackAll({ period: store.state.filters.statsPeriod }), {
      success: (result) => (result.acked ? `已查收 ${result.acked} 条任务结果` : '没有待查收的结果')
    });
    await refresh({ silent: true });
  }

  async function cancelTask(id) {
    if (!window.confirm('确认取消该任务？取消后不可恢复。')) return;
    try {
      await VW.api.task.cancel(id, '用户在看板取消');
      VW.toast.show('任务已取消');
      VW.modal.close('task-detail-modal');
      await refresh({ silent: true });
    } catch (error) {
      VW.toast.fromError(error);
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
      VW.toast.fromError(error);
    }
  }

  function renderDetail() {
    if (!detailState) return;
    const { task, actionRequest } = detailState;
    const body = document.getElementById('task-detail-body');
    const footerCancel = document.getElementById('task-detail-cancel-task');

    document.getElementById('task-detail-title').textContent = task.title;
    footerCancel.classList.toggle('hidden', !['queued', 'running', 'need_action'].includes(task.status));

    // 重试入口（F1）：失败任务若有已完成步骤则提供断点重跑，否则整单重试
    const footerRetry = document.getElementById('task-detail-retry');
    const retryable = ['failed', 'canceled'].includes(task.status);
    const hasDoneSteps = (task.steps || []).some((step) => step.status === 'done');
    footerRetry.classList.toggle('hidden', !retryable);
    footerRetry.textContent = retryable && hasDoneSteps ? '从失败步骤重试' : '重试任务';
    if (detailState) detailState.retryFromStep = retryable && hasDoneSteps ? 'failed' : null;

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
    VW.assigneeSelect.fill('task-assignee', { selectedId });
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
      .catch((error) => VW.toast.fromError(error));
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
        VW.api.settings.update({ taskView: view }).catch((error) => VW.toast.show(`视图偏好保存失败：${error.message}`));
      });
    });

    // 统计周期
    const statsPeriod = document.getElementById('stats-period');
    statsPeriod.value = store.state.filters.statsPeriod;
    statsPeriod.addEventListener('change', (event) => {
      store.setFilters({ statsPeriod: event.target.value });
      VW.api.settings.update({ period: event.target.value }).catch((error) => VW.toast.show(`周期偏好保存失败：${error.message}`));
      refresh({ silent: true });
    });

    // 筛选栏（O8：任何筛选变更都把列表窗口重置回第一页）
    const applyTaskFilters = (patch) => {
      listPage = 1;
      store.setFilters('task', patch);
      refresh();
    };
    store.setFilters('task', { period: statsPeriod.value });
    const filterPeriod = document.getElementById('filter-period');
    filterPeriod.value = store.state.filters.task.period;
    filterPeriod.addEventListener('change', (event) => {
      applyTaskFilters({ period: event.target.value });
    });

    document.getElementById('task-search').addEventListener(
      'input',
      debounce((event) => {
        applyTaskFilters({ keyword: event.target.value.trim() });
      }, 200)
    );
    ['triggerType', 'status'].forEach((key) => {
      const id = key === 'triggerType' ? 'filter-trigger' : 'filter-status';
      document.getElementById(id).addEventListener('change', (event) => {
        applyTaskFilters({ [key]: event.target.value });
      });
    });
    document.getElementById('filter-assignee').addEventListener('change', (event) => {
      applyTaskFilters({ assigneeId: event.target.value });
    });

    // 队列操作（事件委托：选项切换 + 按钮动作合并为单一监听，避免同一次点击执行两遍）
    document.getElementById('dashboard-tab-list').addEventListener('click', (event) => {
      const choice = event.target.closest('.choice-btn');
      if (choice) {
        activateChoice(choice);
        return;
      }
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

    // 一键查收（F8）与「加载更多」（O8）：按钮随重渲染重建，统一用事件委托
    document.getElementById('ack-all-btn').addEventListener('click', ackAll);
    document.getElementById('task-list-foot').addEventListener('click', (event) => {
      if (event.target.closest('#load-more-btn')) loadMore();
    });

    // 全部任务：行内操作 + 点击行查看详情
    ['task-list-view', 'task-board-view'].forEach((id) => {
      document.getElementById(id).addEventListener('click', (event) => {
        const holder = event.target.closest('[data-id]');
        if (!holder) return;
        const action = event.target.closest('[data-act]')?.dataset.act || 'detail';
        if (action === 'ack') return ackTask(holder.dataset.id);
        if (action === 'cancel') return cancelTask(holder.dataset.id);
        if (action === 'retry') return retryTask(holder.dataset.id);
        return openDetail(holder.dataset.id);
      });
    });

    // 任务详情
    document.getElementById('task-detail-body').addEventListener('click', (event) => {
      const choice = event.target.closest('.choice-btn');
      if (choice) {
        activateChoice(choice);
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
    document.getElementById('task-detail-retry').addEventListener('click', () => {
      if (detailState) retryTask(detailState.task.id, { fromStep: detailState.retryFromStep ?? null });
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
    // 拆分订阅：轻量刷新（refreshStats）只更新统计卡片，不再连带重建队列 DOM——
    // 此前 stats 也在 renderTabs 的订阅里，统计数字抖动就会触发队列整体重绘
    store.on(['queue', 'ui'], renderTabs);
    store.on('stats', renderStats);
    store.on(['tasks', 'tasksMeta'], renderTaskList);
    store.on('settings', renderTaskList);

    renderAll();
  }

  /** 「全部任务」的执行者筛选器：随 Worker/Group 数据变化重建 */
  function renderAssigneeFilter() {
    const effective = VW.assigneeSelect.fill('filter-assignee', {
      placeholder: '全部',
      selectedId: store.state.filters.task.assigneeId
    });
    if (effective !== store.state.filters.task.assigneeId) {
      store.setFilters('task', { assigneeId: effective });
    }
  }

  /** 事件驱动的详情刷新：仅刷新当前打开的任务，且用户正在填写操作时不打断 */
  function syncDetail(taskId) {
    if (!detailState || detailState.task.id !== taskId) return;
    const pending = detailState.task.status === 'need_action' && !detailState.actionRequest?.answeredAt;
    if (pending) return;
    openDetail(taskId);
  }

  /** 任务被删除时若详情弹窗正展示它，直接关闭（而不是弹「任务不存在」错误） */
  function closeDetail(taskId) {
    if (detailState && detailState.task.id === taskId) {
      detailState = null;
      VW.modal.close('task-detail-modal');
    }
  }

  return { init, refresh, refreshSoon, refreshStats, openCreateTask, openDetail, syncDetail, closeDetail, renderAssigneeFilter };
})();