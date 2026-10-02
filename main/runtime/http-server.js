/**
 * 本地触发端点（API 触发 + IM 入站推送）
 * 仅绑定回环地址 127.0.0.1，按自动化/聊天连接持有的专属凭据鉴权（长期有效，支持手动轮换）；
 * 用于脚本、其他工具或外部 IM 桥接触发，不对外网暴露。
 *
 * GET  /health                      → 存活探针（免鉴权）
 * POST /automations/:id/run         → 触发指定 API 型自动任务（需 Token）
 *   请求头：X-VirtWorker-Token: <token>  或  Authorization: Bearer <token>
 *   请求体（可选）：{ "goal": "覆盖目标", "payload": { ... } }
 * POST /chat/:connectionId/inbound  → 外部 IM 桥接推送消息 → @Worker 建任务（E1）
 *   请求头：X-VirtWorker-Token: <连接凭据>
 *   请求体：{ "chatId": "房间ID", "chatName": "房间名", "chatType": "group|direct",
 *             "sender": "发送者", "text": "消息内容" }
 *   消息统一汇入 chat-service.ingest()（绑定分流/审批/节流与 @Worker 页面完全一致）
 */

const http = require('node:http');
const { timingSafeEqual, createHash } = require('node:crypto');
const db = require('../store/db');
const automationService = require('../services/automation-service');
const chatService = require('../services/chat-service');
const scheduler = require('./scheduler');

const DEFAULT_PORT = 17891;
/** 重启后对端连接池的感知宽限（毫秒）：见 restart() 内注释 */
const RESTART_GRACE_MS = 30;
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

/** 定长比较（SEC-3）：双侧 SHA-256 归一为 32 字节再比较——长度不等提前返回会泄露
 *  Token 长度的时序信号，归一后响应时间与输入长度/内容无关 */
function tokenMatches(expected, provided) {
  if (!expected || !provided) return false;
  const a = createHash('sha256').update(String(expected)).digest();
  const b = createHash('sha256').update(String(provided)).digest();
  return timingSafeEqual(a, b);
}

/**
 * Token 认证失败限速：时序防护挡不住无时间差的暴力枚举，回环上的任意本地进程
 * 可高频尝试。连续失败达阈值后进入冷却窗口（期间一律 429）。
 * 分桶（SEC-4）：按目标（自动化/连接 id）计数——全局单桶会让任一目标的爆破冷却全部端点，
 * 合法脚本被误伤且无法定位爆破源；伪造 id 的桶数有上限（超限只记全局桶），
 * 全局总量超限仍全局冷却，防「散开打」绕过单桶限制。
 */
const AUTH_FAIL_LIMIT = 10;
const AUTH_COOLDOWN_MS = 30 * 1000;
const AUTH_GLOBAL_FAIL_LIMIT = AUTH_FAIL_LIMIT * 5;
const AUTH_BUCKETS_MAX = 100;
const authFailBuckets = new Map(); // targetId → { count, blockedUntil }
let globalFailCount = 0;
let globalBlockedUntil = 0;

function authRateLimited(targetId) {
  const now = Date.now();
  if (now < globalBlockedUntil) return true;
  const bucket = targetId ? authFailBuckets.get(targetId) : null;
  return Boolean(bucket && now < bucket.blockedUntil);
}

function recordAuthFailure(targetId) {
  if (targetId) {
    let bucket = authFailBuckets.get(targetId);
    if (!bucket && authFailBuckets.size < AUTH_BUCKETS_MAX) {
      bucket = { count: 0, blockedUntil: 0 };
      authFailBuckets.set(targetId, bucket);
    }
    if (bucket) {
      bucket.count += 1;
      if (bucket.count >= AUTH_FAIL_LIMIT) {
        bucket.blockedUntil = Date.now() + AUTH_COOLDOWN_MS;
        bucket.count = 0;
        console.warn(`[api] 目标 ${targetId} 连续认证失败达上限，进入 30 秒冷却`);
      }
    }
  }
  globalFailCount += 1;
  if (globalFailCount >= AUTH_GLOBAL_FAIL_LIMIT) {
    globalBlockedUntil = Date.now() + AUTH_COOLDOWN_MS;
    globalFailCount = 0;
    console.warn('[api] 认证失败总量达到上限，全部端点进入 30 秒冷却');
  }
}

function recordAuthSuccess(targetId) {
  if (targetId) authFailBuckets.delete(targetId);
  globalFailCount = 0;
  globalBlockedUntil = 0;
}

