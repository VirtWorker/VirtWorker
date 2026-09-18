/**
 * 能力与资源页 · 公开项目（分享记录）小节（从 capabilities.js 拆出）
 * 职责：分享卡片渲染、分享弹窗（复制/导出/可见性/删除）、按分享码导入、资源包导入结果反馈。
 * 依赖上下文 VW.capCtx：{ refresh, refreshShares }
 */
window.VW = window.VW || {};

VW.views = VW.views || {};

VW.views.capabilitiesShares = (() => {
  const { escapeHtml, formatTime } = VW.util;
  const store = VW.store;

  /** 分享弹窗当前展示的记录 */
  let currentShare = null;

  function shareCardHtml(share) {
    return `
      <div class="share-card" data-id="${share.id}">
        <div class="share-head">
          <span class="share-name">${escapeHtml(share.title)}</span>
          <span class="meta-chip">${escapeHtml(share.typeLabel)}</span>
          <span class="status-badge ${share.visibility === 'public' ? 'status-running' : 'status-canceled'}">
            ${share.visibility === 'public' ? '公开' : '仅自己'}
          </span>
        </div>
        <div class="automation-line">${escapeHtml(share.summary)}</div>
        <div class="share-code-row">
          <code class="share-code">${escapeHtml(share.code)}</code>
          <span class="form-hint">已被导入 ${share.importCount} 次 · 更新于 ${formatTime(share.updatedAt)}</span>
        </div>
        <div class="share-foot">
          <div class="worker-card-actions">
            <button class="mini-btn" data-act="copy">复制分享码</button>
            <button class="mini-btn" data-act="export">导出 JSON</button>
            <button class="mini-btn" data-act="import">导入到本机</button>
            <button class="mini-btn" data-act="visibility">${share.visibility === 'public' ? '设为仅自己' : '设为公开'}</button>
            <button class="mini-btn" data-act="remove">删除</button>
          </div>
        </div>
      </div>`;
  }

  function render() {
    const shares = store.state.shares || [];
    document.getElementById('cap-count-share').textContent = String(shares.length);
    document.getElementById('share-summary').textContent = `${shares.filter((share) => share.visibility === 'public').length} 个公开 · 共 ${shares.length} 个已分享资源`;
    document.getElementById('share-list').innerHTML = shares.map(shareCardHtml).join('');
    document.getElementById('share-empty').classList.toggle('hidden', shares.length > 0);
  }

  /** 导出资源包为 JSON 文件（由主进程弹出保存对话框） */
  async function exportShare(share) {
    try {
      const payload = await VW.api.share.exportPayload(share.resourceType, share.resourceId);
      const result = await VW.api.app.saveFile({
        suggestedName: `${share.title}.virtworker.json`,
        content: JSON.stringify(payload, null, 2)
      });
      if (result.canceled) return;
      VW.toast.show(`已导出到 ${result.filePath}`);
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  /** 导入资源包内容（分享码与文件两条路径共用） */
  async function importAndReport(payload) {
    const result = await VW.api.share.importPayload(payload);
    await Promise.all([VW.capCtx.refresh(), VW.views.workers.refreshAll()]);
    const warn = result.warnings && result.warnings.length ? `（${result.warnings.join('；')}）` : '';
    VW.toast.show(`已导入${result.type === 'flow' ? '流程' : 'Worker'}「${result.name}」${warn}`);
    return result;
  }

  async function openShare(resourceType, resourceId) {
    try {
      const share = await VW.api.share.create({ resourceType, resourceId });
      currentShare = share;
      document.getElementById('share-modal-title').textContent = `分享 · ${share.title}`;
      document.getElementById('share-code-value').value = share.code;
      document.getElementById('share-visibility-toggle').checked = share.visibility === 'public';
      document.getElementById('share-content-summary').textContent = `${share.typeLabel} · ${share.summary}`;
      VW.modal.open('share-modal');
      await VW.capCtx.refreshShares();
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  function bind() {
    document.getElementById('share-modal-close').addEventListener('click', () => VW.modal.close('share-modal'));
    document.getElementById('share-modal-ok').addEventListener('click', () => VW.modal.close('share-modal'));
    document.getElementById('copy-share-code-btn').addEventListener('click', async () => {
      if (!currentShare) return;
      try {
        await VW.api.copyText(currentShare.code);
        VW.toast.show('分享码已复制');
      } catch (error) {
        VW.toast.show(error.message);
      }
    });
    document.getElementById('share-visibility-toggle').addEventListener('change', async (event) => {
      if (!currentShare) return;
      try {
        currentShare = await VW.api.share.setVisibility(currentShare.id, event.target.checked ? 'public' : 'private');
        VW.toast.show(event.target.checked ? '已设为公开' : '已设为仅自己可见');
        await VW.capCtx.refreshShares();
      } catch (error) {
        VW.toast.show(error.message);
      }
    });
    document.getElementById('share-export-btn').addEventListener('click', () => {
      if (currentShare) exportShare(currentShare);
    });
    document.getElementById('share-delete-btn').addEventListener('click', async () => {
      if (!currentShare) return;
      if (!window.confirm('取消分享后分享码立即失效，确认删除该分享记录？')) return;
      try {
        await VW.api.share.remove(currentShare.id);
        VW.modal.close('share-modal');
        VW.toast.show('已取消分享');
        await VW.capCtx.refreshShares();
      } catch (error) {
        VW.toast.show(error.message);
      }
    });

    // 按分享码导入
    const codeInput = document.getElementById('share-code-input');
    const importBtn = document.getElementById('share-import-btn');
    const hint = document.getElementById('share-preview-hint');
    let previewPayload = null;

    document.getElementById('share-preview-btn').addEventListener('click', async () => {
      try {
        const { share, payload } = await VW.api.share.preview(codeInput.value);
        previewPayload = payload;
        hint.textContent = `找到「${share.title}」（${share.typeLabel} · ${share.summary}），点击「导入」即可复制一份到本机。`;
        importBtn.disabled = false;
      } catch (error) {
        previewPayload = null;
        importBtn.disabled = true;
        hint.textContent = error.message;
      }
    });

    importBtn.addEventListener('click', async () => {
      try {
        const { payload } = await VW.api.share.preview(codeInput.value);
        await importAndReport(previewPayload || payload);
        codeInput.value = '';
        previewPayload = null;
        importBtn.disabled = true;
        hint.textContent = '分享码为本机资源包引用；跨设备请使用「导出为 JSON」后传文件导入。';
      } catch (error) {
        VW.toast.show(error.message);
      }
    });

    document.getElementById('share-list').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const share = (store.state.shares || []).find((item) => item.id === button.closest('.share-card').dataset.id);
      if (!share) return;
      const action = button.dataset.act;

      try {
        if (action === 'copy') {
          await VW.api.copyText(share.code);
          VW.toast.show('分享码已复制');
          return;
        }
        if (action === 'export') return exportShare(share);
        if (action === 'import') {
          const result = await VW.api.share.importByCode(share.code);
          await Promise.all([VW.capCtx.refresh(), VW.views.workers.refreshAll()]);
          const warn = result.warnings && result.warnings.length ? `（${result.warnings.join('；')}）` : '';
          VW.toast.show(`已导入「${result.name}」${warn}`);
          return;
        }
        if (action === 'visibility') {
          await VW.api.share.setVisibility(share.id, share.visibility === 'public' ? 'private' : 'public');
          await VW.capCtx.refreshShares();
          return;
        }
        if (action === 'remove') {
          if (!window.confirm('取消分享后分享码立即失效，确认删除该分享记录？')) return;
          await VW.api.share.remove(share.id);
          await VW.capCtx.refreshShares();
          VW.toast.show('已取消分享');
        }
      } catch (error) {
        VW.toast.show(error.message);
      }
      return undefined;
    });
  }

  return { render, bind, openShare, importAndReport };
})();
