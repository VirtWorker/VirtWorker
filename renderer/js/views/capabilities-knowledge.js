/**
 * 能力与资源页 · 知识库小节（从 capabilities.js 拆出）
 * 职责：知识库卡片渲染、导入弹窗（目录授权 ticket）、检索预览、重建索引与删除。
 * 依赖上下文 VW.capCtx：{ state, refresh, openMount, mountedCount }
 */
window.VW = window.VW || {};

VW.views = VW.views || {};

VW.views.capabilitiesKnowledge = (() => {
  const { escapeHtml, formatTime } = VW.util;

  /** 知识库检索预览的展开状态、关键词与结果（模块私有） */
  const search = { open: {}, queries: {}, results: {} };
  /** 目录授权 ticket：仅由主进程对话框签发，创建知识库时原样回传校验 */
  let dirTicket = '';

  function knowledgeCardHtml(library) {
    const ctx = VW.capCtx;
    const mounted = ctx.mountedCount(library.id);
    const source = library.source || {};
    const hits = search.results[library.id] || [];
    const open = Boolean(search.open[library.id]);
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
                     search.queries[library.id] || ''
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
                     : search.queries[library.id]
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

  function render() {
    const list = document.getElementById('knowledge-list');
    const empty = document.getElementById('knowledge-empty');
    list.innerHTML = VW.capCtx.state.knowledge.map(knowledgeCardHtml).join('');
    empty.classList.toggle('hidden', VW.capCtx.state.knowledge.length > 0);
  }

  function openKnowledgeModal() {
    document.getElementById('knowledge-form').reset();
    document.getElementById('knowledge-dir').value = '';
    dirTicket = '';
    VW.modal.open('knowledge-modal');
  }

  async function pickDirectory() {
    try {
      const { dir, ticket } = await VW.api.capability.pickDirectory();
      if (dir) {
        document.getElementById('knowledge-dir').value = dir;
        dirTicket = ticket || '';
      }
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
        dir: form.dir.value,
        ticket: dirTicket
      });
      VW.modal.close('knowledge-modal');
      await VW.capCtx.refresh();
      VW.toast.show(`知识库已索引：${created.source.chunkCount} 条片段`);
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  function bind() {
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
          search.open[id] = !search.open[id];
          render();
          return;
        }
        if (action === 'search') {
          const input = button.closest('.knowledge-search').querySelector('[data-field="search"]');
          search.queries[id] = input.value;
          search.results[id] = input.value.trim() ? await VW.api.capability.search(id, input.value) : [];
          render();
          return;
        }
        if (action === 'mount') {
          await VW.capCtx.openMount();
          return;
        }
        if (action === 'reindex') {
          const updated = await VW.api.capability.reindex(id);
          await VW.capCtx.refresh();
          VW.toast.show(`索引已重建：${updated.source.chunkCount} 条片段`);
          return;
        }
        if (action === 'remove') {
          if (!window.confirm('删除知识库会同时清除其索引，确认删除？')) return;
          await VW.api.capability.remove(id);
          await VW.capCtx.refresh();
          VW.toast.show('知识库已删除');
        }
      } catch (error) {
        VW.toast.show(error.message);
      }
    });
  }

  return { render, bind };
})();
