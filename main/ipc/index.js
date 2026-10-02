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
const chatService = require('../services/chat-service');
const httpServer = require('../runtime/http-server');
const runtime = require('../runtime/task-runtime');
const dirGrant = require('../runtime/dir-grant');
// 设置域逻辑（F2 拆分）：默认值/入参收敛/执行器配置合并与掩码装饰
const {
  readSettings,
  decorateSettings,
  sanitizeSettings,
  mergeExecutorConfig,
  decorateExecutorConfig
} = require('./settings');
const executorRegistry = require('../runtime/executor');
const { fail } = require('../util/errors');

const API_VERSION = 1;

/** 重启请求标志：app:relaunch 登记，before-quit 时由 main.js 经 consumeRelaunchRequest() 消费 */
let relaunchRequested = false;

/** 取走并复位重启请求（取走过即复位，防止 window-all-closed 等其他退出路径误触发 relaunch） */
function consumeRelaunchRequest() {
  const requested = relaunchRequested;
  relaunchRequested = false;
  return requested;
}


/**
 * IPC sender 信任校验：仅放行主窗口的顶层 file:// frame（iframe/webview/被销毁 frame 一律拒绝）。
 * event 同时缺 sender 与 senderFrame 时放行——测试直调与内部调用没有 Electron 事件；
 * 生产环境 IPC 事件恒有这两属性，缺一即拒。
 */
/** 收敛渲染层传入的保存文件名：剥掉路径片段并过滤非法字符，防止对话框 defaultPath 被注入相对/绝对路径 */
function safeFileName(name, fallback) {
  const base = path
    .basename(String(name ?? ''))
    .replace(/[\\/:*?"<>|\p{C}]/gu, '_')
    .replace(/^\.+$/, '')
    .trim();
  return base || fallback;
}

function isTrustedSender(event) {
  if (!event || (event.sender == null && event.senderFrame == null)) return true;
  const frame = event.senderFrame;
  if (!frame) return false;
  try {
    return frame.parent === null && String(frame.url || '').startsWith('file:');
  } catch (error) {
    return false; // frame 已销毁等异常，宁可误拒
  }
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!isTrustedSender(event)) {
      return {
        ok: false,
        apiVersion: API_VERSION,
        error: { code: 'FORBIDDEN', message: '请求来源不受信任', details: null }
      };
    }
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

// ==================== 事件转发（主进程事件总线 → 全部窗口） ====================
// 缓冲状态放在模块级：register() 可能被测试环境多次调用，重复订阅共享同一缓冲才安全

// task:created/updated 的 payload 是整个任务对象（含全部步骤）。真实 LLM 执行器高频步进时
// 每步会产生多次全量更新，直接逐条转发会淹没 IPC 通道与渲染层（O17）：
// 100ms 窗口内同一任务的多次变更只下发最后一条；其余事件（notice/removed/worker 等）立即转发
const TASK_EVENT_COALESCE_MS = 100;
let taskEventFlushTimer = null;
/** taskId → { type, payload }（保留首次插入位置，值被最新事件覆盖） */
const pendingTaskEvents = new Map();

function deliverEvent(event) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('app:event', event);
  });
}

function flushTaskEvents() {
  taskEventFlushTimer = null;
  const events = [...pendingTaskEvents.values()];
  pendingTaskEvents.clear();
  events.forEach(deliverEvent);
}

/** 事件转发是全局单例装配：重复 register()（测试环境）不得重复订阅 */
let eventForwardingWired = false;

function subscribeEventForwarding() {
  if (eventForwardingWired) return;
  eventForwardingWired = true;
  bus.on(({ type, payload }) => {
    if ((type === 'task:created' || type === 'task:updated') && payload?.id) {
      pendingTaskEvents.set(payload.id, { type, payload });
      if (!taskEventFlushTimer) {
        taskEventFlushTimer = setTimeout(flushTaskEvents, TASK_EVENT_COALESCE_MS);
        taskEventFlushTimer.unref?.(); // 不阻塞进程退出
      }
      return;
    }
    // 删除事件立即下发并丢弃该任务在窗口内的待发更新，避免渲染层「先删后又收到旧更新」
    if (type === 'task:removed' && payload?.id) {
      pendingTaskEvents.delete(payload.id);
    }
    deliverEvent({ type, payload });
  });
}

