/**
 * JSON 集合存储（仅主进程使用）
 * - 内存缓存 + 原子写（*.tmp → fsync → rename），写入前轮换保留两代备份（*.bak / *.bak2）
 * - 读取失败或版本过高时回退备份，全部失败则以空集合启动，不阻塞应用但会发出告警
 * - 写入节流：变更先落缓存，100ms 内的多次写合并为一次磁盘写入；
 *   写盘失败自动定时重试并通知（setNotify），进程退出前必须 flush()（缓存始终是读取的唯一来源）
 * - 对外只暴露集合级接口，不体现实现细节，便于后续替换为 SQLite
 */

const fs = require('node:fs');
const path = require('node:path');
const schema = require('./schema');
const { fail } = require('../util/errors');

const COLLECTIONS = [
  'workers',
  'groups',
  'tasks',
  /** 任务时间线（v2 起从 tasks 内嵌字段拆出，见 schema.js 迁移说明） */
  'taskevents',
  'automations',
  'capabilities',
  'chunks',
  'flows',
  'shares',
  'chatconnections',
  'chatrequests',
  'chatbindings'
];

/** 合并写入窗口（毫秒）：任务执行高频更新时显著减少全量重写次数 */
const WRITE_COALESCE_MS = 100;
/** 写盘失败后的自动重试间隔 */
const FLUSH_RETRY_MS = 5 * 1000;
/** 持续失败时用户告警的限频间隔（避免通知刷屏） */
const FLUSH_NOTIFY_INTERVAL_MS = 5 * 60 * 1000;
/** notify 注册前产生的告警缓存上限 */
const MAX_PENDING_NOTICES = 20;

let baseDir = '';
const cache = new Map();
let settings = {};
/** 待落盘的集合：name → items 快照 */
const dirty = new Map();
let flushTimer = null;
let flushRetryTimer = null;
let lastFlushNotifyAt = 0;
/** 存储异常对外通知回调（main.js 注入，经事件总线转发渲染层）；注册前的告警先入队 */
let notifyFn = null;
const pendingNotices = [];

function setNotify(fn) {
  notifyFn = typeof fn === 'function' ? fn : null;
}

/** 取走并清空缓存的告警（窗口就绪后由 main.js 补发，确保启动阶段的问题用户可见） */
function drainNotices() {
  return pendingNotices.splice(0, pendingNotices.length);
}

function notifyStorageIssue(message) {
  const notice = { level: 'error', title: '数据存储异常', message };
  if (notifyFn) {
    try {
      notifyFn(notice);
    } catch (error) {
      // 通知失败不影响存储主流程
    }
  }
  if (pendingNotices.length < MAX_PENDING_NOTICES) pendingNotices.push(notice);
}

function fileOf(name) {
  return path.join(baseDir, `${name}.json`);
}

/** 读取并按 schema 校验；失败返回 null 以便调用方回退下一来源 */
function tryRead(file) {
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return payload;
  } catch (error) {
    console.error(`[store] 读取 ${path.basename(file)} 失败:`, error.message);
    return null;
  }
}

function loadItems(name) {
  const file = fileOf(name);
  let sawFile = false;
  for (const candidate of [file, `${file}.bak`, `${file}.bak2`]) {
    if (!fs.existsSync(candidate)) continue;
    sawFile = true;
    const payload = tryRead(candidate);
    if (!payload) continue;
    // v1 → v2 跨集合迁移：tasks 的内嵌 events 必须在 schema 剥离前提取（否则时间线丢失）
    let legacyEvents = null;
    if (name === 'tasks' && Number(payload.schemaVersion) < 2 && Array.isArray(payload.items)) {
      legacyEvents = payload.items.flatMap((task) =>
        Array.isArray(task?.events) ? task.events.map((event) => ({ ...event })) : []
      );
    }
    const result = schema.readCollection(payload, name);
    if (result.ok) return { items: result.items, legacyEvents };
    console.error(`[store] ${path.basename(candidate)} 不可用:`, result.reason);
  }
  // 文件存在但全部不可读：以空集合启动不阻塞应用，但必须让用户知情（静默丢数据不可接受）
  if (sawFile) notifyStorageIssue(`${name}.json 及其备份均无法读取，已以空数据启动`);
  return { items: [], legacyEvents: null };
}

