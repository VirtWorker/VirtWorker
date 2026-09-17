/**
 * IPC 注册中心：通道 → 服务方法。
 * - 统一响应包：{ ok: true, data, apiVersion } / { ok: false, error: { code, message, details }, apiVersion }
 * - 统一把事件总线上的事件以 app:event 转发给所有窗口
 */

const { ipcMain, BrowserWindow } = require('electron');
const bus = require('../runtime/event-bus');
const db = require('../store/db');
const workerService = require('../services/worker-service');
const taskService = require('../services/task-service');

const API_VERSION = 1;

const DEFAULT_SETTINGS = { taskView: 'list', period: 'month', mockRandomAction: true, notify: true };
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
const TASK_VIEWS = ['list', 'board'];
const PERIODS = ['week', 'month', 'quarter'];

function readSettings() {
  return { ...DEFAULT_SETTINGS, ...db.getSettings() };
}

/** 入参校验只做边界收敛，业务校验仍在服务层 */
function sanitizeSettings(patch = {}) {
  const safe = {};
  SETTINGS_KEYS.forEach((key) => {
    if (patch[key] === undefined) return;
    if (key === 'taskView' && !TASK_VIEWS.includes(patch[key])) return;
    if (key === 'period' && !PERIODS.includes(patch[key])) return;
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
      settings
    };
  });

  handle('settings:get', () => readSettings());
  handle('settings:update', (patch) => db.setSettings(sanitizeSettings(patch)));

  // 员工资源
  handle('worker:list', (query) => workerService.listWorkers(query));
  handle('worker:create', (payload) => workerService.createWorker(payload));
  handle('worker:update', ({ id, patch } = {}) => workerService.updateWorker(id, patch));
  handle('worker:remove', ({ id } = {}) => workerService.removeWorker(id));

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

  bus.on(({ type, payload }) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send('app:event', { type, payload });
    });
  });
}

module.exports = { register, API_VERSION };