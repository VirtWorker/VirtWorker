/**
 * @Worker 页：IM 连接管理、聊天接入申请审批、聊天绑定表格、开通向导、模拟接收消息。
 * 会话链路的业务规则（@ 提及解析、申请审批、绑定唯一性）都在主进程 chat-service，本层只做渲染与提交。
 */
window.VW = window.VW || {};

VW.views = VW.views || {};

VW.views.atworker = (() => {
  const { escapeHtml, formatTime, debounce } = VW.util;
  const store = VW.store;

  const CHAT_TYPE_LABEL = { group: '群聊', direct: '单聊' };

  /** 开通向导的临时状态（页面会话级，不进全局 store） */
  const wizard = { step: 1, connectionId: null, chats: [], chatId: null, chatName: '', chatType: 'group' };
  /** 当前编辑的绑定 id */
  let editingBindingId = null;
  /** IM 平台目录（弹窗首次打开时拉取一次） */
  let platformsCache = null;

  // ==================== 数据 ====================

  /** 过期响应防护统一走 api.latest（O9）。绑定与连接用不同 key：
   *  修复原先共享同一 refreshSeq 时「两类互不相关请求互相作废」的隐患 */
  function refresh() {
    return VW.api
      .latest(
        'atworker',
        () =>
          Promise.all([
            VW.api.chat.listBindings(store.state.filters.atworker),
            VW.api.chat.listBindings({}),
            VW.api.chat.stats()
          ]),
        ([filtered, all, stats]) =>
          store.set({ chatBindingList: filtered.items, chatBindings: all.items, chatStats: stats })
      )
      .catch((error) => VW.toast.fromError(error));
  }

  function refreshConnections() {
    return VW.api
      .latest(
        'atworker-connections',
        () => VW.api.chat.listConnections(),
        (connections) => store.set({ chatConnections: connections })
      )
      .catch((error) => VW.toast.fromError(error));
  }

  // ==================== 渲染：统计角标 / 筛选 / 表格 ====================

  function renderBadge() {
    const badge = document.getElementById('chat-request-badge');
    const pending = store.state.chatStats.pendingRequests || 0;
    badge.textContent = pending > 99 ? '99+' : String(pending);
    badge.classList.toggle('hidden', pending === 0);
  }

  /** 模型筛选选项：随绑定数据重建（保持既有选中值，失效时回退「全部」） */
  function renderModelFilter() {
    const select = document.getElementById('at-filter-model');
    const current = store.state.filters.atworker.model;
    const models = [...new Set(store.state.chatBindings.map((item) => item.model).filter(Boolean))];
    select.innerHTML = ['<option value="">全部</option>']
      .concat(models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`))
      .join('');
    select.value = models.includes(current) ? current : '';
    VW.dropdown.refresh(select);
  }

  /** 模型建议列表（向导 / 编辑 / 申请审批共用的 datalist） */
  function renderModelOptions() {
    const models = [...new Set(store.state.chatBindings.map((item) => item.model).filter(Boolean))];
    document.getElementById('chat-model-options').innerHTML = ['默认']
      .concat(models)
      .map((model) => `<option value="${escapeHtml(model)}"></option>`)
      .join('');
  }

  function rowHtml(item) {
    // 健康态由主进程结构化下发（连接与 Worker 均存在），渲染层不再靠文案反推
    const healthy = Boolean(item.healthy);
    return `
      <tr data-id="${item.id}">
        <td>
          <div>${escapeHtml(item.chatName)}</div>
          <span class="meta-chip">${escapeHtml(item.chatTypeLabel)}</span>
        </td>
        <td>${escapeHtml(item.connectionName)}</td>
        <td>${escapeHtml(item.workerName)}</td>
        <td>${item.workspace ? escapeHtml(item.workspace) : '—'}</td>
        <td>${escapeHtml(item.model)}</td>
        <td><span class="status-badge ${healthy ? 'status-done' : 'status-failed'}">${healthy ? '正常' : '异常'}</span></td>
        <td>
          <label class="switch" title="${item.enabled ? '点击停用' : '点击启用'}">
            <input type="checkbox" data-act="toggle" ${item.enabled ? 'checked' : ''} />
            <span class="switch-track"></span>
          </label>
        </td>
        <td>
          <button class="mini-btn" data-act="edit">编辑</button>
          <button class="mini-btn" data-act="simulate">模拟消息</button>
          <button class="mini-btn" data-act="unbind">解绑</button>
        </td>
      </tr>`;
  }

  function renderTable() {
    VW.util.renderList({
      container: document.getElementById('atworker-table-body'),
      empty: document.getElementById('atworker-empty'),
      items: store.state.chatBindingList,
      itemHtml: rowHtml
    });
  }

  function render() {
    renderBadge();
    renderModelFilter();
    renderModelOptions();
    renderTable();
  }

  // ==================== IM 连接管理 ====================

  async function ensurePlatforms() {
    if (platformsCache) return;
    try {
      platformsCache = await VW.api.chat.platforms();
    } catch (error) {
      platformsCache = [];
    }
    const select = document.getElementById('chat-connection-platform');
    select.innerHTML = platformsCache
      .map(
        (platform) => `
        <option value="${escapeHtml(platform.key)}" ${platform.available ? '' : 'disabled'}>
          ${escapeHtml(platform.label)}${platform.available ? '' : '（后续版本）'}
        </option>`
      )
      .join('');
    VW.dropdown.refresh(select);
    syncSecretVisibility();
  }

  function syncSecretVisibility() {
    const platform = (platformsCache || []).find((item) => item.key === document.getElementById('chat-connection-platform').value);
    document.getElementById('chat-connection-secret-item').classList.toggle('hidden', !platform?.requiresCredential);
  }

  function renderConnections() {
    const list = document.getElementById('chat-connection-list');
    const empty = document.getElementById('chat-connection-empty');
    const items = store.state.chatConnections;
    if (!items.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.innerHTML = items
      .map(
        (connection) => `
      <div class="connection-item" data-id="${connection.id}">
        <div>
          <div class="connection-name">${escapeHtml(connection.name)}</div>
          <div class="connection-meta">
            <span class="meta-chip">${escapeHtml(connection.platformLabel)}</span>
            <span class="status-badge status-done">已连接</span>
            ${connection.credentialMask ? `<span class="connection-cred">凭据 ${escapeHtml(connection.credentialMask)}${connection.encrypted ? '' : '（未加密存储）'}</span>` : ''}
          </div>
        </div>
        <div class="worker-card-actions">
          <button class="mini-btn" data-act="edit-connection">编辑</button>
          <button class="mini-btn" data-act="remove-connection">删除</button>
        </div>
      </div>`
      )
      .join('');
  }

  async function openConnections() {
    await Promise.all([refreshConnections(), ensurePlatforms()]);
    renderConnections();
    VW.modal.open('chat-connection-modal');
  }

  async function submitConnection(event) {
    event.preventDefault();
    const form = event.target;
    await VW.util.withSubmitting(form, async () => {
      const connection = await VW.api.chat.createConnection({
        platform: document.getElementById('chat-connection-platform').value,
        name: document.getElementById('chat-connection-name').value,
        secret: document.getElementById('chat-connection-secret').value
      });
      VW.toast.show(`连接「${connection.name}」已创建`);
      document.getElementById('chat-connection-form').reset();
      syncSecretVisibility();
      await refreshConnections();
      renderConnections();
    });
  }

  // ==================== 编辑 / 凭据轮换连接 ====================

  let editingConnectionId = null;

  function openConnectionEdit(id) {
    const connection = store.state.chatConnections.find((item) => item.id === id);
    if (!connection) return;
    editingConnectionId = id;
    document.getElementById('chat-conn-edit-platform').textContent = connection.platformLabel;
    document.getElementById('chat-conn-edit-name').value = connection.name;
    document.getElementById('chat-conn-edit-secret').value = '';
    document.getElementById('chat-conn-edit-mask').textContent = connection.credentialMask
      ? `当前凭据：${connection.credentialMask}${connection.encrypted ? '' : '（未加密存储）'}`
      : '该平台无需访问凭据';
    VW.modal.open('chat-conn-edit-modal');
  }

  async function submitConnectionEdit(event) {
    event.preventDefault();
    if (!editingConnectionId) return;
    try {
      const patch = { name: document.getElementById('chat-conn-edit-name').value };
      const secret = document.getElementById('chat-conn-edit-secret').value;
      if (secret) patch.secret = secret; // 留空表示不更换凭据
      const connection = await VW.api.chat.updateConnection(editingConnectionId, patch);
      VW.toast.show(`连接「${connection.name}」已保存`);
      VW.modal.close('chat-conn-edit-modal');
      await refreshConnections();
      renderConnections();
      await refresh();
    } catch (error) {
      VW.toast.fromError(error);
    }
  }

  async function removeConnection(id) {
    const connection = store.state.chatConnections.find((item) => item.id === id);
    await VW.util.submitAction(
      async () => {
        await VW.api.chat.removeConnection(id);
        await refreshConnections();
        renderConnections();
        await refresh();
      },
      {
        confirm: `确认删除连接「${connection ? connection.name : id}」？其聊天绑定与待审申请会一并删除。`,
        success: '连接已删除'
      }
    );
  }

  // ==================== 开通向导 ====================

  async function openWizard() {
    wizard.step = 1;
    wizard.connectionId = null;
    wizard.chats = [];
    wizard.chatId = null;
    await refreshConnections();
    renderWizard();
    VW.modal.open('chat-wizard-modal');
  }

  function renderWizard() {
    document.querySelectorAll('#chat-wizard-steps .wizard-step').forEach((step) => {
      const value = Number(step.dataset.step);
      step.classList.toggle('active', value === wizard.step);
      step.classList.toggle('done', value < wizard.step);
    });
    [1, 2, 3].forEach((step) => {
      document.getElementById(`chat-wizard-step-${step}`).classList.toggle('hidden', step !== wizard.step);
    });
    document.getElementById('chat-wizard-prev').classList.toggle('hidden', wizard.step === 1);
    document.getElementById('chat-wizard-next').textContent = wizard.step === 3 ? '保存并开通' : '下一步';

    if (wizard.step === 1) renderWizardConnections();
    if (wizard.step === 2) renderWizardChats();
    if (wizard.step === 3) fillWorkerSelect('chat-wizard-worker');
  }

  function renderWizardConnections() {
    const wrap = document.getElementById('chat-wizard-step-1');
    const connections = store.state.chatConnections;
    if (!connections.length) {
      wrap.innerHTML = `
        <div class="empty-block plain">
          <h4 class="empty-title">还没有 IM 连接</h4>
          <p class="empty-desc">先创建一个 IM 连接，再继续开通。</p>
          <button class="btn btn-primary" id="chat-wizard-new-connection">新建连接</button>
        </div>`;
      document.getElementById('chat-wizard-new-connection').addEventListener('click', openConnections);
      return;
    }
    wrap.innerHTML = connections
      .map(
        (connection) => `
      <div class="wizard-option ${connection.id === wizard.connectionId ? 'selected' : ''}" role="button" tabindex="0" data-value="${connection.id}">
        <span class="wizard-option-title">${escapeHtml(connection.name)}</span>
        <span class="meta-chip">${escapeHtml(connection.platformLabel)}</span>
      </div>`
      )
      .join('');
    wrap.querySelectorAll('.wizard-option').forEach((option) => {
      option.addEventListener('click', () => {
        wizard.connectionId = option.dataset.value;
        renderWizardConnections();
      });
    });
  }

  async function renderWizardChats() {
    const wrap = document.getElementById('chat-wizard-step-2');
    let chats = [];
    let reason = '';
    if (wizard.connectionId) {
      try {
        const result = await VW.api.chat.listChats(wizard.connectionId);
        chats = result.chats;
        reason = result.reason;
      } catch (error) {
        VW.toast.fromError(error);
      }
    }
    wizard.chats = chats;

    wrap.innerHTML = `
      ${reason ? `<p class="form-hint">${escapeHtml(reason)}</p>` : ''}
      ${chats.length ? chats.map((chat) => `
        <div class="wizard-option ${chat.chatId === wizard.chatId ? 'selected' : ''}" role="button" tabindex="0" data-chat-id="${escapeHtml(chat.chatId)}">
          <span class="wizard-option-title">${escapeHtml(chat.chatName)}</span>
          <span class="meta-chip">${CHAT_TYPE_LABEL[chat.chatType] || chat.chatType}</span>
        </div>`).join('') : '<p class="form-hint">该连接暂无可选聊天，可在下方手动填写。</p>'}
      <div class="wizard-divider">或手动填写聊天</div>
      <div class="form-row">
        <div class="form-item">
          <label class="form-label">聊天名称</label>
          <input type="text" id="chat-wizard-manual-name" placeholder="例如：客户成功群" maxlength="60" />
        </div>
        <div class="form-item">
          <label class="form-label">聊天类型</label>
          <select id="chat-wizard-manual-type" class="modal-select">
            <option value="group">群聊</option>
            <option value="direct">单聊</option>
          </select>
        </div>
      </div>`;
    VW.dropdown.enhanceAll(wrap);
    wrap.querySelectorAll('.wizard-option').forEach((option) => {
      option.addEventListener('click', () => {
        wizard.chatId = option.dataset.chatId;
        renderWizardChats();
      });
    });
  }

  function fillWorkerSelect(selectId, selectedId) {
    const select = document.getElementById(selectId);
    const workers = store.state.workers;
    select.innerHTML = workers
      .map((worker) => `<option value="${escapeHtml(worker.id)}">${escapeHtml(worker.name)}</option>`)
      .join('');
    const valid = selectedId && workers.some((worker) => worker.id === selectedId);
    select.value = valid ? selectedId : workers[0]?.id || '';
    VW.dropdown.refresh(select);
    return select.value;
  }

  async function wizardNext() {
    if (wizard.step === 1) {
      if (!wizard.connectionId) {
        VW.toast.show('请选择一个 IM 连接');
        return;
      }
      wizard.step = 2;
      wizard.chatId = null;
      await renderWizard();
      return;
    }
    if (wizard.step === 2) {
      const manualName = document.getElementById('chat-wizard-manual-name').value.trim();
      if (manualName) {
        wizard.chatId = manualName;
        wizard.chatName = manualName;
        wizard.chatType = document.getElementById('chat-wizard-manual-type').value;
      } else {
        const chat = wizard.chats.find((item) => item.chatId === wizard.chatId);
        if (!chat) {
          VW.toast.show('请选择一个聊天，或手动填写聊天名称');
          return;
        }
        wizard.chatId = chat.chatId;
        wizard.chatName = chat.chatName;
        wizard.chatType = chat.chatType;
      }
      if (!store.state.workers.length) {
        VW.toast.show('请先在 Worker 管理页创建 Worker');
        return;
      }
      wizard.step = 3;
      renderWizard();
      return;
    }
    await submitWizard();
  }

  async function submitWizard() {
    const workerId = document.getElementById('chat-wizard-worker').value;
    if (!workerId) {
      VW.toast.show('请先创建 Worker');
      return;
    }
    try {
      const binding = await VW.api.chat.createBinding({
        connectionId: wizard.connectionId,
        chatId: wizard.chatId,
        chatName: wizard.chatName,
        chatType: wizard.chatType,
        workerId,
        workspace: document.getElementById('chat-wizard-workspace').value,
        model: document.getElementById('chat-wizard-model').value
      });
      VW.toast.show(`已为「${binding.chatName}」开通 @Worker`);
      VW.modal.close('chat-wizard-modal');
      await refresh();
    } catch (error) {
      VW.toast.fromError(error);
    }
  }

  // ==================== 接入申请 ====================

  /** 申请弹窗渲染版本号：事件密集到达时只保留最新一次渲染 */
  let requestSeq = 0;

  async function openRequests() {
    await renderRequests();
    VW.modal.open('chat-requests-modal');
  }

  /** 保留弹窗中已填写的审批表单（实时刷新重渲染时不丢用户输入） */
  function collectRequestFormState() {
    const saved = {};
    document.querySelectorAll('#chat-request-list .request-item[data-id]').forEach((item) => {
      saved[item.dataset.id] = {
        workerId: item.querySelector('.request-worker')?.value || '',
        workspace: item.querySelector('.request-workspace')?.value || '',
        model: item.querySelector('.request-model')?.value || ''
      };
    });
    return saved;
  }

  function restoreRequestFormState(saved) {
    if (!saved) return;
    document.querySelectorAll('#chat-request-list .request-item[data-id]').forEach((item) => {
      const state = saved[item.dataset.id];
      if (!state) return;
      const select = item.querySelector('.request-worker');
      if (select && [...select.options].some((option) => option.value === state.workerId)) select.value = state.workerId;
      const workspace = item.querySelector('.request-workspace');
      if (workspace) workspace.value = state.workspace;
      const model = item.querySelector('.request-model');
      if (model) model.value = state.model;
    });
  }

  async function renderRequests() {
    const seq = ++requestSeq;
    // 新申请到达（chat:request-updated）时弹窗若已打开也实时刷新，审批人不漏处理
    const formState = VW.modal.isOpen('chat-requests-modal') ? collectRequestFormState() : null;
    let items = [];
    try {
      items = (await VW.api.chat.listRequests({})).items;
    } catch (error) {
      VW.toast.fromError(error);
    }
    if (seq !== requestSeq) return;
    const list = document.getElementById('chat-request-list');
    const empty = document.getElementById('chat-request-empty');
    if (!items.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    const hasWorkers = store.state.workers.length > 0;
    list.innerHTML = items
      .map((request) => {
        if (request.status !== 'pending') {
          const approved = request.status === 'approved';
          return `
          <div class="request-item resolved" data-id="${request.id}">
            <div class="request-head">
              <span class="request-chat">${escapeHtml(request.chatName)}</span>
              <span class="status-badge ${approved ? 'status-done' : 'status-canceled'}">${approved ? '已同意' : '已拒绝'}</span>
            </div>
            <div class="request-meta">${escapeHtml(request.chatTypeLabel)} · ${escapeHtml(request.connectionName)} · 处理于 ${formatTime(request.resolvedAt)}</div>
          </div>`;
        }
        return `
        <div class="request-item" data-id="${request.id}">
          <div class="request-head">
            <span class="request-chat">${escapeHtml(request.chatName)}</span>
            <span class="meta-chip">${escapeHtml(request.chatTypeLabel)}</span>
          </div>
          <div class="request-meta">${escapeHtml(request.connectionName)} · 申请人 ${escapeHtml(request.sender)} · ${formatTime(request.createdAt)}</div>
          ${request.message ? `<div class="request-message">「${escapeHtml(request.message)}」</div>` : ''}
          ${
            hasWorkers
              ? `
            <div class="request-form">
              <div class="form-item">
                <label class="form-label">指派 Worker</label>
                <select class="request-worker modal-select"></select>
              </div>
              <div class="form-row">
                <div class="form-item">
                  <label class="form-label">工作目录</label>
                  <input type="text" class="request-workspace" placeholder="选填" />
                </div>
                <div class="form-item">
                  <label class="form-label">模型</label>
                  <input type="text" class="request-model" list="chat-model-options" placeholder="默认" maxlength="40" />
                </div>
              </div>
              <div class="request-actions">
                <button type="button" class="btn btn-outline btn-sm" data-act="reject-request">拒绝</button>
                <button type="button" class="btn btn-primary btn-sm" data-act="approve-request">同意并开通</button>
              </div>
            </div>`
              : '<p class="form-hint">请先创建 Worker，再处理该申请。</p>'
          }
        </div>`;
      })
      .join('');
    VW.dropdown.enhanceAll(list);
    // 指派 Worker 下拉统一填充（enhance 之后赋值并同步显示）
    list.querySelectorAll('.request-item:not(.resolved)').forEach((item) => {
      const select = item.querySelector('.request-worker');
      fillWorkerSelectById(select);
    });
    // 实时刷新后还原用户已填写的审批表单
    restoreRequestFormState(formState);
  }

  /** 为动态创建的 select 填充 Worker 选项（组件内局部使用） */
  function fillWorkerSelectById(select) {
    const workers = store.state.workers;
    select.innerHTML = workers
      .map((worker) => `<option value="${escapeHtml(worker.id)}">${escapeHtml(worker.name)}</option>`)
      .join('');
    select.value = workers[0]?.id || '';
    VW.dropdown.refresh(select);
  }

  async function onRequestAction(event) {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const item = button.closest('.request-item');
    const id = item?.dataset.id;
    if (!id) return;

    if (button.dataset.act === 'reject-request') {
      try {
        await VW.api.chat.rejectRequest(id);
        VW.toast.show('已拒绝该申请');
        await Promise.all([renderRequests(), refresh()]);
      } catch (error) {
        VW.toast.fromError(error);
      }
      return;
    }
    if (button.dataset.act === 'approve-request') {
      try {
        await VW.api.chat.approveRequest(id, {
          workerId: item.querySelector('.request-worker').value,
          workspace: item.querySelector('.request-workspace').value,
          model: item.querySelector('.request-model').value
        });
        VW.toast.show('已开通 @Worker');
        await Promise.all([renderRequests(), refresh()]);
      } catch (error) {
        VW.toast.fromError(error);
      }
    }
  }

  // ==================== 编辑绑定 ====================

  function openBinding(id) {
    const binding = store.state.chatBindingList.find((item) => item.id === id);
    if (!binding) return;
    if (!store.state.workers.length) {
      VW.toast.show('请先创建 Worker');
      return;
    }
    editingBindingId = id;
    document.getElementById('chat-binding-chat').value = `${binding.chatName}（${binding.chatTypeLabel}）`;
    document.getElementById('chat-binding-connection').value = binding.connectionName;
    fillWorkerSelect('chat-binding-worker', binding.workerId);
    document.getElementById('chat-binding-workspace').value = binding.workspace || '';
    document.getElementById('chat-binding-model').value = binding.model === '默认' ? '' : binding.model;
    VW.modal.open('chat-binding-modal');
  }

  async function submitBinding(event) {
    event.preventDefault();
    try {
      await VW.api.chat.updateBinding(editingBindingId, {
        workerId: document.getElementById('chat-binding-worker').value,
        workspace: document.getElementById('chat-binding-workspace').value,
        model: document.getElementById('chat-binding-model').value
      });
      VW.toast.show('绑定已更新');
      VW.modal.close('chat-binding-modal');
      await refresh();
    } catch (error) {
      VW.toast.fromError(error);
    }
  }

  // ==================== 模拟接收消息 ====================

  async function openSimulate(preselectBindingId) {
    await refreshConnections();
    const connections = store.state.chatConnections;
    if (!connections.length) {
      VW.toast.show('请先创建 IM 连接');
      return;
    }
    const connectionSelect = document.getElementById('chat-simulate-connection');
    connectionSelect.innerHTML = connections
      .map((connection) => `<option value="${connection.id}">${escapeHtml(connection.name)}</option>`)
      .join('');
    const preset = preselectBindingId ? store.state.chatBindings.find((item) => item.id === preselectBindingId) : null;
    if (preset && connections.some((item) => item.id === preset.connectionId)) connectionSelect.value = preset.connectionId;
    VW.dropdown.refresh(connectionSelect);
    await fillSimulateChats(preset ? preset.chatId : null);
    VW.modal.open('chat-simulate-modal');
  }

  /** 聊天下拉：适配器提供的可选聊天 + 该连接下已绑定的聊天（便于向已开通聊天发消息） */
  async function fillSimulateChats(preselectChatId) {
    const connectionId = document.getElementById('chat-simulate-connection').value;
    const chatSelect = document.getElementById('chat-simulate-chat');
    let chats = [];
    try {
      chats = (await VW.api.chat.listChats(connectionId)).chats;
    } catch (error) {
      VW.toast.fromError(error);
    }
    store.state.chatBindings
      .filter((item) => item.connectionId === connectionId)
      .forEach((item) => {
        if (!chats.some((chat) => chat.chatId === item.chatId)) {
          chats.push({ chatId: item.chatId, chatName: item.chatName, chatType: item.chatType });
        }
      });
    chatSelect.innerHTML = chats
      .map(
        (chat) => `
      <option value="${escapeHtml(chat.chatId)}" data-chat-name="${escapeHtml(chat.chatName)}" data-chat-type="${chat.chatType}">
        ${escapeHtml(chat.chatName)}（${CHAT_TYPE_LABEL[chat.chatType] || chat.chatType}）
      </option>`
      )
      .join('');
    if (preselectChatId && chats.some((chat) => chat.chatId === preselectChatId)) chatSelect.value = preselectChatId;
    VW.dropdown.refresh(chatSelect);
  }

  async function submitSimulate(event) {
    event.preventDefault();
    const chatSelect = document.getElementById('chat-simulate-chat');
    const option = chatSelect.options[chatSelect.selectedIndex];
    try {
      const result = await VW.api.chat.simulateInbound({
        connectionId: document.getElementById('chat-simulate-connection').value,
        chatId: chatSelect.value,
        chatName: option?.dataset.chatName || chatSelect.value,
        chatType: option?.dataset.chatType || 'group',
        sender: document.getElementById('chat-simulate-sender').value,
        text: document.getElementById('chat-simulate-text').value
      });
      if (result.kind === 'task_created') VW.toast.show(`消息已转为任务「${result.task.title}」`);
      else if (result.kind === 'request_created') VW.toast.show('该聊天尚未开通，已生成接入申请，等待审批');
      else VW.toast.show(result.message || '消息已忽略');
      VW.modal.close('chat-simulate-modal');
      await refresh();
    } catch (error) {
      VW.toast.fromError(error);
    }
  }

  // ==================== 表格操作 ====================

  function onTableToggle(event) {
    const toggle = event.target.closest('[data-act="toggle"]');
    if (!toggle) return;
    const id = toggle.closest('tr').dataset.id;
    VW.api.chat
      .toggleBinding(id, toggle.checked)
      .then(async () => {
        VW.toast.show(toggle.checked ? '已启用' : '已停用');
        await refresh();
      })
      .catch(async (error) => {
        VW.toast.fromError(error);
        await refresh(); // 失败时回滚界面开关状态
      });
  }

  async function onTableAction(event) {
    const button = event.target.closest('[data-act]');
    if (!button || button.dataset.act === 'toggle') return;
    const id = button.closest('tr').dataset.id;
    if (button.dataset.act === 'edit') return openBinding(id);
    if (button.dataset.act === 'simulate') return openSimulate(id);
    if (button.dataset.act === 'unbind') {
      const binding = store.state.chatBindingList.find((item) => item.id === id);
      await VW.util.submitAction(
        async () => {
          await VW.api.chat.removeBinding(id);
          await refresh();
        },
        {
          confirm: `确认解绑「${binding ? binding.chatName : id}」？解绑后聊天里的消息不再转成任务。`,
          success: '已解绑'
        }
      );
    }
    return undefined;
  }

  // ==================== 初始化 ====================

  function init() {
    // 页面入口
    document.getElementById('open-chat-wizard-btn').addEventListener('click', openWizard);
    document.getElementById('open-connections-btn').addEventListener('click', openConnections);
    document.getElementById('open-requests-btn').addEventListener('click', openRequests);
    document.getElementById('simulate-message-btn').addEventListener('click', () => openSimulate());

    // 弹窗关闭
    VW.modal.bindClose('chat-connection-modal', 'chat-connection-modal-close', 'chat-connection-cancel');
    VW.modal.bindClose('chat-conn-edit-modal', 'chat-conn-edit-modal-close', 'chat-conn-edit-cancel');
    VW.modal.bindClose('chat-wizard-modal', 'chat-wizard-modal-close');
    VW.modal.bindClose('chat-requests-modal', 'chat-requests-modal-close', 'chat-requests-ok');
    VW.modal.bindClose('chat-binding-modal', 'chat-binding-modal-close', 'chat-binding-cancel');
    VW.modal.bindClose('chat-simulate-modal', 'chat-simulate-modal-close', 'chat-simulate-cancel');

    // 表单
    document.getElementById('chat-connection-form').addEventListener('submit', submitConnection);
    document.getElementById('chat-conn-edit-form').addEventListener('submit', submitConnectionEdit);
    document.getElementById('chat-connection-platform').addEventListener('change', syncSecretVisibility);
    document.getElementById('chat-wizard-next').addEventListener('click', wizardNext);
    document.getElementById('chat-wizard-prev').addEventListener('click', () => {
      wizard.step = Math.max(1, wizard.step - 1);
      renderWizard();
    });
    document.getElementById('chat-binding-form').addEventListener('submit', submitBinding);
    document.getElementById('chat-simulate-form').addEventListener('submit', submitSimulate);
    document.getElementById('chat-simulate-connection').addEventListener('change', () => fillSimulateChats());

    // 列表操作（事件委托）
    document.getElementById('chat-connection-list').addEventListener('click', (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const id = button.closest('.connection-item').dataset.id;
      if (button.dataset.act === 'remove-connection') removeConnection(id);
      if (button.dataset.act === 'edit-connection') openConnectionEdit(id);
    });
    document.getElementById('chat-request-list').addEventListener('click', onRequestAction);

    const tbody = document.getElementById('atworker-table-body');
    tbody.addEventListener('change', onTableToggle);
    tbody.addEventListener('click', onTableAction);

    // 筛选器
    document.getElementById('at-filter-keyword').addEventListener(
      'input',
      debounce((event) => {
        store.setFilters('atworker', { keyword: event.target.value });
        refresh();
      }, 200)
    );
    document.getElementById('at-filter-chattype').addEventListener('change', (event) => {
      store.setFilters('atworker', { chatType: event.target.value });
      refresh();
    });
    document.getElementById('at-filter-model').addEventListener('change', (event) => {
      store.setFilters('atworker', { model: event.target.value });
      refresh();
    });
    document.getElementById('at-filter-status').addEventListener('change', (event) => {
      store.setFilters('atworker', { status: event.target.value });
      refresh();
    });

    store.on(['chatBindingList', 'chatBindings', 'chatStats'], render);
    // 审批弹窗打开期间收到新申请/申请更新（角标变化）时实时重渲染列表，审批人不漏处理
    store.on('chatStats', () => {
      if (VW.modal.isOpen('chat-requests-modal')) renderRequests();
    });
    // 向导/连接弹窗打开期间连接数据变化（如从向导内新建连接）时同步刷新对应列表
    store.on('chatConnections', () => {
      if (VW.modal.isOpen('chat-wizard-modal') && wizard.step === 1) renderWizardConnections();
      if (VW.modal.isOpen('chat-connection-modal')) renderConnections();
    });

    render();
  }

  return { init, refresh, render };
})();
