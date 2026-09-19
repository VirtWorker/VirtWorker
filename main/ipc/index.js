/**
 * IPC 注册中心：通道 → 服务方法。
 * - 统一响应包：{ ok: true, data, apiVersion } / { ok: false, error: { code, message, details }, apiVersion }
 * - 统一把事件总线上的事件以 app:event 转发给所有窗口
 */

const { ipcMain, BrowserWindow, clipboard, dialog, shell, app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const bus = require('../runtime/event-bus');
const db = require('../store/db');
const workerService = require('../services/worker-service');
const taskService = require('../services/task-service');
const automationService = require('../services/automation-service');
const capabilityService = require('../services/capability-service');
const flowService = require('../services/flow-service');
const shareService = require('../services/share-service');
const httpServer = require('../runtime/http-server');
const dirGrant = require('../runtime/dir-grant');
const { fail } = require('../util/errors');

const API_VERSION = 1;

const DEFAULT_SETTINGS = {
  taskView: 'list',
  period: 'month',
  mockRandomAction: true,
  notify: true,
  catchUpMissed: true,
  apiPort: httpServer.DEFAULT_PORT,
  /** 已结束且已查收的任务保留天数 */
  taskRetentionDays: 90,
  /** 界面主题：浅色 / 深色 / 跟随系统 */
  theme: 'system'
};
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
const TASK_VIEWS = ['list', 'board'];
const PERIODS = ['week', 'month', 'quarter'];
const THEMES = ['light', 'dark', 'system'];

function readSettings() {
  return { ...DEFAULT_SETTINGS, ...db.getSettings() };
}

/** 收敛渲染层传入的保存文件名：剥掉路径片段并过滤非法字符，防止对话框 defaultPath 被注入相对/绝对路径 */
function safeFileName(name, fallback) {
  const base = path
    .basename(String(name ?? ''))
    .replace(/[\\/:*?"<>|\p{C}]/gu, '_')
    .replace(/^\.+$/, '')
    .trim();
  return base || fallback;
}

/** 入参校验只做边界收敛，业务校验仍在服务层 */
function sanitizeSettings(patch = {}) {
  const safe = {};
  SETTINGS_KEYS.forEach((key) => {
    if (patch[key] === undefined) return;
    if (key === 'taskView' && !TASK_VIEWS.includes(patch[key])) return;
    if (key === 'period' && !PERIODS.includes(patch[key])) return;
    if (key === 'theme' && !THEMES.includes(patch[key])) return;
    if (key === 'apiPort') {
      const port = Number(patch[key]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
      safe[key] = port;
      return;
    }
    if (key === 'taskRetentionDays') {
      const days = Number(patch[key]);
      if (!Number.isInteger(days) || days < 1 || days > 3650) return;
      safe[key] = days;
      return;
    }
    safe[key] = typeof DEFAULT_SETTINGS[key] === 'boolean' ? Boolean(patch[key]) : patch[key];
  });
  return safe;
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await handler(payload), apiVersion: API_VERSION };
    } catch (error) {
      const isBusiness = Boolean(error) && error.name === 'AppError';
      if (!isBusiness) console.error(`[ipc] ${channel} 未预期异常:`, error);
      return {
        ok: false,
        apiVersion: API_VERSION,
        error: {
          code: isBusiness ? error.code : 'INTERNAL',
          message: isBusiness ? error.message : '系统内部错误，请重试',
          details: isBusiness ? error.details : null
        }
      };
    }
  });
}

