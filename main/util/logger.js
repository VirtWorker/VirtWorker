/**
 * 主进程文件日志
 * 背景：发布后无法打开 DevTools，console 输出会丢失，问题不可诊断。
 * 方案：把 console 的关键输出镜像到 userData/logs/main.log，按大小轮转（保留 3 份），
 *       并接管未捕获异常/Promise 拒绝。写入失败静默降级，绝不影响主流程。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024; // 单文件 2MB
const KEEP = 3; // main.log → main.log.1 → main.log.2 → main.log.3

/** 日志级别：环境变量 VIRTWORKER_LOG_LEVEL 控制（debug/info/warn/error），低于阈值的不落盘 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const DEFAULT_LEVEL = 'info';
/** 敏感字段名黑名单：命中即掩码，防止未来任何服务把凭据挂进 error/日志对象造成泄漏 */
const SENSITIVE_KEY_RE = /(token|secret|password|credential|authorization|api[-_]?key)/i;
const MASK_DEPTH = 4;

let logFile = '';
let bytesWritten = 0;

function threshold() {
  const raw = String(process.env.VIRTWORKER_LOG_LEVEL || DEFAULT_LEVEL).toLowerCase();
  return LEVELS[raw] ?? LEVELS[DEFAULT_LEVEL];
}

/** 深拷贝并掩码敏感字段（限深限量，避免超大对象拖慢日志写入） */
function maskSensitive(value, depth = 0) {
  if (value instanceof Error) return value;
  if (depth > MASK_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => maskSensitive(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '***' : maskSensitive(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** 由 main.js 在 app ready 后调用，指定日志目录 */
function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'main.log');
    bytesWritten = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  } catch (error) {
    logFile = '';
    console.error('[logger] 初始化失败，仅保留控制台日志:', error.message);
  }
}

function rotate() {
  try {
    for (let index = KEEP - 1; index >= 1; index -= 1) {
      const from = `${logFile}.${index}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${logFile}.${index + 1}`);
    }
    if (fs.existsSync(logFile)) fs.renameSync(logFile, `${logFile}.1`);
    bytesWritten = 0;
  } catch (error) {
    console.error('[logger] 轮转失败:', error.message);
  }
}

function format(level, args) {
  const time = new Date().toISOString();
  const text = args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(maskSensitive(arg));
        } catch (error) {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(' ');
  return `[${time}] [${level}] ${text}\n`;
}

/** 同步追加写：日志量小、可靠性优先，避免异步流与进程退出的竞态；低于阈值的级别不落盘 */
function write(level, args) {
  if (!logFile) return;
  // mirrorConsole 传大写（INFO/ERROR），installGlobalHandlers 传 FATAL，统一按小写查表
  const levelValue = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  if (levelValue < threshold()) return;
  try {
    const line = format(level, args);
    if (bytesWritten + Buffer.byteLength(line) > MAX_BYTES) rotate();
    fs.appendFileSync(logFile, line, 'utf8');
    bytesWritten += Buffer.byteLength(line);
  } catch (error) {
    /* 日志失败不影响主流程 */
  }
}

function close() {
  /* 同步写入无缓冲，保留接口供退出流程调用 */
}

/**
 * 镜像 console 输出到日志文件：既有代码的 console.log/warn/error 自动落盘，
 * 无需逐处改造；原始输出仍会显示在终端（开发时可见）。debug 仅在调低阈值时落盘。
 */
function mirrorConsole() {
  const methods = { debug: 'DEBUG', log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' };
  Object.entries(methods).forEach(([method, level]) => {
    const original = console[method]?.bind(console);
    if (!original) return;
    console[method] = (...args) => {
      original(...args);
      write(level, args);
    };
  });
}

/** 接管全局异常：先落盘再走原有兜底逻辑 */
function installGlobalHandlers() {
  process.on('uncaughtException', (error) => {
    write('FATAL', ['未捕获异常:', error]);
    close();
    console.error('[main] 未捕获异常:', error);
    // 主进程已处于未定义状态（O18）：尽力告知用户后受控退出，
    // 避免带病运行导致脏缓存/半写状态。dialog/app 惰性 require——单元测试环境无 electron。
    try {
      const { dialog, app } = require('electron');
      dialog.showErrorBox(
        'VirtWorker 遇到内部错误',
        `应用即将退出以保护数据完整性：${error.message || '未知错误'}
完整信息见日志文件（%APPDATA%/VirtWorker/logs/）。`
      );
      app.quit(); // 走 before-quit 完整清理（落盘/停服务）而非 app.exit 硬退
    } catch (notifyError) {
      // 非 Electron 环境（单元测试 / 脚本）：保持仅记录，不退出测试进程
    }
  });
  process.on('unhandledRejection', (reason) => {
    write('FATAL', ['未处理的 Promise 拒绝:', reason instanceof Error ? reason : String(reason)]);
    console.error('[main] 未处理的 Promise 拒绝:', reason);
  });
}

module.exports = { init, close, mirrorConsole, installGlobalHandlers };
