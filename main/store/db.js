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
  /** 任务历史归档（BUG-20 写放大治理）：已查收且超出归档阈值的任务从 tasks 移入，
   *  把高频写入的活跃集合规模压在「归档阈值 + 保留策略」的窗口内；
   *  结构与 tasks 完全一致（v2，时间线同样在 taskevents），读路径由 task-service 合并 */
  'tasks-archive',
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
/**
 * 时间线追加日志（写放大治理）：taskevents 的 append 从「每次全量重写整个集合文件」
 * （stringify + fsync + 双备份拷贝 + rename，量级 O(集合)）改为 JSONL 单行追加（O(单条)），
 * 攒够阈值才做一次全量压缩写——把全量成本从每事件一次摊薄到每 N 条事件一次。
 * 全量写路径（removeWhere/keepLast/迁移/压缩）落盘成功后必须清空日志，
 * 否则加载时回放会把已删除/已修剪的事件复活（按 id 去重只能防重复，防不了复活）。
 */
const EVENTS_LOG_NAME = 'taskevents.log';
/** 追加日志压缩阈值（行数）：到达后下一次 append 触发压缩 */
const EVENTS_LOG_COMPACT_LINES = 1000;
/** 自上次压缩以来追加日志的行数 */
let eventsLogLines = 0;

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
/**
 * 异步快照拷贝进行中标记（PERF-5）：拷贝期间暂缓 flush 与追加日志压缩。
 * 异步拷贝会让「内存继续变更 + 节流定时器落盘」与「读文件句柄」并发：Windows 上
 * rename 覆盖一个正被 copyFile 读取的目标文件会 EPERM，快照内容也可能半新半旧。
 * 期间变更只累积在内存/dirty，拷贝结束后由 backup() 统一收口落盘（内存始终是读取来源，无一致性影响）。
 */
let snapshotInFlight = false;
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
    // 注意 NaN（schemaVersion 缺失）：Number(undefined) 与 2 比较为 false，必须显式覆盖，
    // 否则缺失版本号的 v1 文件会按 v2 处理、schema 剥离 events 后时间线静默丢失
    let legacyEvents = null;
    if (name === 'tasks' && !(Number(payload.schemaVersion) >= 2) && Array.isArray(payload.items)) {
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
  // taskevents 全量落盘成功后，追加日志即告过期：必须清空，否则加载时回放会把
  // 本次全量写中已删除/已修剪的事件复活（仅 rename 成功后清空，失败时日志仍是权威来源）
  if (name === 'taskevents') clearEventsLog();
}

// ==================== 时间线追加日志（taskevents 写放大治理） ====================

function eventsLogFile() {
  return path.join(baseDir, EVENTS_LOG_NAME);
}

/** 追加日志回放（init 时调用一次）：按 id 去重；崩溃撕裂的尾部半行跳过 */
function loadEventsLog() {
  eventsLogLines = 0;
  let content;
  try {
    content = fs.readFileSync(eventsLogFile(), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[store] 读取时间线追加日志失败:', error.message);
    return;
  }
  const items = cache.get('taskevents') || [];
  const knownIds = new Set(items.map((event) => event.id));
  let replayed = 0;
  let badLines = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    eventsLogLines += 1;
    try {
      const event = JSON.parse(trimmed);
      // 日志由本进程写入，最小校验（对象 + id）即可；重复 id 是「全量写成功但截断失败」的残留
      if (event && typeof event === 'object' && event.id && !knownIds.has(event.id)) {
        knownIds.add(event.id);
        items.push(event);
        replayed += 1;
      }
    } catch (error) {
      badLines += 1;
    }
  }
  if (replayed) cache.set('taskevents', items);
  if (badLines) console.warn(`[store] 时间线追加日志含 ${badLines} 行不可解析（崩溃残留），已跳过`);
}

/** 清空追加日志（必须紧跟在 taskevents 全量落盘成功之后调用） */
function clearEventsLog() {
  try {
    fs.writeFileSync(eventsLogFile(), '', 'utf8');
    eventsLogLines = 0;
  } catch (error) {
    // 截断失败不阻塞主流程：置为阈值让下一次 append 触发重试压缩；
    // 期间回放按 id 去重不会产生重复事件
    console.error('[store] 清空时间线追加日志失败:', error.message);
    eventsLogLines = EVENTS_LOG_COMPACT_LINES;
  }
}

/** 全量压缩：当前缓存写入 taskevents.json（含备份轮换，writeCollection 内部清空日志） */
function compactEventsLog() {
  writeCollection('taskevents', cache.get('taskevents') || []);
}

