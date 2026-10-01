const { app, BrowserWindow, shell, ipcMain, Notification, dialog } = require('electron');
const path = require('node:path');
const db = require('./store/db');
const ipc = require('./ipc');
const executor = require('./runtime/executor');
const executorMock = require('./runtime/executor-mock');
const executorLlm = require('./runtime/executor-llm');
const runtime = require('./runtime/task-runtime');
const scheduler = require('./runtime/scheduler');
const httpServer = require('./runtime/http-server');
const webhookNotifier = require('./runtime/webhook-notifier');
const taskService = require('./services/task-service');
const chatService = require('./services/chat-service');
const logger = require('./util/logger');
const bus = require('./runtime/event-bus');

// 尽早接管全局异常并镜像 console，让启动阶段的错误也能落盘
logger.init(path.join(app.getPath('userData'), 'logs'));
logger.mirrorConsole();
logger.installGlobalHandlers();

// 存储异常经事件总线广播为应用通知（IPC 层转发到窗口）；窗口就绪前产生的告警由 db 缓存、稍后补发
db.setNotify((notice) => bus.emit('app:notice', notice));

/**
 * 主进程入口：负责窗口创建、应用生命周期管理、领域服务装配与全局安全设置。
 */

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** 渲染进程连续崩溃计数（自动恢复上限，防止无限重启循环） */
let renderCrashCount = 0;
const MAX_RENDER_CRASH_RECOVERY = 3;
// 页面加载成功后需稳定运行满该时长才视为"真正恢复"并重置崩溃计数（BUG-19）：
// 若渲染层"加载成功后必崩"（GPU/坏插件），加载即重置计数会让自动恢复永不触及上限，形成无限崩溃-重启循环
const RENDER_CRASH_STABLE_MS = 10 * 1000;
let renderStableTimer = null;

/** 单实例锁：避免重复启动多个应用实例（Windows 桌面应用常规实践） */
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // 注意：app.quit() 是异步的，whenReady 回调仍可能执行，需用标志位短路后续初始化，
  // 防止第二实例在退出完成前短暂写同一份数据目录
  app.quit();
}

/**
 * 装配领域层：分层初始化，避免单个 try/catch 包住全部时「一步失败、后续全跳过」——
 * 尤其 ipc.register 被跳过后渲染层所有通道无 handler，应用沦为无提示的空壳窗口。
 * 分层规则：
 *  - 致命层（存储 / 执行器装配 / IPC 通道）：失败弹窗告知 + 记日志后退出，绝不空壳假启动；
 *  - 降级层（运行时 / 调度 / Webhook / 聊天回执 / 本地端点）：单个失败只降级该子系统，
 *    其余照常启动，并广播通知告知用户哪个功能不可用。
 * @returns {boolean} false = 致命失败已发起退出，调用方不得继续创建窗口
 */
function bootstrapServices() {
  // 致命层 1：存储是一切服务的前置依赖
  try {
    db.init(path.join(app.getPath('userData'), 'data'));
  } catch (error) {
    console.error('[main] 数据目录初始化失败:', error);
    dialog.showErrorBox(
      'VirtWorker 无法启动',
      `数据目录初始化失败，请检查磁盘空间与 %APPDATA% 写入权限后重试。\n\n${error.message}`
    );
    logger.close();
    app.exit(1);
    return false;
  }

  // 致命层 2：执行器装配与 IPC 通道——渲染层所有交互的入口
  try {
    executor.register(executorMock, { activate: true });
    executor.register(executorLlm); // 真实 LLM 执行器（NEW-1）：在设置中心配置 baseUrl/model/apiKey 后可切换
    restoreExecutorPreference(); // 恢复持久化的执行器选择（O16）
    ipc.register();
  } catch (error) {
    console.error('[main] 执行器/IPC 装配失败:', error);
    dialog.showErrorBox('VirtWorker 无法启动', `服务装配失败，请重启应用。\n\n${error.message}`);
    db.flush();
    logger.close();
    app.exit(1);
    return false;
  }

  // 降级层：各子系统独立启动，互不拖累
  const startSteps = [
    ['任务运行时', () => runtime.start()], // 恢复上次未完成的任务（排队重新派发、执行中继续）
    ['自动任务调度', () => scheduler.start()], // 补跑错过的定时任务并排程
    ['Webhook 通知', () => webhookNotifier.start()], // 任务终态出站通知（F2）
    ['聊天回执', () => chatService.startNotifier()], // 聊天出站回执（F3）
    ['本地 API 端点', () => httpServer.start()] // API 触发的本地端点（仅回环地址）
  ];
  for (const [name, start] of startSteps) {
    try {
      start();
    } catch (error) {
      console.error(`[main] ${name}启动失败:`, error);
      // 窗口就绪前发出的通知无法送达渲染层（尽力而为），必须同时落日志
      bus.emit('app:notice', {
        level: 'error',
        title: `${name}启动失败`,
        body: '该功能本次会话不可用，其余功能不受影响；重启应用可尝试恢复。'
      });
    }
  }

  startDailyMaintenance(); // 每日维护：过期任务清理（启动即跑一次）+ 数据快照，内部已逐步兜底
  return true;
}

