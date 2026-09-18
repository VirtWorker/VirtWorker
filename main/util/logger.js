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

let logFile = '';
let bytesWritten = 0;

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
          return JSON.stringify(arg);
        } catch (error) {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(' ');
  return `[${time}] [${level}] ${text}\n`;
}

/** 同步追加写：日志量小、可靠性优先，避免异步流与进程退出的竞态 */
function write(level, args) {
  if (!logFile) return;
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
 * 无需逐处改造；原始输出仍会显示在终端（开发时可见）。
 */
function mirrorConsole() {
  const methods = ['log', 'info', 'warn', 'error'];
  methods.forEach((method) => {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      write(method.toUpperCase(), args);
    };
  });
}

/** 接管全局异常：先落盘再走原有兜底逻辑 */
function installGlobalHandlers() {
  process.on('uncaughtException', (error) => {
    write('FATAL', ['未捕获异常:', error]);
    close();
    console.error('[main] 未捕获异常:', error);
  });
  process.on('unhandledRejection', (reason) => {
    write('FATAL', ['未处理的 Promise 拒绝:', reason instanceof Error ? reason : String(reason)]);
    console.error('[main] 未处理的 Promise 拒绝:', reason);
  });
}

module.exports = { init, close, mirrorConsole, installGlobalHandlers };
