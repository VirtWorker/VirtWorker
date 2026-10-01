/**
 * 本地触发端点（API 触发）
 * 仅绑定回环地址 127.0.0.1，按自动任务持有的专属 Token 鉴权（长期有效，支持手动轮换）；
 * 用于脚本、其他工具或后续 IM 回调触发自动任务，不对外网暴露。
 *
 * GET  /health                      → 存活探针（免鉴权）
 * POST /automations/:id/run         → 触发指定 API 型自动任务（需 Token）
 *   请求头：X-VirtWorker-Token: <token>  或  Authorization: Bearer <token>
 *   请求体（可选）：{ "goal": "覆盖目标", "payload": { ... } }
 */

const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const db = require('../store/db');
const automationService = require('../services/automation-service');
const scheduler = require('./scheduler');

const DEFAULT_PORT = 17891;
const MAX_BODY_BYTES = 64 * 1024;

let server = null;
let status = { running: false, port: null, error: null };

function getStatus() {
  return { ...status };
}

function send(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function ok(res, data) {
  send(res, 200, { ok: true, data, apiVersion: 1 });
}

function failRequest(res, statusCode, code, message) {
  send(res, statusCode, { ok: false, error: { code, message }, apiVersion: 1 });
}

/** 定长比较，避免通过响应时间推断 Token */
function tokenMatches(expected, provided) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Token 认证失败限速：时序防护挡不住无时间差的暴力枚举，回环上的任意本地进程
 * 可高频尝试。连续失败达阈值后进入冷却窗口（期间一律 429），成功认证或 start() 重启时复位。
 */
const AUTH_FAIL_LIMIT = 10;
const AUTH_COOLDOWN_MS = 30 * 1000;
let authFailCount = 0;
let authBlockedUntil = 0;

function authRateLimited() {
  return Date.now() < authBlockedUntil;
}

function recordAuthFailure() {
  authFailCount += 1;
  if (authFailCount >= AUTH_FAIL_LIMIT) {
    authBlockedUntil = Date.now() + AUTH_COOLDOWN_MS;
    authFailCount = 0;
    console.warn('[api] Token 连续认证失败达到上限，进入 30 秒冷却');
  }
}

function recordAuthSuccess() {
  authFailCount = 0;
  authBlockedUntil = 0;
}

function readToken(req) {
  const header = req.headers['x-virtworker-token'];
  if (header) return String(header).trim();
  const auth = String(req.headers.authorization || '');
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (error) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Host 头校验：本服务只面向本机回环。若攻击者的网页把自有域名解析到 127.0.0.1（DNS rebinding），
 * 浏览器发出的请求虽来自本机，Host 仍是攻击域名。只放行回环主机名可从源头阻断该类跨站请求。
 */
function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (value.startsWith('[')) return value === '[::1]' || /^\[::1\]:\d+$/.test(value); // IPv6 字面量（可带端口）
  const hostname = value.replace(/:\d+$/, '');
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

async function handle(req, res) {
  if (!isLoopbackHost(req.headers.host)) {
    return failRequest(res, 403, 'FORBIDDEN', '拒绝非本地来源的请求');
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/health' && req.method === 'GET') {
    return ok(res, { name: 'VirtWorker', time: new Date().toISOString() });
  }

  const match = pathname.match(/^\/automations\/([A-Za-z0-9_]+)\/run$/);
  if (match) {
    if (req.method !== 'POST') return failRequest(res, 405, 'METHOD_NOT_ALLOWED', '请使用 POST');
    // 冷却期直接拒绝：连自动化 ID 的枚举探测也一并挡下
    if (authRateLimited()) {
      return failRequest(res, 429, 'TOO_MANY_REQUESTS', '认证失败次数过多，请稍后重试');
    }

    let automation = null;
    try {
      automation = automationService.listAll().find((item) => item.id === match[1]) || null;
    } catch (error) {
      console.error('[api] 读取自动任务失败:', error);
    }
    if (!automation) return failRequest(res, 404, 'NOT_FOUND', '自动任务不存在');
    if (automation.trigger.type !== 'api') {
      return failRequest(res, 400, 'INVALID_STATE', '该自动任务不是 API 触发类型');
    }
    if (!automation.enabled) return failRequest(res, 400, 'INVALID_STATE', '该自动任务已停用');
    // Token 在服务层解密（保险箱密文或旧版明文），定长比较防时序侧信道
    if (!tokenMatches(automationService.revealApiToken(automation), readToken(req))) {
      recordAuthFailure();
      return failRequest(res, 401, 'UNAUTHORIZED', 'Token 无效');
    }
    recordAuthSuccess();

    let body = {};
    try {
      body = await readBody(req);
    } catch (error) {
      return failRequest(res, 400, 'VALIDATION_FAILED', error.message);
    }

    try {
      const task = scheduler.fire(automation, 'API 触发', {
        goal: typeof body.goal === 'string' ? body.goal.trim() : '',
        payload: body.payload
      });
      return ok(res, { taskId: task.id, automationId: automation.id, goal: task.goal });
    } catch (error) {
      console.error('[api] 触发自动任务失败:', error);
      return failRequest(res, 400, error.code || 'INTERNAL', error.message || '触发失败');
    }
  }

  return failRequest(res, 404, 'NOT_FOUND', '接口不存在');
}

function start() {
  if (server) return getStatus();
  const port = Number(db.getSettings().apiPort) || DEFAULT_PORT;
  recordAuthSuccess(); // 端点（重）启动时复位认证限速状态

  server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('[api] 请求处理异常:', error);
      if (!res.headersSent) failRequest(res, 500, 'INTERNAL', '服务内部错误');
    });
  });

  // 收紧请求超时：本端点只服务本机脚本调用，慢速/挂起的连接不应长期占用
  server.requestTimeout = 30 * 1000;
  server.headersTimeout = 10 * 1000;

  server.on('error', (error) => {
    // 句柄置空：启动失败（如端口占用）后 start() 才能被再次调用，否则永久 no-op 无法自愈
    server = null;
    status = {
      running: false,
      port,
      error: error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : error.message
    };
    console.error('[api] 本地触发端点启动失败:', status.error);
  });

  server.listen(port, '127.0.0.1', () => {
    status = { running: true, port, error: null };
    console.log(`[api] 本地触发端点已就绪: http://127.0.0.1:${port}`);
  });

  return getStatus();
}