/** 恢复持久化的执行器选择（O16）：所选执行器未注册（如配置了真实执行器但当前未接入）时保持 mock */
function restoreExecutorPreference() {
  const preferred = db.getSettings().activeExecutor;
  if (!preferred || preferred === executorMock.name) return;
  try {
    executor.setActive(preferred);
    console.log(`[main] 已恢复执行器：${preferred}`);
  } catch (error) {
    console.warn(`[main] 执行器「${preferred}」未注册，保持模拟执行器`);
  }
}

/** 首次维护延迟：备份是整目录同步拷贝，数据目录大时直接在启动路径上跑会造成启动卡顿 */
const MAINTENANCE_START_DELAY_MS = 30 * 1000;

/**
 * 每日维护（O7）：启动 30 秒后首跑，此后每 24 小时一次。
 * - 过期任务清理：保留策略此前只在启动时执行，长期运行的自动化场景下过期任务会持续堆积
 * - 数据快照：.bak 只能回退一代写入损坏，快照防的是误删与逻辑损坏随时间扩散（保留最近 7 份，见 db.js）
 */
function startDailyMaintenance() {
  const run = () => {
    try {
      const { archived } = taskService.archiveAged();
      if (archived) console.log(`[main] 每日维护：已归档 ${archived} 条已查收的历史任务（BUG-20 写放大治理）`);
    } catch (error) {
      console.error('[main] 每日维护：任务归档失败:', error.message);
    }
    try {
      const { removed, retention } = taskService.purgeExpired(db.getSettings().taskRetentionDays);
      if (removed) console.log(`[main] 每日维护：已按保留策略（${retention} 天）清理 ${removed} 条历史任务`);
    } catch (error) {
      console.error('[main] 每日维护：过期任务清理失败:', error.message);
    }
    try {
      const orphans = taskService.purgeOrphanEvents();
      if (orphans) console.log(`[main] 每日维护：清扫孤儿任务时间线 ${orphans} 条（O13）`);
    } catch (error) {
      console.error('[main] 每日维护：孤儿时间线清扫失败:', error.message);
    }
    try {
      const result = db.backup();
      if (result.files) console.log(`[main] 每日维护：数据快照完成（${result.files} 个文件）→ ${result.dir}`);
    } catch (error) {
      console.error('[main] 每日维护：数据快照失败:', error.message);
    }
  };
  const first = setTimeout(run, MAINTENANCE_START_DELAY_MS);
  first.unref?.(); // 不阻塞进程退出
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref?.(); // 不阻塞进程退出
}

/**
 * 外链安全放行：用 URL 解析校验协议，防止大小写混排、控制字符等变体
 * 绕过字符串前缀判断；拒绝携带 userinfo（https://evil.com@host 形态）的地址。
 */
function openExternalIfSafe(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password) {
      shell.openExternal(parsed.href);
    }
  } catch (error) {
    // 非法 URL 直接忽略，不打开
  }
}

/**
 * 渲染进程连续崩溃达上限后的用户告知（BUG-12）：不能只留在日志里让用户面对无提示的白屏。
 * 绕过 wireSystemNotifications 的「窗口聚焦抑制」——白屏时用户可能正盯着窗口，必须直接弹系统通知；
 * 也不受 notify 设置开关限制（关键故障告知优先于免打扰）。点击通知 = 用户显式重试：
 * 重置崩溃计数并重新加载（窗口已销毁时重建），配合焦点还原。
 */