function loadSettings() {
  const file = fileOf('settings');
  let sawFile = false;
  for (const candidate of [file, `${file}.bak`, `${file}.bak2`]) {
    if (!fs.existsSync(candidate)) continue;
    sawFile = true;
    const payload = tryRead(candidate);
    if (!payload) continue;
    const result = schema.readSettings(payload);
    if (result.ok) return result.items;
    console.error(`[store] ${path.basename(candidate)} 不可用:`, result.reason);
  }
  if (sawFile) notifyStorageIssue('settings.json 及其备份均无法读取，已恢复默认设置');
  return {};
}

/** 真正落盘单个集合：临时文件 → fsync → 备份轮换（保留两代）→ rename 原子替换 */
function writeCollection(name, items) {
  const file = fileOf(name);
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify(
    { schemaVersion: schema.SCHEMA_VERSION, updatedAt: new Date().toISOString(), items },
    null,
    2
  );
  fs.writeFileSync(tmp, payload, 'utf8');
  // 断电防护：rename 前把 tmp 刷入磁盘，避免"目录项已替换、数据仍在页缓存"产生的空洞文件
  const fd = fs.openSync(tmp, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // 备份轮换：.bak 为上一代、.bak2 为上上代，避免唯一备份恰在覆盖瞬间损坏后无档可回
  const bak = `${file}.bak`;
  const bak2 = `${file}.bak2`;
  if (fs.existsSync(bak)) fs.copyFileSync(bak, bak2);
  if (fs.existsSync(file)) fs.copyFileSync(file, bak);
  fs.renameSync(tmp, file);
}

/**
 * 标记集合为脏并调度合并写入：同一窗口内的多次变更只写一次磁盘。
 * 缓存已同步更新，读取路径不受写入时机影响；进程退出前调用 flush() 落盘。
 */
function persist(name, items) {
  dirty.set(name, items);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, WRITE_COALESCE_MS);
  // 不阻塞事件循环/进程退出
  flushTimer.unref?.();
}

/**
 * 立即把所有脏集合落盘；失败的集合保留在 dirty 中并自动定时重试。
 * 进程退出前必须调用（before-quit）；持续失败时按限频节奏通知用户。
 */
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushRetryTimer) {
    clearTimeout(flushRetryTimer);
    flushRetryTimer = null;
  }
  let firstError = null;
  for (const [name, items] of [...dirty.entries()]) {
    try {
      writeCollection(name, items);
      dirty.delete(name);
    } catch (error) {
      if (!firstError) firstError = error;
      console.error(`[store] 写入 ${name}.json 失败：${error.message}`);
    }
  }
  if (firstError) {
    // 失败集合自动重试：不依赖下一次写操作或退出时机，避免数据长期滞留内存
    if (!flushRetryTimer) {
      flushRetryTimer = setTimeout(() => {
        flushRetryTimer = null;
        flush();
      }, FLUSH_RETRY_MS);
      flushRetryTimer.unref?.();
    }
    const now = Date.now();
    if (now - lastFlushNotifyAt > FLUSH_NOTIFY_INTERVAL_MS) {
      lastFlushNotifyAt = now;
      notifyStorageIssue(`数据写入磁盘失败（${firstError.message || '未知原因'}），应用将持续自动重试，请检查磁盘空间与权限`);
    }
  } else {
    lastFlushNotifyAt = 0;
  }
}

