const { app, BrowserWindow, shell, ipcMain, Notification } = require('electron');
const path = require('node:path');
const db = require('./store/db');
const ipc = require('./ipc');
const executor = require('./runtime/executor');
const executorMock = require('./runtime/executor-mock');
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

/** 单实例锁：避免重复启动多个应用实例（Windows 桌面应用常规实践） */
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // 注意：app.quit() 是异步的，whenReady 回调仍可能执行，需用标志位短路后续初始化，
  // 防止第二实例在退出完成前短暂写同一份数据目录
  app.quit();
}

/**
 * 装配领域层：持久化 → IPC 通道 → 任务运行时 → 自动任务调度与本地触发端点。
 * 初始化失败不阻塞窗口创建，页面会以空数据降级启动。
 */
function bootstrapServices() {
  try {
    db.init(path.join(app.getPath('userData'), 'data'));
    executor.register(executorMock, { activate: true }); // 当前为模拟执行器；接入真实 LLM 时注册并 setActive 即可
    restoreExecutorPreference(); // 恢复持久化的执行器选择（O16）
    ipc.register();
    runtime.start(); // 恢复上次未完成的任务（排队重新派发、执行中继续）
    scheduler.start(); // 启动补跑错过的定时任务并排程
    webhookNotifier.start(); // 任务终态 Webhook 出站通知（F2）
    chatService.startNotifier(); // 聊天出站回执（F3）
    httpServer.start(); // API 触发的本地端点（仅回环地址）
    startDailyMaintenance(); // 每日维护：过期任务清理（启动即跑一次）+ 数据快照
  } catch (error) {
    console.error('[main] 领域服务初始化失败:', error);
  }
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

/**
 * 每日维护（O7）：启动即执行一次，此后每 24 小时一次。
 * - 过期任务清理：保留策略此前只在启动时执行，长期运行的自动化场景下过期任务会持续堆积
 * - 数据快照：.bak 只能回退一代写入损坏，快照防的是误删与逻辑损坏随时间扩散（保留最近 7 份，见 db.js）
 */
function startDailyMaintenance() {
  const run = () => {
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
  run();
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
    renderCrashCount += 1;
    if (renderCrashCount > MAX_RENDER_CRASH_RECOVERY) {
      console.error('[main] 渲染进程连续崩溃次数已达上限，停止自动恢复，请重启应用');
      return;
    }
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    }, 1000);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    renderCrashCount = 0; // 正常加载成功即重置计数
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
  bootstrapServices();
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
