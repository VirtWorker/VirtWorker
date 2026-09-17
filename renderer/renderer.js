/**
 * VirtWorker 渲染进程入口
 * 职责：装配各视图与组件、绑定全局交互（导航 / 侧边栏 / 未实现入口提示）、
 *       启动时拉取主进程数据并订阅事件。
 * 业务逻辑（任务状态机、统计口径、持久化）全部在主进程，本层只做渲染与提交。
 */
(() => {
  const store = VW.store;
  const { escapeHtml } = VW.util;

  // ==================== 页面路由 ====================

  function switchPage(name) {
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.page === name);
    });
    document.querySelectorAll('.page').forEach((page) => {
      page.classList.toggle('active', page.id === `page-${name}`);
    });
    store.merge('ui', { page: name });
  }

  function bindNavigation() {
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', () => switchPage(item.dataset.page));
    });
  }

  // ==================== 侧边栏 ====================

  function renderSidebar() {
    const { workers, groups, ui } = store.state;
    const keyword = ui.sidebarSearch.trim().toLowerCase();
    const isGroup = ui.sidebarTab === 'group';

    document.getElementById('sidebar-worker-count').textContent = String(workers.length);
    document.getElementById('sidebar-group-count').textContent = String(groups.length);
    document.getElementById('worker-list-hint').textContent = isGroup ? '仅展示已创建的 Group' : '仅展示在线 Worker';

    const workerList = document.getElementById('sidebar-worker-list');
    const groupList = document.getElementById('sidebar-group-list');
    workerList.classList.toggle('hidden', isGroup);
    groupList.classList.toggle('hidden', !isGroup);

    if (isGroup) {
      const matched = groups.filter((group) => !keyword || group.name.toLowerCase().includes(keyword));
      groupList.innerHTML = matched.length
        ? matched
            .map(
              (group) => `
          <div class="sidebar-worker-item" data-group="${group.id}">
            <span class="avatar avatar-sm avatar-group">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 19v-1a6 6 0 0 1 12 0v1"/><circle cx="18" cy="10" r="2.4"/></svg>
            </span>
            <span class="w-name">${escapeHtml(group.name)}</span>
            <span class="w-member">${group.memberCount} 人</span>
          </div>`
            )
            .join('')
        : `<div class="sidebar-empty">${keyword ? '没有匹配的 Group' : '暂无 Group'}</div>`;
      return;
    }

    const online = workers.filter(
      (worker) => worker.status === 'online' && (!keyword || worker.name.toLowerCase().includes(keyword))
    );
    workerList.innerHTML = online.length
      ? online
          .map(
            (worker) => `
        <div class="sidebar-worker-item" data-worker="${worker.id}">
          <span class="avatar avatar-sm" style="background:${worker.avatarColor}">${escapeHtml(worker.name.slice(0, 1))}</span>
          <span class="w-name">${escapeHtml(worker.name)}</span>
          <span class="status-dot" title="在线"></span>
        </div>`
          )
          .join('')
      : `<div class="sidebar-empty">${keyword ? '没有匹配的 Worker' : '暂无在线 Worker'}</div>`;

    document.getElementById('quick-new-worker').classList.toggle('btn-outline', online.length === 0);
  }

  function bindSidebar() {
    document.getElementById('collapse-btn').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('collapsed');
    });

    document.querySelectorAll('#sidebar-worker-tabs .worker-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#sidebar-worker-tabs .worker-tab').forEach((item) =>
          item.classList.toggle('active', item === tab)
        );
        store.merge('ui', { sidebarTab: tab.dataset.wtab });
      });
    });

    // 搜索：展开/收起内联搜索框
    const searchWrap = document.getElementById('sidebar-search-wrap');
    const searchInput = document.getElementById('sidebar-search');
    document.getElementById('sidebar-search-btn').addEventListener('click', () => {
      const willShow = searchWrap.classList.contains('hidden');
      searchWrap.classList.toggle('hidden', !willShow);
      if (willShow) searchInput.focus();
      else {
        searchInput.value = '';
        store.merge('ui', { sidebarSearch: '' });
      }
    });
    searchInput.addEventListener('input', (event) => {
      store.merge('ui', { sidebarSearch: event.target.value });
    });

    // 点击列表项跳转到 Worker 管理页
    const panel = document.querySelector('.sidebar-worker-panel');
    panel.addEventListener('click', (event) => {
      const item = event.target.closest('.sidebar-worker-item');
      if (!item) return;
      if (item.dataset.group) {
        store.merge('ui', { manageSeg: 'group' });
      } else {
        store.merge('ui', { manageSeg: 'worker' });
      }
      switchPage('workers');
    });
  }

  // ==================== 未实现入口的统一提示 ====================

  function bindPlaceholders() {
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-soon]');
      if (target) VW.toast.show(`${target.dataset.soon} 即将上线`);
    });
  }

  // ==================== 主进程事件 ====================

  function subscribeEvents() {
    VW.api.onEvent(({ type, payload }) => {
      if (!type) return;

      if (type === 'task:created' || type === 'task:updated' || type === 'task:removed') {
        VW.views.dashboard.refreshSoon();
        if (payload?.id) VW.views.dashboard.syncDetail(payload.id);
        return;
      }

      if (type === 'app:notice') {
        VW.toast.show(`${payload.title}${payload.body ? `：${payload.body}` : ''}`);
        VW.views.shell.notify(payload.title, payload.body || '');
        return;
      }

      if (type.startsWith('share:')) {
        VW.views.capabilities.refreshShares();
        return;
      }

      if (type.startsWith('automation:')) {
        VW.views.automations.refresh();
        return;
      }

      if (type.startsWith('capability:') || type.startsWith('flow:')) {
        VW.views.capabilities.refresh();
        return;
      }

      if (type.startsWith('worker:') || type.startsWith('group:')) {
        VW.views.workers.refreshAll();
      }
    });
  }

  // ==================== 角标 ====================

  function renderNavBadge() {
    const badge = document.getElementById('nav-action-badge');
    const count = store.state.stats.needAction;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', count === 0);
  }

  // ==================== 启动 ====================

  async function bootstrap() {
    try {
      const data = await VW.api.bootstrap();
      store.set({
        workers: data.workers,
        workerList: data.workers,
        groups: data.groups,
        tasks: data.tasks,
        stats: data.stats,
        automations: data.automations,
        automationStats: data.automationStats,
        apiServer: data.runtime.apiServer,
        capabilityStats: data.capabilityStats,
        flows: data.flows,
        shares: data.shares,
        shareStats: data.shareStats,
        settings: data.settings
      });
      store.state.filters.statsPeriod = data.settings.period || 'month';
      store.state.filters.task.period = data.settings.period || 'month';
      store.state.ready = true;
      document.getElementById('stats-period').value = store.state.filters.statsPeriod;
      document.getElementById('filter-period').value = store.state.filters.task.period;
      // 队列数据（需要操作 / 查收结果）启动时按周期拉取一次
      await VW.views.dashboard.refresh({ silent: true });
    } catch (error) {
      // 降级：主进程不可用时页面仍可打开，仅展示空态
      console.error('[app] 启动数据加载失败:', error);
      VW.toast.show('数据加载失败，请重启应用');
    }
  }

  function init() {
    VW.dropdown.enhanceAll();
    bindNavigation();
    bindSidebar();
    bindPlaceholders();

    VW.views.capabilities.init();
    VW.views.workers.init();
    VW.views.dashboard.init();
    VW.views.automations.init();
    VW.views.shell.init();

    store.on(['workers', 'groups', 'ui'], renderSidebar);
    store.on('stats', renderNavBadge);

    renderSidebar();
    renderNavBadge();
    switchPage('dashboard');
    subscribeEvents();
    bootstrap();
  }

  init();
})();