function init(dir) {
  baseDir = dir;
  fs.mkdirSync(baseDir, { recursive: true });
  let legacyEvents = null;
  COLLECTIONS.forEach((name) => {
    const loaded = loadItems(name);
    if (name === 'tasks' && Array.isArray(loaded.legacyEvents)) {
      // v1 文件：无论是否有时间线都要把剥离后的 tasks 落盘为 v2 结构
      legacyEvents = loaded.legacyEvents;
      persist('tasks', loaded.items);
    }
    cache.set(name, loaded.items);
  });
  if (legacyEvents) {
    // v1 → v2 迁移：提取出的时间线并入 taskevents（按 id 去重保证幂等；追加序即时间序）
    const existing = cache.get('taskevents') || [];
    const knownIds = new Set(existing.map((event) => event.id));
    const additions = legacyEvents.filter((event) => !knownIds.has(event.id));
    if (additions.length) {
      const merged = [...existing, ...additions];
      cache.set('taskevents', merged);
      persist('taskevents', merged);
    }
  }
  settings = loadSettings();
}

/** 集合读取统一返回深拷贝，避免调用方误改内存缓存 */
function clone(value) {
  return structuredClone(value);
}

function all(name) {
  return clone(cache.get(name) || []);
}

function find(name, id) {
  const found = (cache.get(name) || []).find((item) => item.id === id);
  return found ? clone(found) : null;
}

function insert(name, item) {
  const items = [...(cache.get(name) || []), item];
  cache.set(name, items);
  persist(name, items);
  return clone(item);
}

/** 追加（O(1)，不复制数组）：高频写入如任务时间线；与 insert 语义相同但无返回拷贝 */
function append(name, item) {
  const items = cache.get(name) || [];
  items.push(item);
  cache.set(name, items);
  persist(name, items);
  return item;
}

/** 批量插入（如知识库索引重建），只写一次盘；逐条 insert 是 O(N²) */
function insertMany(name, newItems) {
  if (!Array.isArray(newItems) || !newItems.length) return [];
  const items = [...(cache.get(name) || []), ...newItems];
  cache.set(name, items);
  persist(name, items);
  return newItems.map((item) => clone(item));
}

/** 集合条数（浅读取，不克隆条目） */
function count(name) {
  return (cache.get(name) || []).length;
}

/** 按条件读取（只克隆命中项）：热路径避免整集合深拷贝 */
function query(name, predicate) {
  return (cache.get(name) || [])
    .filter((item) => predicate(item))
    .map((item) => clone(item));
}

/** 保留集合中匹配 predicate 的最后 keep 条（如任务时间线上限），其余删除；返回删除数 */
function keepLast(name, predicate, keep) {
  if (!Number.isInteger(keep) || keep < 0) return 0;
  const items = cache.get(name) || [];
  const matching = [];
  items.forEach((item, index) => {
    if (predicate(item)) matching.push(index);
  });
  if (matching.length <= keep) return 0;
  const removeSet = new Set(matching.slice(0, matching.length - keep));
  const kept = items.filter((_, index) => !removeSet.has(index));
  cache.set(name, kept);
  persist(name, kept);
  return removeSet.size;
}

function update(name, id, patch) {
  let updated = null;
  const items = (cache.get(name) || []).map((item) => {
    if (item.id !== id) return item;
    updated = { ...item, ...patch };
    return updated;
  });
  if (!updated) throw fail.notFound('记录不存在');
  cache.set(name, items);
  persist(name, items);
  return clone(updated);
}

function remove(name, id) {
  const items = (cache.get(name) || []).filter((item) => item.id !== id);
  cache.set(name, items);
  persist(name, items);
  return { id };
}

/** 批量删除（如重建知识库索引），只写一次磁盘 */
function removeWhere(name, predicate) {
  const items = cache.get(name) || [];
  const kept = items.filter((item) => !predicate(item));
  const removed = items.length - kept.length;
  if (removed) {
    cache.set(name, kept);
    persist(name, kept);
  }
  return { removed };
}

function getSettings() {
  return clone(settings);
}

function setSettings(patch) {
  settings = { ...settings, ...patch };
  persist('settings', settings);
  return clone(settings);
}

module.exports = {
  init,
  all,
  find,
  insert,
  insertMany,
  append,
  query,
  count,
  keepLast,
  update,
  remove,
  removeWhere,
  getSettings,
  setSettings,
  flush,
  setNotify,
  drainNotices,
  COLLECTIONS
};