/** 端点（重）启动时复位全部认证限速状态 */
function resetAuthState() {
  authFailBuckets.clear();
  globalFailCount = 0;
  globalBlockedUntil = 0;
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
    if (authRateLimited(match[1])) {
      return failRequest(res, 429, 'TOO_MANY_REQUESTS', '认证失败次数过多，请稍后重试');
    }

    let automation = null;
    try {
      automation = automationService.findById(match[1]); // findById 免全集合克隆（B1）
    } catch (error) {
      console.error('[api] 读取自动任务失败:', error);
    }
    // BUG-22 鉴权前置：ID 不存在 / Token 错误 / 缺 Token / 非 API 类型，一律同形 401——
    // 若先查资源后鉴权，404（存在性）与 400（类型/启用状态）的差异会成为无凭证探测探测器
    if (!automation || !tokenMatches(automationService.revealApiToken(automation), readToken(req))) {
      recordAuthFailure(match[1]);
      return failRequest(res, 401, 'UNAUTHORIZED', 'Token 无效');
    }
    recordAuthSuccess(match[1]);
    if (automation.trigger.type !== 'api') {
      return failRequest(res, 400, 'INVALID_STATE', '该自动任务不是 API 触发类型');
    }
    if (!automation.enabled) return failRequest(res, 400, 'INVALID_STATE', '该自动任务已停用');

    let body;
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
      // 触发限速：最小触发间隔内重复调用按 429 拒绝（脚本可据此退避），与认证冷却同码
      if (error?.code === 'RATE_LIMITED') {
        return failRequest(res, 429, 'TOO_MANY_REQUESTS', error.message);
      }
      console.error('[api] 触发自动任务失败:', error);
      return failRequest(res, 400, error.code || 'INTERNAL', error.message || '触发失败');
    }
  }

  // IM 入站推送（E1）：外部 IM 桥接/机器人 → @Worker 任务。鉴权与自动化同款：
  // 连接不存在 / 凭据缺失或错误一律同形 401（不暴露 connectionId 存在性）
  const chatMatch = pathname.match(/^\/chat\/([A-Za-z0-9_]+)\/inbound$/);
  if (chatMatch) {
    if (req.method !== 'POST') return failRequest(res, 405, 'METHOD_NOT_ALLOWED', '请使用 POST');
    if (authRateLimited(chatMatch[1])) {
      return failRequest(res, 429, 'TOO_MANY_REQUESTS', '认证失败次数过多，请稍后重试');
    }

    const connection = chatService.findConnectionById(chatMatch[1]);
    const expected = chatService.revealCredential(connection);
    if (!connection || !tokenMatches(expected, readToken(req))) {
      recordAuthFailure(chatMatch[1]);
      return failRequest(res, 401, 'UNAUTHORIZED', 'Token 无效');
    }
    recordAuthSuccess(chatMatch[1]);

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return failRequest(res, 400, 'VALIDATION_FAILED', error.message);
    }

    try {
      const result = chatService.ingest({
        connectionId: connection.id,
        chatId: typeof body.chatId === 'string' ? body.chatId.trim() : '',
        chatName: typeof body.chatName === 'string' ? body.chatName.trim().slice(0, 100) : '',
        chatType: body.chatType,
        sender: typeof body.sender === 'string' ? body.sender : '',
        text: typeof body.text === 'string' ? body.text : ''
      });
      return ok(res, result);
    } catch (error) {
      console.error('[api] IM 入站消息处理失败:', error.message || error);
      return failRequest(res, 400, error.code || 'INTERNAL', error.message || '入站消息处理失败');
    }
  }

  return failRequest(res, 404, 'NOT_FOUND', '接口不存在');
}

/**
 * 启动本地触发端点。可选 onSettled(status)：监听成功或 error 事件状态收敛时一次性回调，
 * 供 restart() 事件驱动等待（此前 20ms 轮询 + 1.5s 兜底双路径已被其取代，PERF-6）。
 */
function start(onSettled) {
  if (server) {
    // 已在运行：对 restart 语义而言即刻收敛，直接回传当前状态
    const current = getStatus();
    onSettled?.(current);
    return current;
  }
  const port = Number(db.getSettings().apiPort) || DEFAULT_PORT;
  resetAuthState(); // 端点（重）启动时复位认证限速状态
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    onSettled?.(getStatus());
  };

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
    settle();
  });

  server.listen(port, '127.0.0.1', () => {
    status = { running: true, port, error: null };
    console.log(`[api] 本地触发端点已就绪: http://127.0.0.1:${port}`);
    settle();
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
 * Promise 在新端口监听成功或失败（状态收敛）后 resolve——start(onSettled) 由 listen/error 事件
 * 直接驱动收敛，不再轮询状态；调用方可据此判断重启结果。
 */
function restart() {
  return new Promise((resolve) => {
    let begun = false;
    const begin = () => {
      if (begun) return;
      begun = true;
      start((finalStatus) => {
        // 对端感知宽限（PERF-6）：服务端状态虽已收敛，但旧 keep-alive 连接的销毁通知
        // 需到达调用方连接池后，新请求才不会命中已被销毁的复用 socket（ECONNRESET）。
        // 旧实现的 20ms 轮询间隔意外提供了该缓冲，事件驱动后必须显式保留。
        setTimeout(() => resolve(finalStatus), RESTART_GRACE_MS).unref?.();
      });
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