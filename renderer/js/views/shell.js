/**
 * 侧边栏全局入口：设置中心 与 历史记录（最近任务）
 * 两者都是壳层工具，数据仍来自主进程，本模块只做展示与提交。
 */
window.VW = window.VW || {};

VW.views = VW.views || {};

VW.views.shell = (() => {
  const { escapeHtml, formatTime, assigneeLabel, historyListHtml } = VW.util;
  const store = VW.store;

  // ==================== 设置中心 ====================

  const EXECUTOR_LABEL = { mock: '模拟执行（Mock）', llm: '大模型执行（LLM）' };

  /** 执行器模式：拉取注册中心并填充选择框；选中 LLM 时展开其配置表单 */
  async function refreshExecutorSelect() {
    const select = document.getElementById('setting-executor');
    if (!select) return;
    try {
      const { names, active, configs } = await VW.api.executor.list();
      select.innerHTML = names
        .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(EXECUTOR_LABEL[name] || name)}</option>`)
        .join('');
      select.value = names.includes(active) ? active : names[0] || '';
      VW.dropdown.refresh(select);
      fillLlmConfig(configs?.llm || {});
      toggleLlmConfig(select.value === 'llm');
    } catch (error) {
      console.warn('[shell] 执行器列表加载失败:', error.message);
    }
  }

  /** 回填 LLM 配置：apiKey 为主进程下发的只读掩码（{ masked, mask }），只展示不回填输入框 */
  function fillLlmConfig(config) {
    document.getElementById('llm-base-url').value = config.baseUrl || '';
    document.getElementById('llm-model').value = config.model || '';
    document.getElementById('llm-api-key').value = '';
    updateLlmHint(config);
  }

  function updateLlmHint(config) {
    const hint = document.getElementById('llm-hint');
    if (!hint) return;
    if (config.apiKey?.masked) hint.textContent = `已保存配置，密钥 ${config.apiKey.mask || '••••'}`;
    else if (config.baseUrl && config.model) hint.textContent = '已保存配置（未设置密钥）';
    else hint.textContent = '尚未配置';
  }

  function toggleLlmConfig(visible) {
    document.getElementById('llm-config')?.classList.toggle('hidden', !visible);
  }

  async function activateExecutor(name) {
    try {
      const { active } = await VW.api.executor.activate(name);
      toggleLlmConfig(active === 'llm');
      VW.toast.show(EXECUTOR_LABEL[active] ? `已切换为${EXECUTOR_LABEL[active]}` : `执行器已切换为「${active}」`);
    } catch (error) {
      VW.toast.fromError(error);
      await refreshExecutorSelect();
    }
  }

  /** 保存 LLM 私有配置：apiKey 留空 = 不修改已保存密钥（掩码回传语义，由主进程 mergeExecutorConfig 保证） */
  async function saveLlmConfig() {
    const button = document.getElementById('llm-save-btn');
    const form = document.getElementById('llm-config');
    await VW.util.withSubmitting(form, async () => {
      if (button) button.disabled = true;
      try {
        const baseUrl = document.getElementById('llm-base-url').value.trim();
        const model = document.getElementById('llm-model').value.trim();
        const apiKey = document.getElementById('llm-api-key').value.trim();
        if (!baseUrl || !model) {
          VW.toast.show('请先填写 API 地址与模型名');
          return;
        }
        const config = { baseUrl, model };
        if (apiKey) config.apiKey = apiKey; // 留空不发送：保留库内已加密的旧密钥
        const { config: saved } = await VW.api.executor.configure('llm', config);
        document.getElementById('llm-api-key').value = '';
        updateLlmHint(saved || {}); // 响应为掩码视图（apiKey: { masked, mask }）
        VW.toast.show('LLM 配置已保存');
      } finally {
        if (button) button.disabled = false;
      }
    });
  }

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
      VW.toast.fromError(error);
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
    document.getElementById('setting-max-concurrent').value = settings.maxConcurrent || 5;
    document.getElementById('setting-action-timeout').value = settings.actionTimeoutHours ?? 48;
    document.getElementById('setting-action-policy').value = settings.actionTimeoutPolicy || 'remind';
    document.getElementById('setting-api-hint').textContent = store.state.apiServer.running
      ? `运行中：http://127.0.0.1:${store.state.apiServer.port}`
      : `未启动${store.state.apiServer.error ? `：${store.state.apiServer.error}` : ''}`;
    VW.modal.open('settings-modal');
    await Promise.all([refreshDataStats(), refreshExecutorSelect(), refreshBackups()]);
  }

  /** 数值字段统一校验：合法返回数值，非法记录字段名并回退旧值——
   *  此前非法输入被静默钳制回旧值，用户不知道自己填的内容被丢弃了（C3） */
  function pickNumber(value, { min, max, fallback }) {
    const num = Number(value);
    if (Number.isInteger(num) && num >= min && num <= max) return num;
    return fallback;
  }

  function invalidField(value, { min, max, label, range }) {
    const num = Number(value);
    const ok = Number.isInteger(num) && num >= min && num <= max;
    if (ok) return null;
    return `${label}（${range}）`;
  }

  /**
   * 等待本地端点重启结果（C3）：优先等主进程广播的 app:runtime 事件（事件驱动），
   * 超时兜底返回当前状态。此前固定等待 1.2 秒——慢机器误报「启动失败」，快机器白等。
   * 订阅在保存响应返回后同步注册，不会错过主进程后续发出的事件。
   */
  function waitForApiServer(timeoutMs = 5000) {
    return new Promise((resolve) => {
      let settled = false;
      let off = null;
      const finish = (server) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (off) off();
        resolve(server || store.state.apiServer);
      };
      off = VW.api.onEvent(({ type, payload }) => {
        if (type === 'app:runtime' && payload?.apiServer) finish(payload.apiServer);
      });
      const timer = setTimeout(() => finish(), timeoutMs);
    });
  }

  async function saveSettings() {
    const port = Number(document.getElementById('setting-api-port').value);
    const retention = Number(document.getElementById('setting-retention').value);
    const maxConcurrent = Number(document.getElementById('setting-max-concurrent').value);
    const actionTimeoutHours = Number(document.getElementById('setting-action-timeout').value);
    const field = (value, spec) => {
      const invalid = invalidField(value, spec);
      if (invalid) invalidFields.push(invalid);
      return pickNumber(value, spec);
    };
    const invalidFields = [];
    const patch = {
      maxConcurrent: field(maxConcurrent, {
        min: 1,
        max: 20,
        fallback: store.state.settings.maxConcurrent,
        label: '并发上限',
        range: '1-20'
      }),
      actionTimeoutHours: field(actionTimeoutHours, {
        min: 0,
        max: 8760,
        fallback: store.state.settings.actionTimeoutHours,
        label: '操作超时',
        range: '0-8760 小时'
      }),
      actionTimeoutPolicy: document.getElementById('setting-action-policy').value,
      notify: document.getElementById('setting-notify').checked,
      catchUpMissed: document.getElementById('setting-catchup').checked,
      mockRandomAction: document.getElementById('setting-random-action').checked,
      theme: document.getElementById('setting-theme').value,
      apiPort: field(port, {
        min: 1024,
        max: 65535,
        fallback: store.state.settings.apiPort,
        label: 'API 端口',
        range: '1024-65535'
      }),
      taskRetentionDays: field(retention, {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
        fallback: store.state.settings.taskRetentionDays,
        label: '任务保留期',
        range: '≥1 天'
      })
    };
    if (invalidFields.length) {
      VW.toast.show(`以下输入无效，已保留原值：${invalidFields.join('、')}`, { level: 'warn' });
    }

    try {
      const saved = await VW.api.settings.update(patch);
      store.set({ settings: saved });
      VW.applyTheme(saved.theme);
      VW.modal.close('settings-modal');

      // 主进程重启端点失败时已回滚端口设置，响应携带 apiPortRollback 指明回退到的端口
      if (saved.apiPortRollback) {
        VW.toast.show(`端口 ${patch.apiPort} 被占用，已回退为 ${saved.apiPort}`);
        return;
      }
      VW.toast.show('设置已保存');

      // 端口改动后主进程会自动重启本地端点并广播 app:runtime，据此提示结果
      if (patch.apiPort !== store.state.apiServer.port) {
        const server = await waitForApiServer();
        if (server.running) VW.toast.show(`API 端点已在 ${server.port} 端口生效`);
        else VW.toast.show(`API 端点启动失败：${server.error || '端口不可用'}`);
      }
    } catch (error) {
      VW.toast.fromError(error);
    }
  }

  async function purgeTasks() {
    await VW.util.submitAction(
      async () => {
        const result = await VW.api.app.purgeTasks();
        await Promise.all([refreshDataStats(), VW.views.dashboard.refresh({ silent: true })]);
        return result;
      },
      {
        confirm: '确认立即清理已结束且超过保留期限的历史任务？清理后不可恢复。',
        success: (result) => (result.removed ? `已清理 ${result.removed} 条历史任务` : '没有需要清理的任务')
      }
    );
  }

  // ==================== 数据快照与任务归档 ====================

  /** 拉取快照列表填充恢复下拉；没有快照时按钮禁用 */
  async function refreshBackups() {
    const select = document.getElementById('backup-select');
    if (!select) return;
    try {
      const { snapshots, keep } = await VW.api.app.backupList();
      select.innerHTML = snapshots.length
        ? snapshots
            .map((snap) => `<option value="${escapeHtml(snap.name)}">${escapeHtml(snap.name)}（${snap.files} 个文件）</option>`)
            .join('')
        : '<option value="">暂无备份快照</option>';
      document.getElementById('backup-hint').textContent = `每日自动备份，保留最近 ${keep} 份`;
      VW.dropdown.refresh(select);
    } catch (error) {
      console.warn('[shell] 备份列表加载失败:', error.message);
    }
  }

  async function backupNow() {
    try {
      const result = await VW.api.app.backupNow();
      VW.toast.show(result.files ? `已备份 ${result.files} 个文件到 backups 目录` : '备份完成（数据目录为空）');
      await refreshBackups();
    } catch (error) {
      VW.toast.fromError(error);
    }
  }

  async function restoreBackup() {
    const select = document.getElementById('backup-select');
    const name = select?.value;
    if (!name) {
      VW.toast.show('没有可恢复的备份快照');
      return;
    }
    await VW.util.submitAction(() => VW.api.app.restoreBackup(name), {
      // 恢复会覆盖当前全部数据并由主进程重启应用加载，必须二次确认
      confirm: `恢复备份「${name}」将覆盖当前全部数据，恢复后应用会自动重启。确定继续？`,
      success: '备份已恢复，应用即将重启…'
    });
  }

  /** 导出全部任务历史（含时间线）为 JSON 归档文件，内容经 app:save-file 对话框落盘 */
  async function exportTasks() {
    try {
      const payload = await VW.api.task.export({ period: '' });
      const stamp = new Date().toISOString().slice(0, 10);
      const result = await VW.api.app.saveFile({
        suggestedName: `virtworker-tasks-${stamp}.json`,
        title: '导出任务历史',
        filterName: 'VirtWorker 任务归档',
        content: JSON.stringify(payload, null, 2)
      });
      if (!result.canceled) VW.toast.show(`已导出 ${payload.count} 条任务记录`);
    } catch (error) {
      VW.toast.fromError(error);
    }
  }

  function bindSettings() {
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    VW.modal.bindClose('settings-modal', 'settings-modal-close', 'settings-modal-cancel');
    document.getElementById('settings-modal-save').addEventListener('click', saveSettings);
    document.getElementById('setting-executor').addEventListener('change', (event) => activateExecutor(event.target.value));
    document.getElementById('llm-save-btn').addEventListener('click', saveLlmConfig);
    document.getElementById('purge-tasks-btn').addEventListener('click', purgeTasks);
    document.getElementById('open-data-dir-btn').addEventListener('click', async () => {
      try {
        const result = await VW.api.app.openDataDir();
        if (!result.opened) VW.toast.show(result.error || '打开目录失败');
      } catch (error) {
        VW.toast.fromError(error);
      }
    });
    document.getElementById('backup-now-btn').addEventListener('click', backupNow);
    document.getElementById('open-backups-btn').addEventListener('click', async () => {
      try {
        const result = await VW.api.app.openBackupsDir();
        if (!result.opened) VW.toast.show(result.error || '打开目录失败');
      } catch (error) {
        VW.toast.fromError(error);
      }
    });
    document.getElementById('restore-backup-btn').addEventListener('click', restoreBackup);
    document.getElementById('export-tasks-btn').addEventListener('click', exportTasks);
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
      VW.toast.fromError(error);
    }
  }

  function bindHistory() {
    document.getElementById('history-btn').addEventListener('click', openHistory);
    VW.modal.bindClose('history-modal', 'history-modal-close', 'history-modal-ok');
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

  return { init, openSettings, openHistory };
})();