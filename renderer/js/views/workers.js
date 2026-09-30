/**
 * Worker 管理页：Worker / Group 列表、筛选、新建、从卡片发起任务
 */
window.VW = window.VW || {};

VW.views = VW.views || {};

VW.views.workers = (() => {
  const { escapeHtml, debounce } = VW.util;
  const store = VW.store;
  const PLUS_ICON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  /** 按筛选条件刷新列表（请求版本号：过期响应不覆盖新状态） */
  let refreshSeq = 0;

  async function refresh() {
    const seq = ++refreshSeq;
    try {
      const [workerList, groups] = await Promise.all([
        VW.api.worker.list(store.state.filters.worker),
        VW.api.group.list()
      ]);
      if (seq !== refreshSeq) return;
      store.set({ workerList, groups });
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  /** 全量刷新：新建/删除后同步侧边栏、任务派发下拉等全量数据 */
  async function refreshAll() {
    const seq = ++refreshSeq;
    try {
      const [workers, workerList, groups] = await Promise.all([
        VW.api.worker.list(),
        VW.api.worker.list(store.state.filters.worker),
        VW.api.group.list()
      ]);
      if (seq !== refreshSeq) return;
      store.set({ workers, workerList, groups });
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  function render() {
    const grid = document.getElementById('worker-grid');
    const empty = document.getElementById('worker-empty');
    const actionBtn = document.getElementById('worker-empty-action');
    const { manageSeg } = store.state.ui;
    const groups = store.state.groups;

    grid.innerHTML = '';
    document.querySelectorAll('#manage-segmented .segment').forEach((segment) => {
      segment.classList.toggle('active', segment.dataset.seg === manageSeg);
    });

    if (manageSeg === 'group') {
      document.getElementById('worker-count-label').textContent = `${groups.length} 个 Group`;
      actionBtn.innerHTML = `${PLUS_ICON}新建 Group`;
      if (!groups.length) {
        empty.classList.remove('hidden');
        empty.querySelector('.empty-title').textContent = '暂无 Group';
        empty.querySelector('.empty-desc').textContent = '创建 Group 后，可以将多个 Worker 编组协同工作。';
        return;
      }
      empty.classList.add('hidden');
      groups.forEach((group) => {
        const card = document.createElement('div');
        card.className = 'worker-card';
        card.innerHTML = `
          <div class="worker-card-head">
            <span class="avatar avatar-group">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 19v-1a6 6 0 0 1 12 0v1"/><circle cx="18" cy="10" r="2.4"/><path d="M15.5 19v-.6a4.4 4.4 0 0 1 5.5-4.2"/></svg>
            </span>
            <div>
              <div class="worker-card-name">${escapeHtml(group.name)}</div>
              <div class="worker-card-role">${group.memberCount} 位成员${group.leadWorkerId ? ' · 已设组长' : ''}</div>
            </div>
          </div>
          <div class="worker-card-desc">${group.desc ? escapeHtml(group.desc) : '暂无描述'}</div>
          <div class="group-members">${
            group.members.length
              ? group.members
                  .slice(0, 5)
                  .map((member) => `<span class="chip">${escapeHtml(member.name)}</span>`)
                  .join('')
              : '<span class="chip chip-muted">暂无成员</span>'
          }</div>
          <div class="worker-card-foot">
            <span class="badge">可协同</span>
            <div class="worker-card-actions">
              <button class="mini-btn" data-act="start">新建任务</button>
              <button class="mini-btn" data-act="edit-group">编辑</button>
              <button class="mini-btn" data-act="remove-group">删除</button>
            </div>
          </div>`;
        card.querySelector('[data-act="start"]').addEventListener('click', () =>
          VW.views.dashboard.openCreateTask(group.id)
        );
        card.querySelector('[data-act="edit-group"]').addEventListener('click', () => openGroupModal(group));
        card.querySelector('[data-act="remove-group"]').addEventListener('click', () => removeGroup(group));
        grid.appendChild(card);
      });
      return;
    }

    const workers = store.state.workerList;
    document.getElementById('worker-count-label').textContent = `${workers.length} 个 Worker`;
    actionBtn.innerHTML = `${PLUS_ICON}新建 Worker`;

    if (!workers.length) {
      empty.classList.remove('hidden');
      empty.querySelector('.empty-title').textContent = '暂无 Worker';
      empty.querySelector('.empty-desc').textContent = '创建 Worker 后，可以在这里集中管理 Worker。';
      return;
    }

    empty.classList.add('hidden');
    workers.forEach((worker) => {
      const card = document.createElement('div');
      card.className = 'worker-card';
      card.innerHTML = `
        <div class="worker-card-head">
          <span class="avatar" style="background:${VW.util.safeStyle(worker.avatarColor, '#eef0f2')}">${escapeHtml(worker.name.slice(0, 1))}</span>
          <div>
            <div class="worker-card-name">${escapeHtml(worker.name)}</div>
            <div class="worker-card-role">${escapeHtml(worker.role)} · ${escapeHtml(worker.envLabel)}</div>
          </div>
        </div>
        <div class="worker-card-desc">${worker.desc ? escapeHtml(worker.desc) : '暂无描述'}</div>
        <div class="worker-card-foot">
          <span class="badge${worker.status === 'offline' ? ' offline' : ''}">
            ${worker.status === 'offline' ? '' : '<span class="status-dot"></span>'}${worker.status === 'offline' ? '离线' : '在线'}
          </span>
          <div class="worker-card-actions">
            <button class="mini-btn" data-act="start">开始任务</button>
            <button class="mini-btn" data-act="mount">能力挂载${worker.capabilityCount ? ` (${worker.capabilityCount})` : ''}</button>
            <button class="mini-btn" data-act="share">分享</button>
            <button class="mini-btn" data-act="edit">编辑</button>
            <button class="mini-btn" data-act="remove">删除</button>
          </div>
        </div>`;
      card.querySelector('[data-act="start"]').addEventListener('click', () =>
        VW.views.dashboard.openCreateTask(worker.id)
      );
      card.querySelector('[data-act="mount"]').addEventListener('click', () =>
        VW.views.capabilities.openMount(worker.id)
      );
      card.querySelector('[data-act="share"]').addEventListener('click', () =>
        VW.views.capabilities.openShare('worker', worker.id)
      );
      card.querySelector('[data-act="edit"]').addEventListener('click', () => openWorkerModal(worker));
      card.querySelector('[data-act="remove"]').addEventListener('click', () => removeWorker(worker));
      grid.appendChild(card);
    });
  }

  // ==================== 编辑 / 删除 Worker 与 Group ====================

  /** 当前编辑对象 id；为空表示新建 */
  let editingWorkerId = null;
  let editingGroupId = null;

  function openWorkerModal(worker) {
    editingWorkerId = worker ? worker.id : null;
    const form = document.getElementById('worker-form');
    form.reset();
    document.getElementById('worker-modal-title').textContent = worker ? '编辑 Worker' : '新建 Worker';
    document.getElementById('worker-form-submit').textContent = worker ? '保存' : '创建';
    if (worker) {
      form.name.value = worker.name;
      form.role.value = worker.role;
      form.querySelector(`input[name="env"][value="${worker.env === 'local' ? '本地' : '云端'}"]`).checked = true;
      form.desc.value = worker.desc || '';
    }
    VW.modal.open('worker-modal');
  }

  async function removeWorker(worker) {
    if (!worker) return;
    if (
      !window.confirm(
        `确认删除 Worker「${worker.name}」？\n其名下聊天绑定会一并清理，执行者指向它的自动任务将被停用。`
      )
    )
      return;
    try {
      const result = await VW.api.worker.remove(worker.id);
      const notes = [];
      if (result.disabledAutomations?.length) notes.push(`${result.disabledAutomations.length} 个自动任务已停用`);
      if (result.removedBindings) notes.push(`${result.removedBindings} 条聊天绑定已清理`);
      VW.toast.show(`Worker「${worker.name}」已删除${notes.length ? `（${notes.join('，')}）` : ''}`);
      await refreshAll();
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  async function removeGroup(group) {
    if (!window.confirm(`确认删除 Group「${group.name}」？执行者指向它的自动任务将被停用，成员 Worker 不受影响。`)) return;
    try {
      const result = await VW.api.group.remove(group.id);
      const disabled = result.disabledAutomations?.length || 0;
      VW.toast.show(`Group「${group.name}」已删除${disabled ? `（${disabled} 个自动任务已停用）` : ''}`);
      await refreshAll();
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  // ==================== 新建 / 编辑 Worker ====================

  function submitWorker(event) {
    event.preventDefault();
    const form = event.target;
    const payload = {
      name: form.name.value,
      role: form.role.value,
      env: form.env.value,
      desc: form.desc.value
    };
    const request = editingWorkerId
      ? VW.api.worker.update(editingWorkerId, payload)
      : VW.api.worker.create(payload);
    request
      .then(async (worker) => {
        VW.modal.close('worker-modal');
        await refreshAll();
        VW.toast.show(editingWorkerId ? `Worker「${worker.name}」已保存` : `数字员工「${worker.name}」创建成功`);
      })
      .catch((error) => VW.toast.show(error.message));
  }

  // ==================== 新建 / 编辑 Group ====================

  function openGroupModal(group) {
    editingGroupId = group ? group.id : null;
    const form = document.getElementById('group-form');
    form.reset();
    document.getElementById('group-modal-title').textContent = group ? '编辑 Group' : '新建 Group';
    document.getElementById('group-form-submit').textContent = group ? '保存' : '创建';
    const list = document.getElementById('group-member-list');
    if (!store.state.workers.length) {
      list.innerHTML = '<p class="empty-desc">还没有 Worker，可先创建 Worker 再编组。</p>';
    } else {
      const memberIds = new Set(group ? group.members.map((member) => member.id) : []);
      list.innerHTML = store.state.workers
        .map(
          (worker) => `
        <label class="member-option">
          <input type="checkbox" value="${worker.id}" ${memberIds.has(worker.id) ? 'checked' : ''} />
          <span class="avatar avatar-sm" style="background:${VW.util.safeStyle(worker.avatarColor, '#eef0f2')}">${escapeHtml(worker.name.slice(0, 1))}</span>
          <span class="member-name">${escapeHtml(worker.name)}</span>
          <span class="member-role">${escapeHtml(worker.role)}</span>
        </label>`
        )
        .join('');
    }
    if (group) {
      form.name.value = group.name;
      form.desc.value = group.desc || '';
    }
    VW.modal.open('group-modal');
  }

  function submitGroup(event) {
    event.preventDefault();
    const form = event.target;
    const memberIds = Array.from(form.querySelectorAll('#group-member-list input:checked')).map((input) => input.value);
    const payload = { name: form.name.value, desc: form.desc.value, memberIds };
    const request = editingGroupId ? VW.api.group.update(editingGroupId, payload) : VW.api.group.create(payload);
    request
      .then(async (group) => {
        VW.modal.close('group-modal');
        await refreshAll();
        VW.toast.show(editingGroupId ? `Group「${group.name}」已保存` : `Group「${group.name}」创建成功`);
      })
      .catch((error) => VW.toast.show(error.message));
  }

  // ==================== 初始化 ====================

  function init() {
    // 分段切换
    document.querySelectorAll('#manage-segmented .segment').forEach((segment) => {
      segment.addEventListener('click', () => {
        store.merge('ui', { manageSeg: segment.dataset.seg });
      });
    });

    // 筛选器
    const filters = store.state.filters.worker;
    const search = document.getElementById('worker-search');
    search.value = filters.keyword;
    search.addEventListener(
      'input',
      debounce((event) => {
        store.setFilters('worker', { keyword: event.target.value.trim() });
        refresh();
      }, 200)
    );

    const bindFilter = (id, key, defaultValue) => {
      const select = document.getElementById(id);
      if (defaultValue !== undefined) select.value = defaultValue;
      select.addEventListener('change', (event) => {
        store.setFilters('worker', { [key]: event.target.value });
        refresh();
      });
    };
    bindFilter('worker-filter-status', 'status', filters.status);
    bindFilter('worker-filter-role', 'role');
    bindFilter('worker-filter-env', 'env');
    bindFilter('worker-filter-sort', 'sort');

    // 新建入口（统一经 openWorkerModal 清空编辑态）
    document.getElementById('new-worker-btn').addEventListener('click', () => openWorkerModal(null));
    document.getElementById('quick-new-worker').addEventListener('click', () => openWorkerModal(null));
    document.getElementById('worker-empty-action').addEventListener('click', () => {
      if (store.state.ui.manageSeg === 'group') openGroupModal(null);
      else openWorkerModal(null);
    });

    document.getElementById('worker-form').addEventListener('submit', submitWorker);
    document.getElementById('group-form').addEventListener('submit', submitGroup);

    // 导入资源包（Worker / WorkerFlow）
    document.getElementById('import-worker-btn').addEventListener('click', async () => {
      try {
        const file = await VW.api.app.openFile();
        if (file.canceled) return;
        let payload = null;
        try {
          payload = JSON.parse(file.content);
        } catch (error) {
          throw new Error('文件内容不是合法的 JSON');
        }
        await VW.views.capabilities.importAndReport(payload);
        await refreshAll();
      } catch (error) {
        VW.toast.show(error.message);
      }
    });

    // 分享记录 → 跳到「能力与资源 · 公开项目」
    document.getElementById('share-records-btn').addEventListener('click', () => {
      document.querySelector('.nav-item[data-page="capabilities"]').click();
      VW.views.capabilities.showSection('share');
    });
    document.getElementById('worker-modal-close').addEventListener('click', () => VW.modal.close('worker-modal'));
    document.getElementById('worker-modal-cancel').addEventListener('click', () => VW.modal.close('worker-modal'));
    document.getElementById('group-modal-close').addEventListener('click', () => VW.modal.close('group-modal'));
    document.getElementById('group-modal-cancel').addEventListener('click', () => VW.modal.close('group-modal'));

    store.on(['workerList', 'groups', 'ui'], render);
    render();
  }

  return { init, refresh, refreshAll, render, openGroupModal };
})();