/**
 * 时间线追加写（O(单条)）：小行 appendFileSync 走页缓存，不再整集合重写。
 * 不逐行 fsync：断电可能丢尾部若干行（与 logger 模块同等取舍），撕裂行由回放跳过。
 */
function appendEventsLog(item) {
  try {
    fs.appendFileSync(eventsLogFile(), `${JSON.stringify(item)}\n`, 'utf8');
    eventsLogLines += 1;
    // 快照拷贝期间暂缓压缩：writeCollection 的 rename 会与拷贝读句柄冲突（见 snapshotInFlight 注释），
    // 拷贝结束后由 backup() 收口补压缩；期间多出的日志行由回放去重兜底
    if (eventsLogLines >= EVENTS_LOG_COMPACT_LINES && !snapshotInFlight) compactEventsLog();
  } catch (error) {
    // 追加失败（磁盘满等）：回退到全量重写路径保证事件不丢，由 flush 的重试定时器兜底
    console.error('[store] 时间线追加写失败，回退全量写:', error.message);
    eventsLogLines = 0;
    persist('taskevents', cache.get('taskevents') || []);
  }
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
  // 快照拷贝期间暂缓写盘：保留定时器持续滚动，拷贝结束由 backup() 收口（见 snapshotInFlight 注释）
  if (snapshotInFlight) {
    scheduleFlush();
    return;
  }
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
  for (const name of [...dirty.keys()]) {
    // taskevents 的 append 走追加日志、不经 dirty；全量写必须取当前缓存——
    // 若写旧脏快照后截断日志，日志路径刚追加的事件会丢失
    const items = name === 'taskevents' ? (cache.get(name) || []) : dirty.get(name);
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
  dirty.clear(); // 丢弃旧目录的待写状态：重初始化后一切以磁盘重载结果为准，旧脏条目不得写向新目录
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
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
  // 追加日志回放必须发生在 legacy 合并的 persist 之前：
  // 否则合并落盘的脏快照不含日志事件，flush 全量写 + 截断日志会丢时间线
  loadEventsLog();
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
  // 上次会话遗留的日志过大时启动即压缩一次，避免运行初期反复触发压缩
  if (!readOnlyReason && eventsLogLines >= EVENTS_LOG_COMPACT_LINES) {
    try {
      compactEventsLog();
    } catch (error) {
      console.error('[store] 启动压缩时间线日志失败:', error.message);
    }
  }
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

/** 追加（O(1)，不复制数组）：高频写入如任务时间线；与 insert 语义相同但无返回拷贝。
 *  taskevents 走专用追加日志（O(单条) 落盘），不经 dirty/全量重写路径 */
function append(name, item) {
  const items = cache.get(name) || [];
  items.push(item);
  cache.set(name, items);
  if (name === 'taskevents') {
    if (!readOnlyReason) appendEventsLog(item);
    return item;
  }
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

/**
 * 免克隆映射（PERF-6）：对集合缓存原位 map，不逐条深拷贝——只用于提取标量（如全部 id）。
 * 纪律：回调绝不能返回或保留条目/其内部引用，否则外部将绕过克隆纪律直接持有可变缓存条目。
 */
function pluck(name, fn) {
  return (cache.get(name) || []).map(fn);
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

/**
 * 定向写回（PERF-7）：与 update 同语义（合并 patch、O(N) 定位、单次 persist 标记），
 * 但不做返回值深克隆——供调用方自持完整草稿的读-改-写路径（taskService.mutate）使用，
 * 省去每次单条高频写（startStep/completeStep/recordEvent）一次全任务深克隆的浪费。
 * 写回的缓存条目与调用方草稿共享嵌套引用，纪律与既有 update 相同：
 * 调用方此后不得改写草稿（读取/广播/序列化不受影响）。
 */
function writeBack(name, id, patch) {
  let updated = false;
  const items = (cache.get(name) || []).map((item) => {
    if (item.id !== id) return item;
    updated = true;
    return { ...item, ...patch };
  });
  if (!updated) throw fail.notFound('记录不存在');
  cache.set(name, items);
  persist(name, items);
}

/**
 * 批量条件更新（PERF-3）：单次集合遍历 + 单次落盘标记。
 * 逐条 db.update 是 O(N²)（每条一次全集合 map + persist 标记），批量查收等场景不可承受。
 * updater 收到条目的克隆并就地修改（与 taskService.mutate 同款克隆纪律），
 * 未命中条目引用保持不变；返回更新条目的克隆数组（调用方不得据此改写缓存）。
 */
function updateWhere(name, condition, updater) {
  const test = conditionOf(condition);
  const items = cache.get(name) || [];
  const updatedItems = [];
  const next = items.map((item) => {
    if (!test(item)) return item;
    const copy = clone(item);
    updater(copy);
    updatedItems.push(clone(copy));
    return copy;
  });
  if (updatedItems.length) {
    cache.set(name, next);
    persist(name, next);
  }
  return updatedItems;
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
 * 整目录快照：复制数据目录全部文件到 backups/<时间戳>/（异步，PERF-5——拷贝不再阻塞主进程）。
 * .bak 备份只能回退一代写入损坏，快照防的是误删与逻辑损坏随时间扩散；
 * 只复制不写主数据，失败仅告警，不中断调用方。
 * 写入屏障（BUG-21 + PERF-5）三段式：
 * ① 拷贝前 flush 全部脏集合、再把 taskevents 追加日志压缩为全量 json——快照里各集合
 *    json 即为完整状态、log 恒为空，杜绝「json 与 log 跨时刻组合不一致」；
 * ② 拷贝期间置 snapshotInFlight 暂缓落盘/压缩，杜绝节流定时器的 rename 与拷贝读句柄
 *    在 Windows 上冲突（EPERM），也保证快照内容不半新半旧；期间变更留在内存/dirty；
 * ③ 拷贝结束 finally 收口：补 flush + 按需补压缩，把拷贝期间累积的变更统一落盘。
 * 只读保护下 flush/compact 自然跳过，按当前磁盘状态出快照（与既有行为一致）。
 */
async function backup() {
  if (!baseDir) return { dir: '', files: 0, kept: 0 };
  flush(); // 屏障①：磁盘 == 内存
  if (!readOnlyReason && eventsLogLines > 0) compactEventsLog();
  const target = path.join(backupsRoot(), snapshotName(new Date()));
  snapshotInFlight = true; // 屏障②：拷贝期间暂缓落盘
  try {
    await fs.promises.mkdir(target, { recursive: true });
    const names = await fs.promises.readdir(baseDir);
    let files = 0;
    for (const name of names) {
      if (name.endsWith('.tmp')) continue; // 写入未完成的临时文件不进快照
      try {
        const src = path.join(baseDir, name);
        if (!(await fs.promises.stat(src)).isFile()) continue;
        await fs.promises.copyFile(src, path.join(target, name));
        files += 1;
      } catch (error) {
        console.error(`[store] 快照跳过 ${name}:`, error.message);
      }
    }
    return { dir: target, files, kept: rotateBackups() };
  } finally {
    // 屏障③：拷贝期间累积的变更统一落盘；追加日志若在拷贝期到达压缩阈值则补压缩
    snapshotInFlight = false;
    flush();
    if (!readOnlyReason && eventsLogLines >= EVENTS_LOG_COMPACT_LINES) compactEventsLog();
  }
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
 * 一致性屏障（BUG-21）：快照缺失 taskevents.log（如旧版快照、或日志未生成的全新安装）
 * 时，必须删除当前数据目录的追加日志——遗留的现行日志在重启回放时会把「快照之后
 * 已删除/已修剪」的事件复活（按 id 去重防不了复活）；快照自带日志时拷贝覆盖，天然一致。
 */
function restore(name) {
  const snapshot = String(name ?? '');
  if (!BACKUP_NAME_PATTERN.test(snapshot)) throw fail.validation('备份快照名不合法');
  const source = path.join(backupsRoot(), snapshot);
  if (!fs.existsSync(source)) throw fail.notFound('备份快照不存在');
  enterReadOnly(`正在恢复备份「${snapshot}」，本会话已暂停写入，重启后生效`);
  const snapshotFiles = new Set(fs.readdirSync(source));
  let files = 0;
  for (const entry of snapshotFiles) {
    const src = path.join(source, entry);
    try {
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(baseDir, entry));
      files += 1;
    } catch (error) {
      console.error(`[store] 恢复跳过 ${entry}:`, error.message);
    }
  }
  if (!snapshotFiles.has(EVENTS_LOG_NAME)) {
    try {
      fs.rmSync(path.join(baseDir, EVENTS_LOG_NAME), { force: true });
    } catch (error) {
      console.error('[store] 恢复清理遗留追加日志失败:', error.message);
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
  pluck,
  keepLast,
  update,
  writeBack,
  updateWhere,
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
  EVENTS_LOG_COMPACT_LINES,
  COLLECTIONS
};