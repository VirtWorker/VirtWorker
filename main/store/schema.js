/**
 * 存储 schema 版本与迁移。
 * 约定：每个集合文件结构为 { schemaVersion, updatedAt, items }。
 * 迁移函数按版本号从小到大顺序执行，只做结构升级，不做业务补偿。
 * v2：任务时间线（events）从 tasks 集合内嵌字段拆分为独立 taskevents 集合；
 *     内嵌 events 的提取由 db.loadItems 在升级前完成（跨集合数据搬运），此处只做剥离。
 */

const SCHEMA_VERSION = 2;

/** 迁移表：键为目标版本号，值为 (items, name) => items */
const MIGRATIONS = {
  2: (items, name) => {
    if (name !== 'tasks') return items;
    return items.map((task) => {
      if (!task || !Array.isArray(task.events)) return task;
      const { events, ...rest } = task; // events 已由 db.loadItems 提取到 taskevents 集合
      return rest;
    });
  }
};

/**
 * 校验并升级集合数据。
 * @returns {{ ok: boolean, items?: any, reason?: string }}
 */
function readCollection(payload, name) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
    return { ok: false, code: 'corrupt', reason: '结构不合法（items 必须为数组）' };
  }
  return upgrade(payload.items, payload.schemaVersion, name);
}

/** 设置集合的 items 为对象而非数组 */
function readSettings(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.items !== 'object' || Array.isArray(payload.items)) {
    return { ok: false, code: 'corrupt', reason: '结构不合法（items 必须为对象）' };
  }
  return upgrade(payload.items, payload.schemaVersion, 'settings');
}

function upgrade(items, fromVersion, name = '') {
  let version = Number(fromVersion) || 1;
  if (version > SCHEMA_VERSION) {
    // code=stale_code：数据本身完好，只是由更新版本的应用写入（如用户从新版降级）。
    // 调用方（db）据此进入只读保护，而不是以空数据启动后把完好文件覆盖掉
    return { ok: false, code: 'stale_code', reason: `数据版本 ${version} 高于当前支持的 ${SCHEMA_VERSION}` };
  }
  let data = items;
  while (version < SCHEMA_VERSION) {
    version += 1;
    const migrate = MIGRATIONS[version];
    // 缺迁移函数时拒绝加载：静默跳级会把旧结构当新结构使用，属于数据损坏
    if (!migrate) {
      return {
        ok: false,
        code: 'stale_code',
        reason: `缺少 ${version} 版迁移定义，无法安全升级（请补充 MIGRATIONS[${version}]）`
      };
    }
    data = migrate(data, name);
  }
  return { ok: true, items: data };
}

module.exports = { SCHEMA_VERSION, readCollection, readSettings };