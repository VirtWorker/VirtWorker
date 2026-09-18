const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('node:path');
const db = require('./store/db');
const ipc = require('./ipc');
const executor = require('./runtime/executor');
const executorMock = require('./runtime/executor-mock');
const runtime = require('./runtime/task-runtime');
const scheduler = require('./runtime/scheduler');
const httpServer = require('./runtime/http-server');
const taskService = require('./services/task-service');

/**
 * 主进程入口：负责窗口创建、应用生命周期管理、领域服务装配与全局安全设置。
 */

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** 单实例锁：避免重复启动多个应用实例（Windows 桌面应用常规实践） */
if (!app.requestSingleInstanceLock()) {
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
    ipc.register();
    runtime.start(); // 恢复上次未完成的任务（排队重新派发、执行中继续）
    scheduler.start(); // 启动补跑错过的定时任务并排程
    httpServer.start(); // API 触发的本地端点（仅回环地址）
    purgeExpiredTasks(); // 按保留策略清理历史任务
  } catch (error) {
    console.error('[main] 领域服务初始化失败:', error);
  }
}

/** 保留策略：清理已结束且已查收、且超出保留期的任务，避免数据无限增长 */
function purgeExpiredTasks() {
  const { removed, retention } = taskService.purgeExpired(db.getSettings().taskRetentionDays);
  if (removed) console.log(`[main] 已按保留策略（${retention} 天）清理 ${removed} 条历史任务`);
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
    // 仅在显式传入 --devtools 时自动打开开发者工具，避免遮挡主窗口
    if (process.argv.includes('--devtools')) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // 阻止窗口标题被页面覆盖
  mainWindow.on('page-title-updated', (event) => event.preventDefault());

  // 外部链接一律通过系统默认浏览器打开，避免渲染进程导航到任意站点
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[main] 页面加载失败:', errorCode, errorDescription);
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

app.whenReady().then(() => {
  bootstrapServices();
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

// 全局未捕获异常兜底，避免静默崩溃
process.on('uncaughtException', (error) => {
  console.error('[main] 未捕获异常:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] 未处理的 Promise 拒绝:', reason);
});

// 退出前释放调度定时器、本地端点与运行时任务状态
app.on('before-quit', () => {
  runtime.shutdown();
  scheduler.stop();
  httpServer.stop();
});
