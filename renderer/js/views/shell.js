/**
 * 侧边栏全局入口：设置中心 与 历史记录（最近任务）
 * 两者都是壳层工具，数据仍来自主进程，本模块只做展示与提交。
 */
window.VW = window.VW || {};

VW.views = VW.views || {};

VW.views.shell = (() => {
  const { formatTime, assigneeLabel, historyListHtml } = VW.util;
  const store = VW.store;

  /** 系统通知：仅在设置开启时发送，失败静默降级为应用内提示 */
  function notify(title, body) {
    if (!store.state.settings.notify) return;
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then((permission) => {
          if (permission === 'granted') new Notification(title, { body });
        });
      }
    } catch (error) {
      console.warn('[shell] 系统通知发送失败:', error.message);
    }
  }

  // ==================== 设置中心 ====================

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function refreshDataStats() {
    try {
      const [stats, preview] = await Promise.all([VW.api.app.dataStats(), VW.api.app.purgePreview()]);
      document.getElementById('setting-data-dir').textContent = `数据目录：${stats.dir}`;
      document.getElementById('setting-data-size').textContent = `${stats.files.length} 个集合文件 · 共 ${formatSize(stats.totalSize)}`;
      document.getElementById('purge-preview').textContent = preview.removable
        ? `当前有 ${preview.removable} 条已查收的历史任务超出保留期`
        : `没有超出保留期（${preview.retention} 天）的任务`;
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  async function openSettings() {
    const settings = store.state.settings;
    document.getElementById('setting-notify').checked = Boolean(settings.notify);
    document.getElementById('setting-catchup').checked = Boolean(settings.catchUpMissed);
    document.getElementById('setting-random-action').checked = Boolean(settings.mockRandomAction);
    document.getElementById('setting-theme').value = settings.theme || 'system';
    document.getElementById('setting-api-port').value = settings.apiPort || store.state.apiServer.port || '';
    document.getElementById('setting-retention').value = settings.taskRetentionDays || 90;
    document.getElementById('setting-api-hint').textContent = store.state.apiServer.running
      ? `运行中：http://127.0.0.1:${store.state.apiServer.port}`
      : `未启动${store.state.apiServer.error ? `：${store.state.apiServer.error}` : ''}`;
    VW.modal.open('settings-modal');
    await refreshDataStats();
  }

  async function saveSettings() {
    const port = Number(document.getElementById('setting-api-port').value);
    const retention = Number(document.getElementById('setting-retention').value);
    const patch = {
      notify: document.getElementById('setting-notify').checked,
      catchUpMissed: document.getElementById('setting-catchup').checked,
      mockRandomAction: document.getElementById('setting-random-action').checked,
      theme: document.getElementById('setting-theme').value,
      apiPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : store.state.settings.apiPort,
      taskRetentionDays: Number.isInteger(retention) && retention >= 1 ? retention : store.state.settings.taskRetentionDays
    };

    try {
      const saved = await VW.api.settings.update(patch);
      store.set({ settings: saved });
      VW.applyTheme(saved.theme);
      VW.modal.close('settings-modal');
      VW.toast.show('设置已保存');

      // 端口改动后主进程会自动重启本地端点并广播 app:runtime；这里根据最新状态提示结果
      if (patch.apiPort !== store.state.apiServer.port) {
        await new Promise((r) => setTimeout(r, 1200)); // 等待端点重启完成
        const server = store.state.apiServer;
        if (server.running) VW.toast.show(`API 端点已在 ${server.port} 端口生效`);
        else VW.toast.show(`API 端点启动失败：${server.error || '端口不可用'}`);
      }
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  async function purgeTasks() {
    try {
      const result = await VW.api.app.purgeTasks();
      VW.toast.show(result.removed ? `已清理 ${result.removed} 条历史任务` : '没有需要清理的任务');
      await Promise.all([refreshDataStats(), VW.views.dashboard.refresh({ silent: true })]);
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  function bindSettings() {
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('settings-modal-close').addEventListener('click', () => VW.modal.close('settings-modal'));
    document.getElementById('settings-modal-cancel').addEventListener('click', () => VW.modal.close('settings-modal'));
    document.getElementById('settings-modal-save').addEventListener('click', saveSettings);
    document.getElementById('purge-tasks-btn').addEventListener('click', purgeTasks);
    document.getElementById('open-data-dir-btn').addEventListener('click', async () => {
      try {
        const result = await VW.api.app.openDataDir();
        if (!result.opened) VW.toast.show(result.error || '打开目录失败');
      } catch (error) {
        VW.toast.show(error.message);
      }
    });
  }

  // ==================== 历史记录 ====================

  async function openHistory() {
    try {
      const { items } = await VW.api.task.list({ period: '', limit: 20 });
      const body = document.getElementById('history-body');
      body.innerHTML = historyListHtml(items, {
        label: `最近 ${items.length} 条任务（不受看板筛选影响）`,
        metaOf: (task) => `${assigneeLabel(task.assignee)} · ${task.trigger.label} · ${formatTime(task.createdAt)}`,
        emptyText: '还没有任务记录，去任务看板创建第一个任务吧。'
      });
      VW.modal.open('history-modal');
    } catch (error) {
      VW.toast.show(error.message);
    }
  }

  function bindHistory() {
    document.getElementById('history-btn').addEventListener('click', openHistory);
    document.getElementById('history-modal-close').addEventListener('click', () => VW.modal.close('history-modal'));
    document.getElementById('history-modal-ok').addEventListener('click', () => VW.modal.close('history-modal'));
    document.getElementById('history-body').addEventListener('click', (event) => {
      const button = event.target.closest('[data-task]');
      if (!button) return;
      VW.modal.close('history-modal');
      document.querySelector('.nav-item[data-page="dashboard"]').click();
      VW.views.dashboard.openDetail(button.dataset.task);
    });
  }

  function init() {
    bindSettings();
    bindHistory();
  }

  return { init, notify, openSettings, openHistory };
})();