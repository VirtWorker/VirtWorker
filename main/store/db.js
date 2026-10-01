/**
 * JSON 集合存储（仅主进程使用）
 * - 内存缓存 + 原子写（*.tmp → fsync → rename），写入前轮换保留两代备份（*.bak / *.bak2）
 * - 读取失败或版本过高时回退备份，全部失败则以空集合启动，不阻塞应用但会发出告警；
 *   若失败原因是「数据版本高于当前支持」（如从新版降级），则进入只读保护：
 *   数据本身完好，绝不以空/旧内存状态写回覆盖原文件，直到应用升级后重新加载
 * - 写入节流：变更先落缓存，100ms 内的多次写合并为一次磁盘写入；
 *   写盘失败自动定时重试并通知（setNotify），进程退出前必须 flush()（缓存始终是读取的唯一来源）
 * - 数据快照：backup() 把整个数据目录复制到 backups/<时间戳>/ 并轮换保留最近 N 份，
 *   防「.bak 只能回退一代」覆盖不到的误删与逻辑损坏；restore() 恢复快照（配合只读保护 + 重启）
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
/** 脏数据最大滞留时长（毫秒）：定时器被饥饿等异常拖住时，写操作本身会强制落盘兜底 */
const MAX_FLUSH_DELAY_MS = 2000;
/** 写盘失败后的自动重试间隔 */
const FLUSH_RETRY_MS = 5 * 1000;
/** 持续失败时用户告警的限频间隔（避免通知刷屏） */
const FLUSH_NOTIFY_INTERVAL_MS = 5 * 60 * 1000;
/** notify 注册前产生的告警缓存上限 */
const MAX_PENDING_NOTICES = 20;
/** 快照保留份数：超出后按时间序轮换删除（每日自动备份 + 手动备份共用） */
const BACKUP_KEEP = 7;
/** 合法快照目录名（snapshotName 生成的 <日期>-<时间>） */
const BACKUP_NAME_PATTERN = /^\d{8}-\d{6}$/;

let baseDir = '';
const cache = new Map();
let settings = {};
/** 待落盘的集合：name → items 快照 */
const dirty = new Map();
let flushTimer = null;
let flushRetryTimer = null;
let lastFlushNotifyAt = 0;
/** 最早的未落盘脏标记时间（0 = 无脏数据）：写入滞留超上限时由 persist 强制落盘 */
let oldestDirtyAt = 0;
/**
 * 只读保护原因（null = 可写）。
 * 触发场景：① 数据版本高于当前支持（降级/缺迁移定义）；② 恢复快照后等待重启。
 * 只读模式下内存状态可继续运行本次会话，但 persist/flush 一律拒绝写盘，
 * 防止空数据或过期内存状态覆盖磁盘上的完好数据。
 */
let readOnlyReason = null;
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

function notifyStorageIssue(message, title = '数据存储异常') {
  const notice = { level: 'error', title, message };
  if (notifyFn) {
    try {
      notifyFn(notice);
    } catch (error) {
      // 通知失败不影响存储主流程
    }
  }
  if (pendingNotices.length < MAX_PENDING_NOTICES) pendingNotices.push(notice);
}

/**
 * 进入只读保护（幂等）：首次调用记录原因并告警，此后所有写盘被拒绝。
 * 只在重新 init()（应用升级后重启 / 测试重装）时复位。
 */
function enterReadOnly(reason) {
  if (readOnlyReason) return;
  readOnlyReason = reason;
  notifyStorageIssue(reason, '数据已进入只读保护');
}

function isReadOnly() {
  return Boolean(readOnlyReason);
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
  let sawStaleVersion = false;
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
    if (result.code === 'stale_code') sawStaleVersion = true;
    console.error(`[store] ${path.basename(candidate)} 不可用:`, result.reason);
  }
  if (sawStaleVersion) {
    // 数据由更新版本的应用写入（如从新版降级）：文件本身完好，
    // 绝不能以空数据启动后把内存态写回覆盖原文件——进入只读保护，提示用户升级应用
    enterReadOnly(
      `「${name}.json」的数据版本高于当前应用支持的范围，已暂停写入以保护原数据。请升级应用后再使用，原数据不会丢失`
    );
    return { items: [], legacyEvents: null };
  }
  // 文件存在但全部不可读：以空集合启动不阻塞应用，但必须让用户知情（静默丢数据不可接受）
  if (sawFile) notifyStorageIssue(`${name}.json 及其备份均无法读取，已以空数据启动`);
  return { items: [], legacyEvents: null };
}