function notifyRenderCrashLimit() {
  if (!Notification?.isSupported?.()) return;
  const notification = new Notification({
    title: 'VirtWorker 界面已停止响应',
    body: '界面连续崩溃多次，已停止自动恢复。点击此通知可尝试重新加载，建议尽快重启应用。'
  });
  notification.on('click', () => {
    renderCrashCount = 0; // 人为的显式重试：重新计数，自动恢复机制重新可用
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
  notification.show();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false, // 防止启动时白屏闪烁，ready-to-show 后再显示
    title: 'VirtWorker',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      // 安全最佳实践：关闭 Node 集成，开启上下文隔离与沙箱
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 显式禁用危险特性
      webviewTag: false,
      experimentalFeatures: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // 补发窗口就绪前产生的存储告警（如数据文件损坏回退），确保用户可见
    db.drainNotices().forEach((notice) => bus.emit('app:notice', notice));
    // 仅在显式传入 --devtools 时自动打开开发者工具，避免遮挡主窗口
    if (process.argv.includes('--devtools')) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // 阻止窗口标题被页面覆盖
  mainWindow.on('page-title-updated', (event) => event.preventDefault());

  // 外部链接一律通过系统默认浏览器打开，避免渲染进程导航到任意站点
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  // 阻止主窗口导航到本地页面之外的任何地址（纵深防御：即使被 XSS 也不能整页跳转加载远程内容）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let allowed;
    try {
      allowed = new URL(url).protocol === 'file:';
    } catch (error) {
      allowed = false;
    }
    if (!allowed) {
      event.preventDefault();
      console.warn('[main] 已拦截主窗口导航:', url);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[main] 页面加载失败:', errorCode, errorDescription);
  });

  // 渲染进程崩溃自动恢复：白屏不再需要用户手动重启；连续崩溃超上限后停止自动恢复
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    console.error('[main] 渲染进程异常退出:', details.reason, `exitCode=${details.exitCode}`);
    // 崩溃发生在稳定期判定之前：取消挂起的重置定时器，让计数继续累加
    if (renderStableTimer) {
      clearTimeout(renderStableTimer);
      renderStableTimer = null;
    }
    renderCrashCount += 1;
    if (renderCrashCount > MAX_RENDER_CRASH_RECOVERY) {
      console.error('[main] 渲染进程连续崩溃次数已达上限，停止自动恢复，已弹系统通知告知用户');
      notifyRenderCrashLimit();
      return;
    }
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    }, 1000);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    // 延迟重置计数（BUG-19）：加载成功 ≠ 恢复成功，稳定运行满 RENDER_CRASH_STABLE_MS 才算真正恢复
    if (renderStableTimer) clearTimeout(renderStableTimer);
    renderStableTimer = setTimeout(() => {
      renderStableTimer = null;
      renderCrashCount = 0;
    }, RENDER_CRASH_STABLE_MS);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 第二实例启动时，聚焦已有窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// IPC 示例：渲染进程通过 window.vivictus.ping(...) 调用
ipcMain.handle('app:ping', (_event, message) => {
  return `pong: ${String(message ?? '')}`;
});

/**
 * 系统通知（蓝图 4.6）：app:notice 经主进程 Notification 推送，受 notify 设置开关控制。
 * - 窗口聚焦时用户看得到应用内提示，不再重复打扰；最小化/失焦才发系统通知；
 * - 主进程统一发送比渲染层 Web Notification 可靠（Windows 需 AppUserModelID），
 *   且渲染进程崩溃时通知链路依然存活；点击通知聚焦窗口。
 */
function wireSystemNotifications() {
  if (!Notification?.isSupported?.()) return;
  bus.on('app:notice', (payload) => {
    if (!payload?.title) return;
    if (db.getSettings().notify === false) return;
    const win = mainWindow;
    if (win && !win.isDestroyed() && !win.isMinimized() && win.isFocused()) return;

    const notification = new Notification({ title: String(payload.title), body: String(payload.body || '') });
    notification.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    notification.show();
  });
}

app.whenReady().then(() => {
  // 第二实例：requestSingleInstanceLock 已失败且 quit 已发起，直接返回，
  // 避免在退出完成前执行 bootstrapServices 写数据目录
  if (!hasSingleInstanceLock) return;
  // Windows 通知必须设置 AppUserModelID（与 electron-builder 的 appId 保持一致）才能弹出
  app.setAppUserModelId('com.virtworker.app');
  // 致命失败（存储/装配）时已弹窗并发起退出，不再创建窗口
  if (!bootstrapServices()) return;
  wireSystemNotifications();
  createWindow();

  app.on('activate', () => {
    // macOS 上点击 Dock 图标且无窗口时重新创建窗口
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Windows/Linux：关闭所有窗口即退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 全局未捕获异常兜底已由 logger.installGlobalHandlers() 统一接管（见文件顶部）

/** 退出清理兜底：单个子系统清理抛错时记录并继续，绝不中断清理链 */
function safeTeardown(name, fn) {
  try {
    fn();
  } catch (error) {
    console.error(`[main] 退出清理：${name} 失败:`, error);
  }
}

// 退出前释放调度定时器、本地端点与运行时任务状态，落盘待写数据并关闭日志流
app.on('before-quit', () => {
  // 「重启应用」不再走 app.exit(0)（会跳过本钩子导致脏缓存不落盘）：
  // 在完整清理后登记 relaunch，退出流程继续并自动拉起新实例
  if (ipc.consumeRelaunchRequest()) {
    app.relaunch();
  }
  // 逐步独立兜底：此前单步抛错（如 runtime.shutdown 异常）会跳过后续全部清理，
  // 导致 100ms 写入窗口内的脏缓存丢失、日志流未关闭
  safeTeardown('runtime.shutdown', () => runtime.shutdown());
  safeTeardown('scheduler.stop', () => scheduler.stop());
  safeTeardown('httpServer.stop', () => httpServer.stop());
  safeTeardown('db.flush', () => db.flush()); // 脏缓存落盘
  safeTeardown('logger.close', () => logger.close()); // 日志流关闭，必须在 flush 之后
});
