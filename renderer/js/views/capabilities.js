/**
 * 能力与资源页：Skills（技能市场 / 我的技能）、连接器授权、知识库导入与检索、WorkerFlow 编排，
 * 以及 Worker 能力挂载弹窗（Worker 管理页也复用）。
 * 能力数据由主进程维护，本视图只负责渲染与提交。
 */
window.VW = window.VW || {};

VW.views = VW.views || {};

VW.views.capabilities = (() => {
  const { escapeHtml, debounce, formatTime } = VW.util;
  const store = VW.store;

  const state = {
    section: 'skill',
    tab: 'market',
    category: 'all',
    keyword: '',
    market: [],
    installed: [],
    connectors: [],
    knowledge: [],
    /** 知识库检索预览的展开状态、关键词与结果 */
    searchOpen: {},
    searchQueries: {},
    searchResults: {},
    loaded: false
  };

  let editingFlowId = null;
  let flowNodes = [];
  let authorizingConnectorKey = null;

  // ==================== 数据 ====================

  async function refresh() {
    try {
      const [market, stats, connectors, capabilities, flows] = await Promise.all([
        VW.api.capability.skillMarket(),
        VW.api.capability.stats(),
        VW.api.capability.connectorCatalog(),
        VW.api.capability.list(),
        VW.api.flow.list()
      ]);
      state.market = market.items;
      state.installed = capabilities.filter((item) => item.type === 'skill');
      state.knowledge = capabilities.filter((item) => item.type === 'knowledge');
      state.connectors = connectors;
      state.loaded = true;
      // flows 放入全局 store：任务与自动任务的「执行者」下拉需要列出 WorkerFlow
      store.set({ capabilityStats: stats, flows: flows.items });
      render();
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  async function ensureLoaded() {
    if (!state.loaded) await refresh();
  }

  function mountedCount(capabilityId) {
    return store.state.workers.filter((worker) => (worker.capabilityIds || []).includes(capabilityId)).length;
  }

  // ==================== 渲染：入口与小节 ====================

  function renderCounts() {
    const stats = store.state.capabilityStats || {};
    document.getElementById('cap-count-skill').textContent = String(state.installed.length);
    document.getElementById('cap-count-connector').textContent = String(stats.authorizedConnector || 0);
    document.getElementById('cap-count-knowledge').textContent = String(state.knowledge.length);
    document.getElementById('cap-count-flow').textContent = String((store.state.flows || []).length);
  }

  function renderSections() {
    document.querySelectorAll('.cap-card[data-section]').forEach((card) => {
      card.classList.toggle('active', card.dataset.section === state.section);
    });
    document.querySelectorAll('.cap-section').forEach((section) => {
      section.classList.toggle('hidden', section.dataset.section !== state.section);
    });
  }

  function render() {
    renderCounts();
    renderSections();
    renderSkills();
    renderConnectors();
    renderKnowledge();
    renderFlows();
  }

  // ==================== Skills ====================

  function categoryCounts() {
    const counts = new Map();
    state.market.forEach((skill) => counts.set(skill.category, (counts.get(skill.category) || 0) + 1));
    return counts;
  }

  function renderCategories() {
    const counts = categoryCounts();
    const categories = [
      { key: 'all', name: '全部分类' },
      { key: 'devops', name: 'DevOps 与部署' },
      { key: 'tool', name: '效率工具' },
      { key: 'research', name: '研究与分析' },
      { key: 'writing', name: '内容创作' },
      { key: 'design', name: '设计与 UI' },
      { key: 'data', name: '数据与 AI' },
      { key: 'docs', name: '文档与写作' }
    ];
    const wrap = document.getElementById('cap-cats');
    wrap.innerHTML = categories
      .map(
        (category) => `
      <button class="cap-cat${category.key === state.category ? ' active' : ''}" data-cat="${category.key}">
        <span>${category.name}</span>
        <span class="cat-count">${category.key === 'all' ? state.market.length : counts.get(category.key) || 0}</span>
      </button>`
      )
      .join('');
  }

  function skillCardHtml(skill, mode) {
    const capabilityId = mode === 'mine' ? skill.id : '';
    const mounted = capabilityId ? mountedCount(capabilityId) : 0;
    return `
      <div class="skill-card" data-skill="${skill.skillId || skill.id || ''}" data-capability="${capabilityId}">
        <div class="skill-head">
          <span class="skill-icon" style="background:${skill.color || '#eef0f2'};color:${skill.fg || '#5c6066'}">
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
          ${mode === 'market' ? `<span class="skill-down">${skill.downloads.toLocaleString()}</span>` : ''}
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
        <div class="connector-card" data-key="${connector.key}">
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

  // ==================== 知识库 ====================

  function knowledgeCardHtml(library) {
    const mounted = mountedCount(library.id);
    const source = library.source || {};
    const hits = state.searchResults[library.id] || [];
    const open = Boolean(state.searchOpen[library.id]);
    return `
      <div class="knowledge-card" data-id="${library.id}">
        <div class="knowledge-head">
          <span class="knowledge-name">${escapeHtml(library.title)}</span>
          <span class="status-badge status-done">已索引</span>
        </div>
        ${library.desc ? `<div class="automation-line">${escapeHtml(library.desc)}</div>` : ''}
        <div class="knowledge-meta">
          <span>${source.fileCount || 0} 个文件</span>
          <span>${source.chunkCount || 0} 条片段</span>
          <span>索引于 ${formatTime(source.at || library.updatedAt)}</span>
          ${mounted ? `<span>已挂载 ${mounted} 个 Worker</span>` : ''}
        </div>
        <div class="knowledge-dir" title="${escapeHtml(library.dir)}">${escapeHtml(library.dir)}</div>
        ${
          open
            ? `<div class="knowledge-search">
                 <div class="input-with-action">
                   <input type="text" data-field="search" placeholder="输入关键词预览检索命中" value="${escapeHtml(
                     state.searchQueries?.[library.id] || ''
                   )}" />
                   <button class="btn btn-outline" data-act="search">检索</button>
                 </div>
                 ${
                   hits.length
                     ? `<div class="knowledge-hits">${hits
                         .map(
                           (hit) => `<div class="knowledge-hit">
                             <div class="hit-file">${escapeHtml(hit.file)} · 命中分 ${hit.score}</div>
                             <div class="hit-snippet">${escapeHtml(hit.snippet)}</div>
                           </div>`
                         )
                         .join('')}</div>`
                     : state.searchQueries?.[library.id]
                       ? '<p class="form-hint">没有命中内容，换个关键词试试。</p>'
                       : ''
                 }
               </div>`
            : ''
        }
        <div class="knowledge-foot">
          <div class="worker-card-actions">
            <button class="mini-btn" data-act="toggle-search">${open ? '收起检索' : '检索预览'}</button>
            <button class="mini-btn" data-act="mount">挂载到 Worker</button>
            <button class="mini-btn" data-act="reindex">重建索引</button>
            <button class="mini-btn" data-act="remove">删除</button>
          </div>
        </div>
      </div>`;
  }

  function renderKnowledge() {
    const list = document.getElementById('knowledge-list');
    const empty = document.getElementById('knowledge-empty');
    list.innerHTML = state.knowledge.map(knowledgeCardHtml).join('');
    empty.classList.toggle('hidden', state.knowledge.length > 0);
  }

  // ==================== WorkerFlow ====================

  function renderFlows() {
    const list = document.getElementById('flow-list');
    const empty = document.getElementById('flow-empty');
    const flows = store.state.flows || [];
    list.innerHTML = flows
      .map(
        (flow) => `
      <div class="flow-card" data-id="${flow.id}">
        <div class="flow-head">
          <span class="flow-name">${escapeHtml(flow.name)}</span>
          <span class="status-badge status-done">${flow.nodeCount} 个节点</span>
        </div>
        ${flow.desc ? `<div class="automation-line">${escapeHtml(flow.desc)}</div>` : ''}
        <div class="flow-steps">
          ${flow.nodes
            .map(
              (node, index) => `
            <div class="flow-step">
              <span class="flow-step-index">${index + 1}</span>
              <span class="flow-step-title">${escapeHtml(node.title)}</span>
              <span class="flow-step-worker${node.workerMissing ? ' missing' : ''}">${escapeHtml(node.workerName)}</span>
              <span class="flow-step-instruction">${escapeHtml(node.instruction)}</span>
            </div>`
            )
            .join('')}
        </div>
        <div class="flow-foot">
          <span class="automation-stats">创建于 ${formatTime(flow.createdAt)}</span>
          <div class="worker-card-actions">
            <button class="mini-btn" data-act="run">用它创建任务</button>
            <button class="mini-btn" data-act="edit">编辑</button>
            <button class="mini-btn" data-act="remove">删除</button>
          </div>
        </div>
      </div>`
      )
      .join('');
    empty.classList.toggle('hidden', flows.length > 0);
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
            <input type="checkbox" value="${item.id}" ${current.includes(item.id) ? 'checked' : ''} />
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
      VW.toast.show('请先创建 Worker');
      return;
    }
    const select = document.getElementById('mount-worker');
    select.innerHTML = store.state.workers
      .map((worker) => `<option value="${worker.id}">${escapeHtml(worker.name)}（${escapeHtml(worker.role)}）</option>`)
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
      VW.toast.show(error.message);
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
    const secret = document.getElementById('connector-secret').value;
    try {
      await VW.api.capability.authorize(authorizingConnectorKey, secret);
      VW.modal.close('connector-modal');
      await refresh();
      VW.toast.show('授权已保存');
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  // ==================== 知识库弹窗 ====================

  function openKnowledgeModal() {
    document.getElementById('knowledge-form').reset();
    document.getElementById('knowledge-dir').value = '';
    VW.modal.open('knowledge-modal');
  }

  async function pickDirectory() {
    try {
      const { dir } = await VW.api.capability.pickDirectory();
      if (dir) document.getElementById('knowledge-dir').value = dir;
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  async function submitKnowledge(event) {
    event.preventDefault();
    const form = document.getElementById('knowledge-form');
    try {
      const created = await VW.api.capability.createKnowledge({
        name: form.name.value,
        desc: form.desc.value,
        dir: form.dir.value
      });
      VW.modal.close('knowledge-modal');
      await refresh();
      VW.toast.show(`知识库已索引：${created.source.chunkCount} 条片段`);
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  // ==================== 流程弹窗 ====================

  function nodeRowHtml(node, index) {
    const workers = store.state.workers;
    return `
      <div class="flow-node" data-index="${index}">
        <div class="flow-node-head">
          <span class="flow-node-index">${index + 1}</span>
          <input type="text" data-field="title" placeholder="步骤名称（如：收集资料）" value="${escapeHtml(node.title || '')}" maxlength="30" />
          <button type="button" class="icon-btn" data-act="up" title="上移">↑</button>
          <button type="button" class="icon-btn" data-act="down" title="下移">↓</button>
          <button type="button" class="icon-btn" data-act="remove-node" title="删除该步">✕</button>
        </div>
        <div class="flow-node-body">
          <select data-field="workerId" class="modal-select">
            ${workers
              .map(
                (worker) =>
                  `<option value="${worker.id}" ${node.workerId === worker.id ? 'selected' : ''}>${escapeHtml(
                    worker.name
                  )}（${escapeHtml(worker.role)}）</option>`
              )
              .join('')}
          </select>
          <input type="text" data-field="instruction" placeholder="指令模板，可用 {goal} 引用任务目标" value="${escapeHtml(
            node.instruction || ''
          )}" maxlength="300" />
        </div>
      </div>`;
  }

  function renderFlowNodes() {
    const container = document.getElementById('flow-nodes');
    container.innerHTML = flowNodes.map(nodeRowHtml).join('');
    VW.dropdown.enhanceAll(container); // 动态创建的 select 需要即时增强为统一下拉
    const submitBtn = document.getElementById('add-flow-node');
    submitBtn.classList.toggle('hidden', flowNodes.length >= 8);
  }

  /** 从表单读回节点内容，保证增删排序后不丢用户已填内容 */
  function syncNodesFromForm() {
    document.querySelectorAll('#flow-nodes .flow-node').forEach((row) => {
      const index = Number(row.dataset.index);
      if (!flowNodes[index]) return;
      flowNodes[index].title = row.querySelector('[data-field="title"]').value;
      flowNodes[index].workerId = row.querySelector('[data-field="workerId"]').value;
      flowNodes[index].instruction = row.querySelector('[data-field="instruction"]').value;
    });
  }

  function openFlowModal(flow) {
    if (!store.state.workers.length) {
      VW.toast.show('请先创建 Worker');
      return;
    }
    editingFlowId = flow ? flow.id : null;
    document.getElementById('flow-modal-title').textContent = flow ? '编辑流程' : '新建流程';
    const form = document.getElementById('flow-form');
    form.reset();

    flowNodes = flow
      ? flow.nodes.map((node) => ({
          id: node.id,
          title: node.title,
          workerId: node.workerId,
          instruction: node.instruction
        }))
      : [{ title: '步骤 1', workerId: store.state.workers[0].id, instruction: '围绕「{goal}」完成该步骤的准备工作' }];

    if (flow) {
      form.name.value = flow.name;
      form.desc.value = flow.desc || '';
    }
    renderFlowNodes();
    VW.modal.open('flow-modal');
  }

  async function submitFlow(event) {
    event.preventDefault();
    syncNodesFromForm();
    const form = document.getElementById('flow-form');
    if (!flowNodes.length) {
      VW.toast.show('请至少添加一个步骤');
      return;
    }
    const payload = { name: form.name.value, desc: form.desc.value, nodes: flowNodes };
    try {
      if (editingFlowId) {
        await VW.api.flow.update(editingFlowId, payload);
        VW.toast.show('流程已更新');
      } else {
        const created = await VW.api.flow.create(payload);
        VW.toast.show(`流程「${created.name}」已创建`);
      }
      VW.modal.close('flow-modal');
      await refresh();
    } catch (error) {
      VW.toast.show(error.message);
    }
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
          if (!window.confirm('卸载后将从所有 Worker 上摘除，确认卸载？')) return;
          await VW.api.capability.remove(card.dataset.capability);
          await refresh();
          VW.toast.show('已卸载');
        } else if (action === 'mount') {
          openMount();
        }
      } catch (error) {
        VW.toast.show(error.message);
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
          if (!window.confirm('撤销后该连接器将不可用，确认撤销？')) return undefined;
          await VW.api.capability.revoke(connector.capabilityId);
          await refresh();
          VW.toast.show('已撤销授权');
        }
      } catch (error) {
        VW.toast.show(error.message);
      }
      return undefined;
    });

    document.getElementById('connector-form').addEventListener('submit', submitConnector);
    document.getElementById('connector-modal-close').addEventListener('click', () => VW.modal.close('connector-modal'));
    document.getElementById('connector-modal-cancel').addEventListener('click', () => VW.modal.close('connector-modal'));
  }

  function bindKnowledgeEvents() {
    document.getElementById('new-knowledge-btn').addEventListener('click', openKnowledgeModal);
    document.getElementById('pick-directory-btn').addEventListener('click', pickDirectory);
    document.getElementById('knowledge-form').addEventListener('submit', submitKnowledge);
    document.getElementById('knowledge-modal-close').addEventListener('click', () => VW.modal.close('knowledge-modal'));
    document.getElementById('knowledge-modal-cancel').addEventListener('click', () => VW.modal.close('knowledge-modal'));

    const list = document.getElementById('knowledge-list');
    list.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const id = button.closest('.knowledge-card').dataset.id;
      const action = button.dataset.act;

      try {
        if (action === 'toggle-search') {
          state.searchOpen[id] = !state.searchOpen[id];
          renderKnowledge();
          return;
        }
        if (action === 'search') {
          const input = button.closest('.knowledge-search').querySelector('[data-field="search"]');
          state.searchQueries = state.searchQueries || {};
          state.searchQueries[id] = input.value;
          state.searchResults[id] = input.value.trim() ? await VW.api.capability.search(id, input.value) : [];
          renderKnowledge();
          return;
        }
        if (action === 'mount') {
          await openMount();
          return;
        }
        if (action === 'reindex') {
          const updated = await VW.api.capability.reindex(id);
          await refresh();
          VW.toast.show(`索引已重建：${updated.source.chunkCount} 条片段`);
          return;
        }
        if (action === 'remove') {
          if (!window.confirm('删除知识库会同时清除其索引，确认删除？')) return;
          await VW.api.capability.remove(id);
          await refresh();
          VW.toast.show('知识库已删除');
        }
      } catch (error) {
        VW.toast.show(error.message);
      }
    });
  }

  function bindFlowEvents() {
    document.getElementById('new-flow-btn').addEventListener('click', () => openFlowModal(null));
    document.getElementById('flow-form').addEventListener('submit', submitFlow);
    document.getElementById('flow-modal-close').addEventListener('click', () => VW.modal.close('flow-modal'));
    document.getElementById('flow-modal-cancel').addEventListener('click', () => VW.modal.close('flow-modal'));

    document.getElementById('add-flow-node').addEventListener('click', () => {
      syncNodesFromForm();
      const worker = store.state.workers[flowNodes.length % store.state.workers.length];
      flowNodes.push({
        title: `步骤 ${flowNodes.length + 1}`,
        workerId: worker.id,
        instruction: '围绕「{goal}」完成该步骤的准备工作'
      });
      renderFlowNodes();
    });

    document.getElementById('flow-nodes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const index = Number(button.closest('.flow-node').dataset.index);
      syncNodesFromForm();

      if (button.dataset.act === 'remove-node') flowNodes.splice(index, 1);
      if (button.dataset.act === 'up' && index > 0) {
        [flowNodes[index - 1], flowNodes[index]] = [flowNodes[index], flowNodes[index - 1]];
      }
      if (button.dataset.act === 'down' && index < flowNodes.length - 1) {
        [flowNodes[index + 1], flowNodes[index]] = [flowNodes[index], flowNodes[index + 1]];
      }
      renderFlowNodes();
    });

    document.getElementById('flow-list').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const id = button.closest('.flow-card').dataset.id;
      const flow = (store.state.flows || []).find((item) => item.id === id);
      const action = button.dataset.act;

      if (action === 'edit' && flow) return openFlowModal(flow);
      if (action === 'run' && flow) {
        document.querySelector('.nav-item[data-page="dashboard"]').click();
        return VW.views.dashboard.openCreateTask(flow.id);
      }
      if (action === 'remove') {
        if (!window.confirm('删除流程不会影响已产生的任务，确认删除？')) return undefined;
        try {
          await VW.api.flow.remove(id);
          await refresh();
          VW.toast.show('流程已删除');
        } catch (error) {
          VW.toast.show(error.message);
        }
      }
      return undefined;
    });
  }

  function bindMountEvents() {
    document.getElementById('mount-modal-save').addEventListener('click', saveMount);
    document.getElementById('mount-modal-close').addEventListener('click', () => VW.modal.close('mount-modal'));
    document.getElementById('mount-modal-cancel').addEventListener('click', () => VW.modal.close('mount-modal'));
    // 切换 Worker 时重新勾选其已挂载的能力
    document.getElementById('mount-worker').addEventListener('change', (event) => renderMountGroups(event.target.value));
  }

  function bindSectionSwitch() {
    document.querySelectorAll('.cap-card[data-section]').forEach((card) => {
      card.addEventListener('click', () => {
        state.section = card.dataset.section;
        renderSections();
      });
    });
  }

  function init() {
    bindSectionSwitch();
    bindSkillEvents();
    bindConnectorEvents();
    bindKnowledgeEvents();
    bindFlowEvents();
    bindMountEvents();

    store.on(['workers', 'groups'], () => {
      renderCounts();
      renderConnectors();
      renderKnowledge();
      renderFlows();
    });

    render();
    refresh();
  }

  return { init, refresh, openMount };
})();