function loadSettings() {
  const file = fileOf('settings');
  let sawFile = false;
  let sawStaleVersion = false;
  for (const candidate of [file, `${file}.bak`, `${file}.bak2`]) {
    if (!fs.existsSync(candidate)) continue;
    sawFile = true;
    const payload = tryRead(candidate);
    if (!payload) continue;
    const result = schema.readSettings(payload);
    if (result.ok) return result.items;
    if (result.code === 'stale_code') sawStaleVersion = true;
    console.error(`[store] ${path.basename(candidate)} 不可用:`, result.reason);
  }
  if (sawStaleVersion) {
    enterReadOnly('「settings.json」的数据版本高于当前应用支持的范围，已暂停写入以保护原数据，请升级应用后再使用');
    return {};
  }
  if (sawFile) notifyStorageIssue('settings.json 及其备份均无法读取，已恢复默认设置');
  return {};
}

/** 真正落盘单个集合：临时文件 → fsync → 备份轮换（保留两代）→ rename 原子替换。
 *  大集合用紧凑序列化（缩进额外膨胀 30%+ 体积，直接放大任务高频更新时的全量重写成本）；
 *  settings 体积小且是人工排查时最常看的文件，保留缩进可读性。 */
function writeCollection(name, items) {
  const file = fileOf(name);
  const tmp = `${file}.tmp`;
  const indent = name === 'settings' ? 2 : 0;
  const payload = JSON.stringify(
    { schemaVersion: schema.SCHEMA_VERSION, updatedAt: new Date().toISOString(), items },
    null,
    indent
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
 * 只读保护下拒绝标记脏：内存可继续运行会话，但磁盘上的完好数据绝不被覆盖。
 * 脏数据滞留超过 MAX_FLUSH_DELAY_MS 时跳过合并窗口直接落盘（定时器饥饿的兜底）。
 */
function persist(name, items) {
  if (readOnlyReason) return;
  dirty.set(name, items);
  const now = Date.now();
  if (!oldestDirtyAt) oldestDirtyAt = now;
  if (now - oldestDirtyAt >= MAX_FLUSH_DELAY_MS) {
    flush();
    return;
  }
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
 * 只读保护下直接跳过（persist 已拒绝标记脏，这里兜底防止退出路径的任何写盘）。
 */
function flush() {
  if (readOnlyReason) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushRetryTimer) {
    clearTimeout(flushRetryTimer);
    flushRetryTimer = null;
  }
  oldestDirtyAt = dirty.size ? Date.now() : 0; // 未写成功的集合重新起算滞留时钟（由重试定时器兜底）
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
  readOnlyReason = null; // 重新初始化（应用升级后重启 / 测试重装）即复位只读保护
  oldestDirtyAt = 0;
  // 清理上次运行在「写 tmp 后、rename 前」崩溃遗留的临时文件（下次写入会直接覆盖，留着只会干扰排查）
  try {
    fs.readdirSync(baseDir).filter((name) => name.endsWith('.tmp')).forEach((name) => {
      try {
        fs.rmSync(path.join(baseDir, name), { force: true });
      } catch (error) {
        console.error(`[store] 清理遗留临时文件 ${name} 失败:`, error.message);
      }
    });
  } catch (error) {
    // 目录读取失败不影响启动，后续 loadItems 会按损坏路径处理
  }
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

/**
 * 结构化匹配器（SQLite 迁移预付，O11）：只支持可翻译为 SQL WHERE 的三种形态——
 * 键为字段名（支持点路径如 'assignee.id'），值为「等值匹配」；值为数组时为「IN 包含匹配」。
 * 服务层的热路径谓词统一收敛到该形态，换库时这些查询可直接翻译，复杂过滤仍可用函数谓词。
 */
function matches(item, matcher) {
  return Object.entries(matcher).every(([key, expected]) => {
    const value = key.split('.').reduce((obj, part) => (obj == null ? undefined : obj[part]), item);
    if (Array.isArray(expected)) return expected.includes(value);
    return value === expected;
  });
}

/** 条件参数归一：函数谓词原样使用，对象按结构化匹配器处理 */
function conditionOf(condition) {
  return typeof condition === 'function' ? condition : (item) => matches(item, condition);
}

/** 结构化查询：等价于 query(name, matcher)，但调用点显式声明「这是可翻译谓词」 */
function where(name, matcher) {
  return (cache.get(name) || [])
    .filter((item) => matches(item, matcher))
    .map((item) => clone(item));
}

/** 条件计数：统计/预览类口径只需数量，不产生任何克隆 */
function countWhere(name, condition) {
  const test = conditionOf(condition);
  return (cache.get(name) || []).filter(test).length;
}

/** 保留集合中匹配条件的最后 keep 条（如任务时间线上限），其余删除；返回删除数 */
function keepLast(name, condition, keep) {
  if (!Number.isInteger(keep) || keep < 0) return 0;
  const test = conditionOf(condition);
  const items = cache.get(name) || [];
  const matching = [];
  items.forEach((item, index) => {
    if (test(item)) matching.push(index);
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

/** 批量删除（如重建知识库索引、过期任务清理），只写一次磁盘；条件可为函数或结构化匹配器 */
function removeWhere(name, condition) {
  const test = conditionOf(condition);
  const items = cache.get(name) || [];
  const kept = items.filter((item) => !test(item));
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

// ==================== 数据快照备份（F5）====================

/** 快照根目录：与数据目录同级（userData/backups），不混入集合读写路径 */
function backupsRoot() {
  return path.join(path.dirname(baseDir), 'backups');
}

function snapshotName(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 按名称（即时间序）倒序列出现有快照 */
function listSnapshotNames() {
  try {
    return fs.readdirSync(backupsRoot()).filter((name) => BACKUP_NAME_PATTERN.test(name)).sort().reverse();
  } catch (error) {
    return [];
  }
}

/** 快照轮换：保留最近 BACKUP_KEEP 份，返回轮换后的保留份数 */
function rotateBackups() {
  const snapshots = listSnapshotNames();
  snapshots.slice(BACKUP_KEEP).forEach((name) => {
    try {
      fs.rmSync(path.join(backupsRoot(), name), { recursive: true, force: true });
    } catch (error) {
      console.error(`[store] 清理旧快照 ${name} 失败:`, error.message);
    }
  });
  return Math.min(snapshots.length, BACKUP_KEEP);
}

/**
 * 整目录快照：复制数据目录全部文件到 backups/<时间戳>/。
 * .bak 备份只能回退一代写入损坏，快照防的是误删与逻辑损坏随时间扩散；
 * 只复制不写主数据，只读保护下同样安全。失败仅告警，不中断调用方。
 */
function backup() {
  if (!baseDir) return { dir: '', files: 0, kept: 0 };
  const target = path.join(backupsRoot(), snapshotName(new Date()));
  fs.mkdirSync(target, { recursive: true });
  let files = 0;
  for (const name of fs.readdirSync(baseDir)) {
    if (name.endsWith('.tmp')) continue; // 写入未完成的临时文件不进快照
    try {
      const src = path.join(baseDir, name);
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(target, name));
      files += 1;
    } catch (error) {
      console.error(`[store] 快照跳过 ${name}:`, error.message);
    }
  }
  return { dir: target, files, kept: rotateBackups() };
}

/** 快照列表（新→旧），供恢复入口下拉展示 */
function listBackups() {
  return listSnapshotNames().map((name) => {
    let files = 0;
    try {
      files = fs.readdirSync(path.join(backupsRoot(), name)).length;
    } catch (error) {
      // 目录被并发轮换清理时按 0 计
    }
    return { name, files };
  });
}

/**
 * 恢复快照：把快照内文件覆盖回数据目录，随后由调用方重启应用加载。
 * 恢复前进入只读保护：本会话的内存状态（已与磁盘不一致）绝不落盘覆盖刚恢复的文件，
 * before-quit 的 flush 在只读模式下为空操作，重启后 init 重新加载恢复的数据并复位只读。
 */
function restore(name) {
  const snapshot = String(name ?? '');
  if (!BACKUP_NAME_PATTERN.test(snapshot)) throw fail.validation('备份快照名不合法');
  const source = path.join(backupsRoot(), snapshot);
  if (!fs.existsSync(source)) throw fail.notFound('备份快照不存在');
  enterReadOnly(`正在恢复备份「${snapshot}」，本会话已暂停写入，重启后生效`);
  let files = 0;
  for (const entry of fs.readdirSync(source)) {
    const src = path.join(source, entry);
    try {
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(baseDir, entry));
      files += 1;
    } catch (error) {
      console.error(`[store] 恢复跳过 ${entry}:`, error.message);
    }
  }
  return { restored: snapshot, files };
}

module.exports = {
  init,
  all,
  find,
  insert,
  insertMany,
  append,
  query,
  where,
  countWhere,
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
  isReadOnly,
  backup,
  listBackups,
  restore,
  backupsRoot,
  BACKUP_KEEP,
  MAX_FLUSH_DELAY_MS,
  COLLECTIONS
};