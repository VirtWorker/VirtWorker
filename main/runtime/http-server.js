/**
 * 本地触发端点（API 触发）
 * 仅绑定回环地址 127.0.0.1，按自动任务持有的一次性 Token 鉴权；
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

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/health' && req.method === 'GET') {
    return ok(res, { name: 'VirtWorker', time: new Date().toISOString() });
  }

  const match = pathname.match(/^\/automations\/([A-Za-z0-9_]+)\/run$/);
  if (match) {
    if (req.method !== 'POST') return failRequest(res, 405, 'METHOD_NOT_ALLOWED', '请使用 POST');

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
    if (!tokenMatches(automation.trigger.api?.token, readToken(req))) {
      return failRequest(res, 401, 'UNAUTHORIZED', 'Token 无效');
    }

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

  server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('[api] 请求处理异常:', error);
      if (!res.headersSent) failRequest(res, 500, 'INTERNAL', '服务内部错误');
    });
  });

  server.on('error', (error) => {
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
  if (server) server.close();
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