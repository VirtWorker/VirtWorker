/**
 * 目录访问授权（一次性 ticket）
 * 背景：知识库导入会扫描本地目录内容，若渲染层直接传入任意路径，
 *       被攻破的界面即可读取用户磁盘上的任意文本目录。
 * 方案：目录路径只能来自 showOpenDialog 的返回结果，签发一次性 ticket；
 *       创建知识库时必须携带匹配的 ticket，授权即消费，防止重放。
 */

const { randomBytes, timingSafeEqual, createHash } = require('node:crypto');

const TTL_MS = 5 * 60 * 1000; // 签发后 5 分钟内有效
const MAX_GRANTS = 20; // 只保留最近的授权，防内存膨胀

/** ticket → { dir, expiresAt } */
const grants = new Map();

function prune() {
  const now = Date.now();
  for (const [ticket, grant] of grants) {
    if (grant.expiresAt < now) grants.delete(ticket);
  }
  while (grants.size > MAX_GRANTS) grants.delete(grants.keys().next().value);
}

/** 对话框选定目录后签发授权 */
function grant(dir) {
  prune();
  const ticket = randomBytes(16).toString('hex');
  grants.set(ticket, { dir, expiresAt: Date.now() + TTL_MS });
  return ticket;
}

/** 校验并消费授权：ticket 有效且目录一致才通过（定长比较防时序侧信道） */
function consume(ticket, dir) {
  prune();
  if (!ticket || typeof ticket !== 'string') return false;
  const record = grants.get(ticket);
  if (!record) return false;
  grants.delete(ticket); // 无论成败都消费，防重放
  // 定长比较（SEC-3）：双侧 SHA-256 归一为 32 字节再比较——长度不等提前返回
  // 会泄露路径长度的时序信号，归一后响应时间与输入无关
  const a = createHash('sha256').update(String(record.dir)).digest();
  const b = createHash('sha256').update(String(dir ?? '')).digest();
  return timingSafeEqual(a, b);
}

module.exports = { grant, consume };