function register() {
  // 应用启动一次性拉取
  handle('app:bootstrap', () => {
    const settings = readSettings();
    return {
      workers: workerService.listWorkers(),
      groups: workerService.listGroups(),
      // 启动一次性拉取只给首屏渲染用（上限 200 条），完整列表由看板自身的分页刷新接管
      tasks: taskService.list({ period: settings.period, page: 1, pageSize: 200 }).items,
      stats: taskService.stats(settings.period),
      automations: automationService.list().items,
      automationStats: automationService.stats(),
      capabilityStats: { ...capabilityService.stats(), ...flowService.stats() },
      flows: flowService.list().items,
      shares: shareService.list(),
      shareStats: shareService.stats(),
      chatConnections: chatService.listConnections(),
      chatBindings: chatService.listBindings().items,
      chatStats: chatService.stats(),
      settings: decorateSettings(settings),
      runtime: { apiServer: httpServer.getStatus() }
    };
  });

  handle('settings:get', () => decorateSettings(readSettings()));
  handle('settings:update', (patch) => {
    const before = readSettings();
    const saved = db.setSettings(sanitizeSettings(patch));
    // 并发上限调大时立即排空等待队列（OPT-6）：滞留任务按优先级马上派发，
    // 而不是等下一次槽位释放才排空；调小不影响在途任务，无需处理
    if ((saved.maxConcurrent ?? 0) > (before.maxConcurrent ?? 0)) {
      runtime.drainWaiting();
    }
    // 端口变化时重启本地触发端点，新状态通过事件总线广播给渲染层；
    // 重启失败（如新端口被占用）则回滚端口设置并按原端口恢复服务，
    // 保证"已保存的设置"与"实际监听端口"始终一致
    if (saved.apiPort !== before.apiPort) {
      return httpServer.restart().then(async (runtimeStatus) => {
        if (!runtimeStatus.running) {
          const rolledBack = db.setSettings({ apiPort: before.apiPort });
          const restored = await httpServer.restart();
          bus.emit('app:runtime', { apiServer: restored });
          return decorateSettings({ ...rolledBack, apiPortRollback: before.apiPort });
        }
        bus.emit('app:runtime', { apiServer: runtimeStatus });
        return decorateSettings(saved);
      });
    }
    return decorateSettings(saved);
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
  /** 看板队列表：需要操作 / 待查收结果在主进程一次算完，渲染层不再拉全量周期任务自行过滤 */
  handle('task:queue', ({ period } = {}) => taskService.queue(period));
  /** 任务历史导出（含时间线）：与 list 共用筛选口径，内容经渲染层 app:save-file 落盘归档 */
  handle('task:export', (query = {}) => taskService.exportTasks(query));
  handle('task:create', (payload) => taskService.create(payload));
  handle('task:detail', ({ id } = {}) => taskService.detail(id));
  handle('task:cancel', ({ id, reason } = {}) => taskService.cancel(id, reason));
  /** 重试失败/已取消任务（F1）：以新任务重新入队；fromStep='failed' 时断点重跑 */
  handle('task:retry', ({ id, fromStep } = {}) => taskService.retry(id, { fromStep }));
  handle('task:ack', ({ id } = {}) => taskService.ack(id));
  /** 一键查收当前周期内全部待查收结果（看板「查收结果」页签，F8） */
  handle('task:ack-all', ({ period } = {}) => taskService.ackAll(period));
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
  /** 重新生成 API Token（旧 Token 立即失效） */
  handle('automation:regen-token', ({ id } = {}) => automationService.regenerateToken(id));
  /** 调用命令在服务层组装（含明文 Token），本层只负责写剪贴板——明文 Token 不下发渲染层 */
  handle('automation:copy-invocation', ({ id } = {}) => {
    const { command, tokenMask } = automationService.buildInvocation(
      id,
      httpServer.getStatus().port || db.getSettings().apiPort
    );
    clipboard.writeText(command);
    return { copied: true, tokenMask };
  });

  // 执行器模式（设置中心）：Mock / 真实执行器切换；真实执行器注册后即可在此切换
  handle('executor:list', () => ({
    names: executorRegistry.listNames(),
    active: executorRegistry.getActiveName(),
    configs: decorateExecutorConfig(readSettings().executorConfig)
  }));
  /** 切换执行器：持久化到设置（重启后恢复）+ 审计日志与事件（O16） */
  handle('executor:activate', ({ name } = {}) => {
    const target = String(name || '');
    const from = executorRegistry.getActiveName();
    try {
      executorRegistry.setActive(target);
    } catch (error) {
      throw fail.notFound('执行器不存在或未注册');
    }
    db.setSettings({ activeExecutor: executorRegistry.getActiveName() });
    console.log(`[executor] 执行器已切换：${from} → ${executorRegistry.getActiveName()}`);
    bus.emit('runtime:executor-changed', { from, to: executorRegistry.getActiveName() });
    return { names: executorRegistry.listNames(), active: executorRegistry.getActiveName() };
  });
  /** 执行器私有配置（O16）：敏感键经 vault 加密落库，响应为只读掩码视图 */
  handle('executor:configure', ({ name, config } = {}) => {
    const target = String(name || '');
    if (!executorRegistry.listNames().includes(target)) throw fail.notFound('执行器不存在或未注册');
    const merged = mergeExecutorConfig({ [target]: config });
    if (merged) db.setSettings({ executorConfig: merged });
    return { name: target, config: decorateExecutorConfig(readSettings().executorConfig)[target] || {} };
  });

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

  // @Worker（会话接入）
  handle('chat:platforms', () => chatService.platformCatalog());
  handle('chat:stats', () => chatService.stats());
  handle('chat:connection-list', () => chatService.listConnections());
  handle('chat:connection-create', (payload) => chatService.createConnection(payload));
  handle('chat:connection-update', ({ id, patch } = {}) => chatService.updateConnection(id, patch));
  handle('chat:connection-remove', ({ id } = {}) => chatService.removeConnection(id));
  handle('chat:chats', ({ connectionId } = {}) => chatService.listChats(connectionId));
  handle('chat:request-list', (query) => chatService.listRequests(query));
  handle('chat:request-approve', ({ id, workerId, workspace, model } = {}) =>
    chatService.approveRequest(id, { workerId, workspace, model })
  );
  handle('chat:request-reject', ({ id } = {}) => chatService.rejectRequest(id));
  handle('chat:binding-list', (query) => chatService.listBindings(query));
  handle('chat:binding-create', (payload) => chatService.createBinding(payload));
  handle('chat:binding-update', ({ id, patch } = {}) => chatService.updateBinding(id, patch));
  handle('chat:binding-toggle', ({ id, enabled } = {}) => chatService.toggleBinding(id, enabled));
  handle('chat:binding-remove', ({ id } = {}) => chatService.removeBinding(id));
  /** 模拟 IM 入站消息（mock 适配器演示链路；真实平台适配器接入后同样汇入 chat-service.ingest） */
  handle('chat:simulate-inbound', (payload) => chatService.ingest(payload));

  // 文件对话框与本地维护
  handle('app:save-file', async ({ suggestedName, content, title, filterName } = {}) => {
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showSaveDialog(parent, {
      title: String(title || '导出资源包'),
      defaultPath: safeFileName(suggestedName, 'virtworker-resource.json'),
      filters: [{ name: String(filterName || 'VirtWorker 资源包'), extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const text = String(content ?? '');
    if (text.length > 50 * 1024 * 1024) throw fail.validation('内容过大（上限 50MB）');
    // 异步写：50MB 同步写会阻塞主进程，期间 IPC/HTTP/任务运行时全部停摆
    await fs.promises.writeFile(result.filePath, text, 'utf8');
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
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 2 * 1024 * 1024) throw fail.validation('文件过大（上限 2MB）');
    return { canceled: false, filePath, content: await fs.promises.readFile(filePath, 'utf8') };
  });
  handle('app:data-stats', () => {
    const dir = path.join(app.getPath('userData'), 'data');
    // 文件名与体积来自目录本身，条数走 db 内存缓存计数——不再解析文件内容
    // （原先 readFileSync + JSON.parse 全部数据文件会阻塞主进程，且越过了 store 抽象，O11）
    let files;
    try {
      files = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const collection = db.COLLECTIONS.includes(name.replace(/\.json$/, '')) ? name.replace(/\.json$/, '') : null;
          let count = 0;
          if (collection) count = db.count(collection);
          else if (name === 'settings.json') count = 1;
          return { name, size: fs.statSync(path.join(dir, name)).size, count };
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
  // 数据快照备份（每日自动 + 手动）：.bak 只能回退一代写入损坏，快照防误删与逻辑损坏随时间扩散
  handle('app:backup-now', () => db.backup());
  handle('app:backup-list', () => ({ snapshots: db.listBackups(), keep: db.BACKUP_KEEP }));
  handle('app:open-backups-dir', async () => {
    const error = await shell.openPath(db.backupsRoot());
    return { opened: !error, error };
  });
  handle('app:restore-backup', async ({ name } = {}) => {
    // restore 已排入备份串行化链（BUG-28）：await 到真正恢复完成后再响应与退出
    const result = await db.restore(name);
    // 恢复后必须重启加载新数据；quit 流程的 flush 在只读保护下不会覆盖刚恢复的文件
    relaunchRequested = true;
    // 先把响应送达渲染层再退出（BUG-30）：同步 quit 会让响应与退出竞速，
    // 渲染层收不到结果，无法展示「恢复中」过渡态，用户可能误以为点击无效而重复操作
    setTimeout(() => app.quit(), 300);
    return result;
  });
  handle('app:relaunch', () => {
    // app.exit(0) 会跳过 before-quit（db.flush / runtime / scheduler / 日志清理全部不执行），
    // 是唯一绕过落盘的退出路径。改为登记重启请求后走 app.quit() 的完整退出流程，
    // 由 main.js 在 before-quit 中消费标志并登记 app.relaunch()
    relaunchRequested = true;
    app.quit();
    return { relaunching: true };
  });
  handle('app:purge-preview', () => taskService.purgePreview(readSettings().taskRetentionDays));
  handle('app:purge-tasks', () => taskService.purgeExpired(readSettings().taskRetentionDays));

  // 通用能力：由主进程写系统剪贴板（复制端点/Token）
  handle('app:copy-text', ({ text } = {}) => {
    clipboard.writeText(String(text ?? ''));
    return { copied: true };
  });

  subscribeEventForwarding();
}

module.exports = { register, API_VERSION, consumeRelaunchRequest };