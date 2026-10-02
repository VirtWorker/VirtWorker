/**
 * 主进程文件日志
 * 背景：发布后无法打开 DevTools，console 输出会丢失，问题不可诊断。
 * 方案：把 console 的关键输出镜像到 userData/logs/main.log，按大小轮转（保留 3 份），
 *       并接管未捕获异常/Promise 拒绝。info 级日志缓冲合并落盘（PERF-4），error 及以上
 *       立即直写保证关键诊断不丢。写入失败静默降级，绝不影响主流程。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024; // 单文件 2MB
const KEEP = 3; // main.log → main.log.1 → main.log.2 → main.log.3
/** 缓冲落盘间隔（毫秒）：info/debug 级日志攒一批写一次，把每行一次的同步 append 摊薄 */
const FLUSH_INTERVAL_MS = 500;
/** 缓冲字节上限：日志洪峰时提前落盘，防止内存积压无界增长 */
const FLUSH_MAX_PENDING_BYTES = 64 * 1024;

/** 日志级别：环境变量 VIRTWORKER_LOG_LEVEL 控制（debug/info/warn/error），低于阈值的不落盘 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const DEFAULT_LEVEL = 'info';
/** 敏感字段名黑名单：命中即掩码，防止未来任何服务把凭据挂进 error/日志对象造成泄漏 */
const SENSITIVE_KEY_RE = /(token|secret|password|credential|authorization|api[-_]?key)/i;
/** 字符串值内的凭据形态（SEC-2）：键名掩码之外，对最终拼接的文本再按值模式掩码——
 *  防线不依赖「开发者永远不把凭据拼进日志字符串」的脆弱约定（URL 携带 key=、
 *  Bearer 请求头、sk- 形态 API Key 都在此拦截） */
const SENSITIVE_VALUE_RES = [
  [/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***'],
  [/([?&;"'\s]|^)((?:token|key|secret|password|credential)=)([^&\s;"']{4,})/gi, '$1$2***']
];
const MASK_DEPTH = 4;

function maskSensitiveText(text) {
  return SENSITIVE_VALUE_RES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

let logFile = '';
let bytesWritten = 0;
/** 待落盘的日志行缓冲：write() 入队，定时/超限/关闭时合并为一次 appendFileSync */
let pending = [];
let pendingBytes = 0;
let flushTimer = null;

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
  // 切换目录前先把旧缓冲写进旧文件，避免上一个目标的日志混进新文件
  flushSync();
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
  const text = maskSensitiveText(
    args
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
      .join(' ')
  );
  return `[${time}] [${level}] ${text}\n`;
}

/** 把缓冲一次性落盘：轮转判定按「当前大小 + 整批字节」计算，一次 appendFileSync 完成 */
function flushSync() {
  if (!logFile || !pending.length) return;
  const chunk = pending.join('');
  pending = [];
  pendingBytes = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    if (bytesWritten + Buffer.byteLength(chunk) > MAX_BYTES) rotate();
    fs.appendFileSync(logFile, chunk, 'utf8');
    bytesWritten += Buffer.byteLength(chunk);
  } catch (error) {
    /* 日志失败不影响主流程 */
  }
}

/** 缓冲定时落盘：unref 不阻塞进程退出，退出前由 close() 兜底收口 */
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushSync();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

/**
 * 写入策略（PERF-4）：info/debug/warn 进缓冲合并落盘，error 及以上立即同步直写——
 * 关键诊断信息（崩溃、异常）不承受缓冲丢失风险。缓冲超限立即落盘防积压。
 * 低于阈值的级别不落盘。
 */
function write(level, args) {
  if (!logFile) return;
  // mirrorConsole 传大写（INFO/ERROR），installGlobalHandlers 传 FATAL，统一按小写查表
  const levelValue = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  if (levelValue < threshold()) return;
  let line;
  try {
    line = format(level, args);
  } catch (error) {
    return; /* 格式化失败不阻塞主流程 */
  }
  pending.push(line);
  pendingBytes += Buffer.byteLength(line);
  if (levelValue >= LEVELS.error || pendingBytes >= FLUSH_MAX_PENDING_BYTES) flushSync();
  else scheduleFlush();
}

function close() {
  flushSync();
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
