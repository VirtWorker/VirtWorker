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
    // 事件路由配套（O9）：进入页面时拉取最新数据，离开期间错过的事件无需补发。
    // capabilities 自带 ui 订阅懒加载；workers 数据由全局 worker:/group: 事件刷新兜底，
    // 进入该页时仍主动拉一次（修复此前「切入 workers 页不刷新」的缺口）
    const viewKey = name === 'autonomous' ? 'automations' : name;
    if (viewKey === 'workers') {
      VW.views.workers.refreshAll();
    } else if (viewKey !== 'capabilities' && typeof VW.views[viewKey]?.refresh === 'function') {
      VW.views[viewKey].refresh();
    }
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
          <div class="sidebar-worker-item" role="button" tabindex="0" data-group="${group.id}">
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
        <div class="sidebar-worker-item" role="button" tabindex="0" data-worker="${worker.id}">
          <span class="avatar avatar-sm" style="background:${VW.util.safeStyle(worker.avatarColor, '#eef0f2')}">${escapeHtml(worker.name.slice(0, 1))}</span>
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
    // 防抖：每次击键只更新一次状态（ui 切片订阅者含多个视图的全量重渲染，逐键触发代价高）
    searchInput.addEventListener(
      'input',
      VW.util.debounce((event) => {
        store.merge('ui', { sidebarSearch: event.target.value });
      }, 200)
    );

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

  /** 同前缀事件的合并刷新（22）：事件风暴（如任务每步更新、IM 消息连发）只触发一次拉取 */
  const routeTimers = new Map();
  function routeSoon(key, fn, wait = 150) {
    if (routeTimers.has(key)) return;
    routeTimers.set(
      key,
      setTimeout(() => {
        routeTimers.delete(key);
        fn();
      }, wait)
    );
  }

  function subscribeEvents() {
    VW.api.onEvent(({ type, payload }) => {
      if (!type) return;
      const page = store.state.ui.page;
      const onDashboard = page === 'dashboard';

      // 任务事件（O9 门控）：看板页完整刷新；其他页只做轻量统计刷新（导航角标与统计卡片
      // 全局可见），列表/队列数据由切回看板时 switchPage 的 refresh 补拉——
      // 此前任务事件不分页面全量拉取（每 120ms 一轮 3×IPC + 全量重渲染）是最大稳态浪费
      if (type === 'task:created' || type === 'task:updated') {
        if (onDashboard) {
          VW.views.dashboard.refreshSoon();
          if (payload?.id) VW.views.dashboard.syncDetail(payload.id);
        } else {
          routeSoon('task-stats', () => VW.views.dashboard.refreshStats());
        }
        return;
      }

      if (type === 'task:removed') {
        if (onDashboard) VW.views.dashboard.refreshSoon();
        else routeSoon('task-stats', () => VW.views.dashboard.refreshStats());
        // 被删任务正是当前打开的详情时直接关弹窗，而不是让它弹出「任务不存在」错误
        if (payload?.id) VW.views.dashboard.closeDetail(payload.id);
        return;
      }

      if (type === 'app:notice') {
        VW.toast.show(`${payload.title}${payload.body ? `：${payload.body}` : ''}`);
        return;
      }

      if (type === 'app:runtime') {
        // 本地触发端点状态变化（如端口重启），同步到 store 供设置页展示
        if (payload?.apiServer) store.set({ apiServer: payload.apiServer });
        return;
      }

      // Worker/Group 数据侧边栏（所有页面可见）与派发下拉共用：全局刷新，不按页门控。
      // 配合 store 的相等性跳过，数据未变时不会产生任何渲染（修复侧边栏只在工作页刷新的缺口）
      if (type.startsWith('worker:') || type.startsWith('group:')) {
        routeSoon('worker', () => VW.views.workers.refreshAll());
        return;
      }

      // 以下前缀按当前页面门控：隐藏页面的全量刷新（能力页一次 7 个 IPC）是最大浪费源；
      // 切回页面时 switchPage 会重新拉取，离开期间错过的事件无需补发
      if (type.startsWith('share:')) {
        if (page === 'capabilities') routeSoon('share', () => VW.views.capabilities.refreshShares());
        return;
      }

      if (type.startsWith('automation:')) {
        if (page === 'autonomous') routeSoon('automation', () => VW.views.automations.refresh());
        return;
      }

      if (type.startsWith('chat:')) {
        if (page === 'atworker') routeSoon('chat', () => VW.views.atworker.refresh());
        return;
      }

      if (type.startsWith('capability:') || type.startsWith('flow:')) {
        if (page === 'capabilities') routeSoon('capability', () => VW.views.capabilities.refresh());
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

  // ==================== 主题 ====================

  /** 应用主题：light/dark 直接生效，system 跟随操作系统偏好（暴露给设置弹窗调用） */
  function applyTheme(theme) {
    const resolved =
      theme === 'system' || !theme
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
    document.documentElement.dataset.theme = resolved;
  }
  VW.applyTheme = applyTheme;

  // 跟随系统时，系统偏好切换实时生效
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((store.state.settings.theme || 'system') === 'system') applyTheme('system');
  });

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
        chatConnections: data.chatConnections,
        chatBindings: data.chatBindings,
        chatBindingList: data.chatBindings,
        chatStats: data.chatStats,
        settings: data.settings
      });
      store.setFilters({ statsPeriod: data.settings.period || 'month' });
      store.setFilters('task', { period: data.settings.period || 'month' });
      applyTheme(data.settings.theme);
      store.state.ready = true;
      document.getElementById('stats-period').value = store.state.filters.statsPeriod;
      document.getElementById('filter-period').value = store.state.filters.task.period;
      // 队列数据（需要操作 / 查收结果）启动时按周期拉取一次
      await VW.views.dashboard.refresh({ silent: true });
    } catch (error) {
      // 降级：主进程不可用时页面仍可打开，展示可重试的错误横幅而非静默空态
      console.error('[app] 启动数据加载失败:', error);
      showBootstrapError();
    }
  }

  /** 启动数据加载失败横幅：提供「重试」入口，成功后自动移除 */
  function showBootstrapError() {
    if (document.getElementById('bootstrap-error')) return;
    const banner = document.createElement('div');
    banner.id = 'bootstrap-error';
    banner.className = 'bootstrap-error';
    banner.setAttribute('role', 'alert');
    banner.innerHTML = `
      <span>数据加载失败，界面暂不可用。</span>
      <button type="button" class="btn btn-primary" id="bootstrap-retry">重试</button>`;
    document.querySelector('.app').prepend(banner);
    document.getElementById('bootstrap-retry').addEventListener('click', async () => {
      const button = document.getElementById('bootstrap-retry');
      button.disabled = true;
      button.textContent = '加载中…';
      await bootstrap();
      if (store.state.ready) banner.remove();
      else {
        button.disabled = false;
        button.textContent = '重试';
      }
    });
  }

  /**
   * 键盘激活：让自定义可点元素（role="button" / tabindex="0" 的 div）支持键盘操作。
   * 原生控件（button/input/a 等）由浏览器处理，这里跳过避免重复触发。
   */
  function bindKeyboardActivation() {
    const NATIVE = 'button, a[href], input, select, textarea, label';
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest(NATIVE)) return;
      if (target.getAttribute('role') !== 'button' && target.tabIndex !== 0) return;
      event.preventDefault(); // Space 默认滚动页面
      target.click();
    });
  }

  function init() {
    VW.dropdown.enhanceAll();
    bindNavigation();
    bindSidebar();
    bindPlaceholders();
    bindKeyboardActivation();

    VW.views.capabilities.init();
    VW.views.workers.init();
    VW.views.dashboard.init();
    VW.views.automations.init();
    VW.views.atworker.init();
    VW.views.shell.init();

    // OPT-5：侧边栏只依赖这两个 ui 字段——dashboardTab/manageSeg/page 变化不再触发整块侧边栏重建
    store.on(['workers', 'groups', 'ui.sidebarSearch', 'ui.sidebarTab'], renderSidebar);
    store.on('stats', renderNavBadge);

    renderSidebar();
    renderNavBadge();
    switchPage('dashboard');
    subscribeEvents();
    bootstrap();
  }

  init();
})();