function register() {
  // 应用启动一次性拉取
  handle('app:bootstrap', () => {
    const settings = readSettings();
    return {
      workers: workerService.listWorkers(),
      groups: workerService.listGroups(),
      tasks: taskService.list({ period: settings.period }).items,
      stats: taskService.stats(settings.period),
      automations: automationService.list().items,
      automationStats: automationService.stats(),
      capabilityStats: { ...capabilityService.stats(), ...flowService.stats() },
      flows: flowService.list().items,
      shares: shareService.list(),
      shareStats: shareService.stats(),
      settings,
      runtime: { apiServer: httpServer.getStatus() }
    };
  });

  handle('settings:get', () => readSettings());
  handle('settings:update', (patch) => {
    const before = readSettings();
    const saved = db.setSettings(sanitizeSettings(patch));
    // 端口变化时重启本地触发端点，新状态通过事件总线广播给渲染层；
    // 重启失败（如新端口被占用）则回滚端口设置并按原端口恢复服务，
    // 保证"已保存的设置"与"实际监听端口"始终一致
    if (saved.apiPort !== before.apiPort) {
      return httpServer.restart().then(async (runtime) => {
        if (!runtime.running) {
          const rolledBack = db.setSettings({ apiPort: before.apiPort });
          const restored = await httpServer.restart();
          bus.emit('app:runtime', { apiServer: restored });
          return { ...rolledBack, apiPortRollback: before.apiPort };
        }
        bus.emit('app:runtime', { apiServer: runtime });
        return saved;
      });
    }
    return saved;
  });

  // 员工资源
  handle('worker:list', (query) => workerService.listWorkers(query));
  handle('worker:create', (payload) => workerService.createWorker(payload));
  handle('worker:update', ({ id, patch } = {}) => workerService.updateWorker(id, patch));
  handle('worker:remove', ({ id } = {}) => workerService.removeWorker(id));
  /** 能力挂载：等价于更新 Worker 的 capabilityIds */
  handle('worker:mount', ({ id, capabilityIds } = {}) => workerService.updateWorker(id, { capabilityIds }));

  handle('group:list', () => workerService.listGroups());
  handle('group:create', (payload) => workerService.createGroup(payload));
  handle('group:update', ({ id, patch } = {}) => workerService.updateGroup(id, patch));
  handle('group:remove', ({ id } = {}) => workerService.removeGroup(id));

  // 任务体系
  handle('task:list', (query) => taskService.list(query));
  handle('task:stats', ({ period } = {}) => taskService.stats(period));
  handle('task:create', (payload) => taskService.create(payload));
  handle('task:detail', ({ id } = {}) => taskService.detail(id));
  handle('task:cancel', ({ id, reason } = {}) => taskService.cancel(id, reason));
  handle('task:ack', ({ id } = {}) => taskService.ack(id));
  handle('task:answer', (payload) => taskService.answer(payload));

  // 自主工作（自动任务）
  handle('automation:list', (query) => automationService.list(query));
  handle('automation:stats', () => automationService.stats());
  handle('automation:create', (payload) => automationService.create(payload));
  handle('automation:update', ({ id, patch } = {}) => automationService.update(id, patch));
  handle('automation:toggle', ({ id, enabled } = {}) => automationService.toggle(id, enabled));
  handle('automation:remove', ({ id } = {}) => automationService.remove(id));
  handle('automation:detail', ({ id } = {}) => automationService.detail(id));
  handle('automation:runtime', () => ({ apiServer: httpServer.getStatus() }));

  // 能力与资源
  handle('capability:list', (query) => capabilityService.list(query));
  handle('capability:stats', () => ({ ...capabilityService.stats(), ...flowService.stats() }));
  handle('capability:skill-market', (query) => capabilityService.skillMarket(query));
  handle('capability:install-skill', ({ skillId } = {}) => capabilityService.installSkill(skillId));
  handle('capability:remove', ({ id } = {}) => capabilityService.uninstall(id));
  handle('capability:connector-catalog', () => capabilityService.connectorCatalog());
  handle('capability:authorize', ({ key, secret } = {}) => capabilityService.authorizeConnector(key, { secret }));
  handle('capability:revoke', ({ id } = {}) => capabilityService.revokeConnector(id));
  handle('capability:create-knowledge', (payload = {}) => {
    // 目录必须来自目录选择对话框的一次性授权，防止渲染层传入任意路径读取本地文件
    const { dir, ticket } = payload;
    if (!dirGrant.consume(ticket, dir)) throw fail.validation('目录未授权，请重新通过对话框选择目录');
    // 完整透传 payload（含 name/desc），否则服务层校验"请填写知识库名称"必然失败
    return capabilityService.createKnowledge(payload);
  });
  handle('capability:reindex', ({ id } = {}) => capabilityService.reindexKnowledge(id));
  handle('capability:search', ({ id, keyword, limit } = {}) => capabilityService.searchKnowledge(id, keyword, limit));
  handle('capability:pick-directory', async () => {
    // 目录选择必须由主进程发起；测试环境（无窗口）直接返回空，由调用方改用入参传入
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(parent, {
      title: '选择要导入的目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return { dir: '', ticket: '' };
    const dir = result.filePaths[0];
    return { dir, ticket: dirGrant.grant(dir) };
  });

  // WorkerFlow
  handle('flow:list', (query) => flowService.list(query));
  handle('flow:create', (payload) => flowService.create(payload));
  handle('flow:update', ({ id, patch } = {}) => flowService.update(id, patch));
  handle('flow:remove', ({ id } = {}) => flowService.remove(id));
  handle('flow:detail', ({ id } = {}) => flowService.detail(id));

  // 分享与公开项目
  handle('share:list', () => shareService.list());
  handle('share:stats', () => shareService.stats());
  handle('share:create', (payload) => shareService.createShare(payload));
  handle('share:visibility', ({ id, visibility } = {}) => shareService.setVisibility(id, visibility));
  handle('share:remove', ({ id } = {}) => shareService.remove(id));
  handle('share:preview', ({ code } = {}) => shareService.previewByCode(code));
  handle('share:import', ({ code } = {}) => shareService.importByCode(code));
  /** 生成资源包内容（不落盘），由渲染层再决定是否保存为文件 */
  handle('share:export', ({ resourceType, resourceId } = {}) => shareService.buildPayload(resourceType, resourceId));
  /** 直接导入资源包内容（文件导入路径） */
  handle('share:import-payload', (payload) => shareService.importPayload(payload));

  // 文件对话框与本地维护
  handle('app:save-file', async ({ suggestedName, content } = {}) => {
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showSaveDialog(parent, {
      title: '导出资源包',
      defaultPath: safeFileName(suggestedName, 'virtworker-resource.json'),
      filters: [{ name: 'VirtWorker 资源包', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, String(content ?? ''), 'utf8');
    return { canceled: false, filePath: result.filePath };
  });
  handle('app:open-file', async () => {
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(parent, {
      title: '选择资源包文件',
      properties: ['openFile'],
      filters: [{ name: 'VirtWorker 资源包', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const filePath = result.filePaths[0];
    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) throw fail.validation('文件过大（上限 2MB）');
    return { canceled: false, filePath, content: fs.readFileSync(filePath, 'utf8') };
  });
  handle('app:data-stats', () => {
    const dir = path.join(app.getPath('userData'), 'data');
    let files = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const filePath = path.join(dir, name);
          let count = 0;
          try {
            const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            count = Array.isArray(payload.items) ? payload.items.length : 1;
          } catch (error) {
            count = 0;
          }
          return { name, size: fs.statSync(filePath).size, count };
        });
    } catch (error) {
      files = [];
    }
    return { dir, files, totalSize: files.reduce((total, file) => total + file.size, 0) };
  });
  handle('app:open-data-dir', async () => {
    const error = await shell.openPath(path.join(app.getPath('userData'), 'data'));
    return { opened: !error, error };
  });
  handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
    return { relaunching: true };
  });
  handle('app:purge-preview', () => taskService.purgePreview(readSettings().taskRetentionDays));
  handle('app:purge-tasks', () => taskService.purgeExpired(readSettings().taskRetentionDays));

  // 通用能力：由主进程写系统剪贴板（复制端点/Token）
  handle('app:copy-text', ({ text } = {}) => {
    clipboard.writeText(String(text ?? ''));
    return { copied: true };
  });

  bus.on(({ type, payload }) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send('app:event', { type, payload });
    });
  });
}

module.exports = { register, API_VERSION };