function stop() {
  if (server) {
    server.close();
    // 立即断开 keep-alive 等残留连接，避免 close 回调被慢客户端拖延（阻塞重启与退出）
    server.closeAllConnections?.();
  }
  server = null;
  status = { running: false, port: null, error: null };
}

/**
 * 端口变更后重启（settings 修改 apiPort 时调用）：等旧监听真正关闭后再按新端口启动，避免 EADDRINUSE。
 * Promise 在新端口监听成功或失败（状态收敛）后 resolve，调用方可据此判断重启结果；
 * start() 同步返回时 listen/error 回调尚未触发，直接读取状态会误判。
 */
function restart() {
  return new Promise((resolve) => {
    let started = false;
    const begin = () => {
      if (started) return;
      started = true;
      status = { running: false, port: null, error: null }; // 清零，避免轮询读到旧状态误判已收敛
      start();
      // 成功时 listen 回调置 running，失败时 error 事件置 port/error，轮询等待二者之一
      const deadline = Date.now() + 1500;
      const poll = () => {
        if (status.running || status.port !== null || Date.now() > deadline) return resolve(getStatus());
        setTimeout(poll, 20);
      };
      poll();
    };
    if (!server) return begin();
    const closing = server;
    server = null;
    status = { running: false, port: null, error: null };
    closing.close(begin);
    // 兜底：无活动连接时 close 回调可能延迟，1s 后强制启动
    setTimeout(() => {
      if (!server) begin();
    }, 1000).unref?.();
  });
}

module.exports = { start, stop, restart, getStatus, DEFAULT_PORT };