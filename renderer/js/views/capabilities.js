/**
 * 能力与资源页（主模块）：Skills（技能市场 / 我的技能）、连接器授权、Worker 能力挂载。
 * 知识库 / WorkerFlow / 公开项目三个小节已拆分为独立模块：
 *   capabilities-knowledge.js、capabilities-flows.js、capabilities-shares.js
 * 四个模块通过 VW.capCtx 共享数据与刷新入口，能力数据由主进程维护，本层只做渲染与提交。
 */
window.VW = window.VW || {};

VW.views = VW.views || {};

VW.views.capabilities = (() => {
  const { escapeHtml, debounce } = VW.util;
  const store = VW.store;

  const state = {
    section: 'skill',
    tab: 'market',
    category: 'all',
    keyword: '',
    market: [],
    categories: [],
    installed: [],
    connectors: [],
    knowledge: [],
    loaded: false
  };

  let authorizingConnectorKey = null;

  // ==================== 数据 ====================

  /** 进行中的刷新（并发去重：多次触发只跑一次，后来者复用同一 Promise） */
  let inflight = null;

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const [market, stats, connectors, capabilities, flows, shares, shareStats] = await Promise.all([
          VW.api.capability.skillMarket(),
          VW.api.capability.stats(),
          VW.api.capability.connectorCatalog(),
          VW.api.capability.list(),
          VW.api.flow.list(),
          VW.api.share.list(),
          VW.api.share.stats()
        ]);
        state.market = market.items;
        // 分类与计数由主进程目录统一计算下发（含新增分类，渲染层不再硬编码）
        state.categories = market.categories || [];
        state.installed = capabilities.filter((item) => item.type === 'skill');
        state.knowledge = capabilities.filter((item) => item.type === 'knowledge');
        state.connectors = connectors;
        state.loaded = true;
        // flows 放入全局 store：任务与自动任务的「执行者」下拉需要列出 WorkerFlow
        store.set({ capabilityStats: stats, flows: flows.items, shares, shareStats });
        render();
      } catch (error) {
        VW.toast.fromError(error);
        // C2：加载失败与「暂无数据」可区分，网格内给出可重试错误块
        VW.util.renderListError(document.getElementById('skill-grid'), { retry: refresh });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** 仅刷新分享记录（可见性切换、导入计数等高频操作） */
  async function refreshShares() {
    try {
      const [shares, shareStats] = await Promise.all([VW.api.share.list(), VW.api.share.stats()]);
      store.set({ shares, shareStats });
    } catch (error) {
      VW.toast.fromError(error);
    }
  }

  async function ensureLoaded() {
    if (state.loaded) return;
    // C2：首次懒加载期间给出加载占位，不再是「上一次内容或空白」
    VW.util.renderListLoading(document.getElementById('skill-grid'), '技能与资源加载中…');
    await refresh();
  }

  function mountedCount(capabilityId) {
    return store.state.workers.filter((worker) => (worker.capabilityIds || []).includes(capabilityId)).length;
  }

  // ==================== 渲染 ====================

  function renderCounts() {
    const stats = store.state.capabilityStats || {};
    const shareStats = store.state.shareStats || {};
    document.getElementById('cap-count-skill').textContent = String(state.installed.length);
    document.getElementById('cap-count-connector').textContent = String(stats.authorizedConnector || 0);
    document.getElementById('cap-count-knowledge').textContent = String(state.knowledge.length);
    document.getElementById('cap-count-flow').textContent = String((store.state.flows || []).length);
    // 公开项目计数此前遗漏（卡片恒显 0），与分享列表刷新联动
    document.getElementById('cap-count-share').textContent = String(shareStats.total ?? (store.state.shares || []).length);
  }

  function renderSections() {
    document.querySelectorAll('.cap-card[data-section]').forEach((card) => {
      card.classList.toggle('active', card.dataset.section === state.section);
    });
    document.querySelectorAll('.cap-section').forEach((section) => {
      section.classList.toggle('hidden', section.dataset.section !== state.section);
    });
  }

  /** 按 section 门控渲染（C1）：只重建当前可见小节，隐藏小节在切换时再渲染——
   *  此前 refresh/worker 事件风暴下五块 DOM 全量重建（含隐藏小节） */
  function renderSection(name) {
    if (name === 'skill') renderSkills();
    else if (name === 'connector') renderConnectors();
    else if (name === 'knowledge') VW.views.capabilitiesKnowledge.render();
    else if (name === 'flow') VW.views.capabilitiesFlows.render();
    else if (name === 'share') VW.views.capabilitiesShares.render();
  }

  function render() {
    renderCounts();
    renderSections();
    renderSection(state.section);
  }

  // ==================== Skills ====================

  function categoryCounts() {
    const counts = new Map();
    state.market.forEach((skill) => counts.set(skill.category, (counts.get(skill.category) || 0) + 1));
    return counts;
  }

  function renderCategories() {
    // 刷新前（懒加载未完成）用兜底「全部分类」；刷新后消费主进程下发的分类与计数
    const categories = state.categories.length ? state.categories : [{ key: 'all', name: '全部分类', count: state.market.length }];
    const counts = categoryCounts();
    const wrap = document.getElementById('cap-cats');
    wrap.innerHTML = categories
      .map((category) => {
        const count = category.count ?? (category.key === 'all' ? state.market.length : counts.get(category.key) || 0);
        return `
      <button class="cap-cat${category.key === state.category ? ' active' : ''}" data-cat="${escapeHtml(category.key)}">
        <span>${escapeHtml(category.name)}</span>
        <span class="cat-count">${count}</span>
      </button>`;
      })
      .join('');
  }

  function skillCardHtml(skill, mode) {
    const capabilityId = mode === 'mine' ? skill.id : '';
    const mounted = capabilityId ? mountedCount(capabilityId) : 0;
    return `
      <div class="skill-card" data-skill="${escapeHtml(skill.skillId || skill.id || '')}" data-capability="${escapeHtml(capabilityId)}">
        <div class="skill-head">
          <span class="skill-icon" style="background:${VW.util.safeStyle(skill.color, '#eef0f2')};color:${VW.util.safeStyle(skill.fg, '#5c6066')}">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>
          </span>
          <span class="skill-title">${escapeHtml(skill.title)}</span>
          ${skill.reco ? '<span class="reco-badge">推荐</span>' : ''}
          ${mode === 'mine' ? '<span class="status-badge status-running">已安装</span>' : ''}
        </div>
        <div class="skill-desc">${escapeHtml(skill.desc)}</div>
        <div class="skill-foot">
          <span class="skill-author">作者 ${escapeHtml(skill.author)}</span>
          ${mounted ? `<span class="skill-down">已挂载 ${mounted} 个 Worker</span>` : ''}
          ${mode === 'market' ? `<span class="skill-down">${Number(skill.downloads || 0).toLocaleString()}</span>` : ''}
        </div>
        <div class="skill-actions">
          ${
            mode === 'market'
              ? `<button class="mini-btn" data-act="install">安装</button>`
              : `<button class="mini-btn" data-act="mount">挂载到 Worker</button>
                 <button class="mini-btn" data-act="uninstall">卸载</button>`
          }
        </div>
      </div>`;
  }

  function renderSkills() {
    renderCategories();
    const grid = document.getElementById('skill-grid');
    const empty = document.getElementById('skill-empty');
    const isMine = state.tab === 'mine';
    const keyword = state.keyword.trim().toLowerCase();

    const source = isMine
      ? state.installed.filter((skill) => !keyword || `${skill.title} ${skill.desc}`.toLowerCase().includes(keyword))
      : state.market.filter(
          (skill) =>
            (state.category === 'all' || skill.category === state.category) &&
            (!keyword || `${skill.title} ${skill.desc} ${skill.author}`.toLowerCase().includes(keyword))
        );

    document.getElementById('cap-current-cat').textContent = isMine ? '我的技能' : '技能市场';
    document.getElementById('cap-skill-count').textContent = `${source.length} 个 Skill`;

    grid.innerHTML = source.map((skill) => skillCardHtml(skill, isMine ? 'mine' : 'market')).join('');
    empty.classList.toggle('hidden', source.length > 0);
    empty.querySelector('.empty-title').textContent = isMine ? '暂无已安装的技能' : '没有匹配的技能';
    empty.querySelector('.empty-desc').textContent = isMine
      ? '前往技能市场安装后，可挂载到 Worker 上使用。'
      : '换个关键词或分类试试。';
  }

  // ==================== 连接器 ====================

  function renderConnectors() {
    const authorized = state.connectors.filter((item) => item.status === 'authorized');
    document.getElementById('connector-summary').textContent = `${authorized.length} / ${state.connectors.length} 个已授权`;
    document.getElementById('connector-grid').innerHTML = state.connectors
      .map((connector) => {
        const isAuthorized = connector.status === 'authorized';
        const mounted = connector.capabilityId ? mountedCount(connector.capabilityId) : 0;
        return `
        <div class="connector-card" data-key="${escapeHtml(connector.key)}">
          <div class="connector-head">
            <span class="connector-name">${escapeHtml(connector.name)}</span>
            <span class="status-badge ${isAuthorized ? 'status-running' : 'status-canceled'}">${isAuthorized ? '已授权' : '未授权'}</span>
          </div>
          <div class="connector-desc">${escapeHtml(connector.desc)}</div>
          ${isAuthorized ? `<div class="connector-mask">凭据：${escapeHtml(connector.credentialMask)}（主进程加密保存）</div>` : ''}
          <div class="connector-foot">
            <span class="automation-stats">${isAuthorized && mounted ? `已挂载 ${mounted} 个 Worker` : ''}</span>
            <div class="worker-card-actions">
              ${isAuthorized ? '<button class="mini-btn" data-act="mount">挂载到 Worker</button><button class="mini-btn" data-act="revoke">撤销</button>' : ''}
              <button class="mini-btn" data-act="authorize">${isAuthorized ? '更新凭据' : '授权'}</button>
            </div>
          </div>
        </div>`;
      })
      .join('');
  }

  // ==================== 挂载 ====================

  function renderMountGroups(workerId) {
    const worker = store.state.workers.find((item) => item.id === workerId);
    const current = worker ? worker.capabilityIds || [] : [];
    const groups = [
      { title: 'Skills', items: state.installed.map((item) => ({ id: item.id, label: item.title })) },
      {
        title: '连接器',
        items: state.connectors
          .filter((item) => item.capabilityId && item.status === 'authorized')
          .map((item) => ({ id: item.capabilityId, label: item.name }))
      },
      { title: '知识库', items: state.knowledge.map((item) => ({ id: item.id, label: item.title })) }
    ];

    document.getElementById('mount-groups').innerHTML = groups
      .map(
        (group) => `
      <div class="mount-group">
        <div class="detail-label">${group.title}</div>
        ${
          group.items.length
            ? group.items
                .map(
                  (item) => `
          <label class="member-option">
            <input type="checkbox" value="${escapeHtml(item.id)}" ${current.includes(item.id) ? 'checked' : ''} />
            <span class="member-name">${escapeHtml(item.label)}</span>
          </label>`
                )
                .join('')
            : '<p class="form-hint">暂无可挂载项（先在对应入口安装或授权）</p>'
        }
      </div>`
      )
      .join('');
  }

  /** 统一入口：任何「挂载到 Worker」都打开同一个弹窗，可切换 Worker */
  async function openMount(workerId) {
    await ensureLoaded();
    await VW.views.workers.refreshAll();
    if (!store.state.workers.length) {
      VW.toast.show(VW.util.LABELS.noWorker);
      return;
    }
    const select = document.getElementById('mount-worker');
    select.innerHTML = store.state.workers
      .map((worker) => `<option value="${escapeHtml(worker.id)}">${escapeHtml(worker.name)}（${escapeHtml(worker.role)}）</option>`)
      .join('');
    select.value = workerId && store.state.workers.some((item) => item.id === workerId)
      ? workerId
      : store.state.workers[0].id;
    VW.dropdown.refresh(select);
    renderMountGroups(select.value);
    VW.modal.open('mount-modal');
  }

  async function saveMount() {
    const workerId = document.getElementById('mount-worker').value;
    const ids = Array.from(document.querySelectorAll('#mount-groups input:checked')).map((input) => input.value);
    try {
      await VW.api.capability.mount(workerId, ids);
      VW.modal.close('mount-modal');
      await VW.views.workers.refreshAll();
      render();
      VW.toast.show('能力挂载已更新');
    } catch (error) {
      VW.toast.fromError(error);
    }
  }

  // ==================== 连接器授权弹窗 ====================

  function openConnectorModal(key) {
    const connector = state.connectors.find((item) => item.key === key);
    if (!connector) return;
    authorizingConnectorKey = key;
    document.getElementById('connector-modal-title').textContent = `授权 · ${connector.name}`;
    document.getElementById('connector-hint').textContent = `${connector.desc}。${connector.hint}`;
    document.getElementById('connector-form').reset();
    VW.modal.open('connector-modal');
  }

  async function submitConnector(event) {
    event.preventDefault();
    const form = event.target;
    const secret = document.getElementById('connector-secret').value;
    await VW.util.withSubmitting(form, async () => {
      await VW.api.capability.authorize(authorizingConnectorKey, secret);
      VW.modal.close('connector-modal');
      await refresh();
      VW.toast.show('授权已保存');
    });
  }

  // ==================== 事件绑定 ====================

  function bindSkillEvents() {
    document.querySelectorAll('#cap-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#cap-tabs .tab').forEach((item) => item.classList.toggle('active', item === tab));
        state.tab = tab.dataset.tab;
        renderSkills();
      });
    });

    document.getElementById('cap-skill-search').addEventListener(
      'input',
      debounce((event) => {
        state.keyword = event.target.value;
        renderSkills();
      }, 200)
    );

    document.getElementById('cap-cats').addEventListener('click', (event) => {
      const button = event.target.closest('[data-cat]');
      if (!button) return;
      state.category = button.dataset.cat;
      renderSkills();
    });

    document.getElementById('skill-grid').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const card = button.closest('[data-skill]');
      const action = button.dataset.act;
      try {
        if (action === 'install') {
          const skill = await VW.api.capability.installSkill(card.dataset.skill);
          await refresh();
          VW.toast.show(`已安装「${skill.title}」，可挂载到 Worker 使用`);
        } else if (action === 'uninstall') {
          // F3：破坏性确认统一走 submitAction（应用内约定），不再混用原生 window.confirm
          await VW.util.submitAction(
            async () => {
              await VW.api.capability.remove(card.dataset.capability);
              await refresh();
              VW.toast.show('已卸载');
            },
            { confirm: '卸载后将从所有 Worker 上摘除，确认卸载？' }
          );
        } else if (action === 'mount') {
          openMount();
        }
      } catch (error) {
        VW.toast.fromError(error);
      }
    });
  }

  function bindConnectorEvents() {
    document.getElementById('connector-grid').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const key = button.closest('[data-key]').dataset.key;
      const connector = state.connectors.find((item) => item.key === key);
      const action = button.dataset.act;

      try {
        if (action === 'authorize') return openConnectorModal(key);
        if (action === 'mount') return openMount();
        if (action === 'revoke') {
          await VW.util.submitAction(
            async () => {
              await VW.api.capability.revoke(connector.capabilityId);
              await refresh();
              VW.toast.show('已撤销授权');
            },
            { confirm: '撤销后该连接器将不可用，确认撤销？' }
          );
        }
      } catch (error) {
        VW.toast.fromError(error);
      }
      return undefined;
    });

    document.getElementById('connector-form').addEventListener('submit', submitConnector);
    VW.modal.bindClose('connector-modal', 'connector-modal-close', 'connector-modal-cancel');
  }

  function bindMountEvents() {
    document.getElementById('mount-modal-save').addEventListener('click', saveMount);
    VW.modal.bindClose('mount-modal', 'mount-modal-close', 'mount-modal-cancel');
    // 切换 Worker 时重新勾选其已挂载的能力
    document.getElementById('mount-worker').addEventListener('change', (event) => renderMountGroups(event.target.value));
  }

  function bindSectionSwitch() {
    document.querySelectorAll('.cap-card[data-section]').forEach((card) => {
      card.addEventListener('click', () => {
        state.section = card.dataset.section;
        renderSections();
        renderSection(state.section); // 门控渲染后，切入的小节必须在此刻刷新内容
      });
    });
  }

  /** 供外部跳转时指定小节（如 Worker 页的「分享记录」按钮） */
  function showSection(name) {
    state.section = name;
    ensureLoaded();
    renderSections();
  }

  function init() {
    // 共享上下文：子模块通过它访问数据与刷新入口，避免循环依赖
    VW.capCtx = { state, refresh, refreshShares, openMount, openShare, mountedCount };

    bindSectionSwitch();
    bindSkillEvents();
    bindConnectorEvents();
    bindMountEvents();
    VW.views.capabilitiesKnowledge.bind();
    VW.views.capabilitiesFlows.bind();
    VW.views.capabilitiesShares.bind();

    // 订阅门控（C1）：只有当前在能力页时才重渲染对应小节；
    // 不在页面时跳过（切回页面由 switchPage/refresh 重新拉取），worker 事件风暴不再触发隐藏小节重建
    store.on('shares', () => {
      if (store.state.ui.page !== 'capabilities') return;
      renderCounts();
      if (state.section === 'share') VW.views.capabilitiesShares.render();
    });
    store.on(['workers', 'groups'], () => {
      if (store.state.ui.page !== 'capabilities') return;
      renderCounts();
      renderSection(state.section);
    });
    // 懒加载：进入能力页才拉取视图数据（启动数据由 bootstrap 提供 flows/shares 等全局切片），
    // 避免与 bootstrap 并发重复请求、消除首屏 7 个 IPC 竞争。
    // OPT-5：只订阅 page 字段，页内 tab/搜索等 ui 变化不再触发本回调
    store.on('ui.page', (s) => {
      if (s.ui.page === 'capabilities') ensureLoaded();
    });

    render();
  }

  /** 分享入口：委托给 shares 子模块 */
  function openShare(resourceType, resourceId) {
    return VW.views.capabilitiesShares.openShare(resourceType, resourceId);
  }

  /** 资源包导入（Worker 管理页复用）：委托给 shares 子模块 */
  function importAndReport(payload) {
    return VW.views.capabilitiesShares.importAndReport(payload);
  }

  return { init, refresh, refreshShares, ensureLoaded, openMount, openShare, importAndReport, showSection };
})();
