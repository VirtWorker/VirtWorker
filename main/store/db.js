/**
 * JSON 集合存储（仅主进程使用）
 * - 内存缓存 + 原子写（*.tmp → rename），写入前保留一份 *.bak
 * - 读取失败或版本过高时回退备份，再失败则以空集合启动，不阻塞应用
 * - 写入节流：变更先落缓存，100ms 内的多次写合并为一次磁盘写入；
 *   进程退出前必须 flush()，保证不丢数据（缓存始终是读取的唯一来源）
 * - 对外只暴露集合级接口，不体现实现细节，便于后续替换为 SQLite
 */

const fs = require('node:fs');
const path = require('node:path');
const schema = require('./schema');
const { fail } = require('../util/errors');

const COLLECTIONS = ['workers', 'groups', 'tasks', 'automations', 'capabilities', 'chunks', 'flows', 'shares'];

/** 合并写入窗口（毫秒）：任务执行高频更新时显著减少全量重写次数 */
const WRITE_COALESCE_MS = 100;

let baseDir = '';
const cache = new Map();
let settings = {};
/** 待落盘的集合：name → items 快照 */
const dirty = new Map();
let flushTimer = null;

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
  for (const candidate of [file, `${file}.bak`]) {
    if (!fs.existsSync(candidate)) continue;
    const payload = tryRead(candidate);
    if (!payload) continue;
    const result = schema.readCollection(payload);
    if (result.ok) return result.items;
    console.error(`[store] ${path.basename(candidate)} 不可用:`, result.reason);
  }
  return [];
}

function loadSettings() {
  const file = fileOf('settings');
  for (const candidate of [file, `${file}.bak`]) {
    if (!fs.existsSync(candidate)) continue;
    const payload = tryRead(candidate);
    if (!payload) continue;
    const result = schema.readSettings(payload);
    if (result.ok) return result.items;
    console.error(`[store] ${path.basename(candidate)} 不可用:`, result.reason);
  }
  return {};
}

/** 真正落盘单个集合：临时文件 → 备份旧文件 → rename 替换 */
function writeCollection(name, items) {
  const file = fileOf(name);
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify(
    { schemaVersion: schema.SCHEMA_VERSION, updatedAt: new Date().toISOString(), items },
    null,
    2
  );
  fs.writeFileSync(tmp, payload, 'utf8');
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
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

/** 立即把所有脏集合落盘；失败的集合保留待下次重试。进程退出前必须调用。 */
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const [name, items] of [...dirty.entries()]) {
    try {
      writeCollection(name, items);
      dirty.delete(name);
    } catch (error) {
      console.error(`[store] 写入 ${name}.json 失败，将在下次刷新重试：${error.message}`);
    }
  }
}

function init(dir) {
  baseDir = dir;
  fs.mkdirSync(baseDir, { recursive: true });
  COLLECTIONS.forEach((name) => cache.set(name, loadItems(name)));
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

module.exports = { init, all, find, insert, update, remove, removeWhere, getSettings, setSettings, flush, COLLECTIONS };