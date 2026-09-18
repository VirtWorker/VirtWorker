/**
 * 能力与资源页 · WorkerFlow 小节（从 capabilities.js 拆出）
 * 职责：流程卡片渲染、流程编辑弹窗（节点增删排序）、创建/更新/删除、用它建任务、分享入口。
 * 依赖上下文 VW.capCtx：{ state, refresh, openShare }
 */
window.VW = window.VW || {};

VW.views = VW.views || {};

VW.views.capabilitiesFlows = (() => {
  const { escapeHtml, formatTime } = VW.util;
  const store = VW.store;

  /** 当前编辑中的流程 id；为空表示新建 */
  let editingFlowId = null;
  /** 编辑弹窗中的节点草稿 */
  let flowNodes = [];

  function render() {
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
            <button class="mini-btn" data-act="share">分享</button>
            <button class="mini-btn" data-act="edit">编辑</button>
            <button class="mini-btn" data-act="remove">删除</button>
          </div>
        </div>
      </div>`
      )
      .join('');
    empty.classList.toggle('hidden', flows.length > 0);
  }

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
      await VW.capCtx.refresh();
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  function bind() {
    document.getElementById('new-flow-btn').addEventListener('click', () => openFlowModal(null));
    document.getElementById('flow-form').addEventListener('submit', submitFlow);
    document.getElementById('flow-modal-close').addEventListener('click', () => VW.modal.close('flow-modal'));
    document.getElementById('flow-modal-cancel').addEventListener('click', () => VW.modal.close('flow-modal'));

    document.getElementById('add-flow-node').addEventListener('click', () => {
      syncNodesFromForm();
      const workers = store.state.workers;
      if (!workers.length) {
        VW.toast.show('请先创建 Worker 再编排流程');
        return;
      }
      const worker = workers[flowNodes.length % workers.length];
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
      if (action === 'share' && flow) return VW.capCtx.openShare('flow', flow.id);
      if (action === 'run' && flow) {
        document.querySelector('.nav-item[data-page="dashboard"]').click();
        return VW.views.dashboard.openCreateTask(flow.id);
      }
      if (action === 'remove') {
        if (!window.confirm('删除流程不会影响已产生的任务，确认删除？')) return undefined;
        try {
          await VW.api.flow.remove(id);
          await VW.capCtx.refresh();
          VW.toast.show('流程已删除');
        } catch (error) {
          VW.toast.show(error.message);
        }
      }
      return undefined;
    });
  }

  return { render, bind };
})();
