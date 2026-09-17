/**
 * 存储 schema 版本与迁移。
 * 约定：每个集合文件结构为 { schemaVersion, updatedAt, items }。
 * 迁移函数按版本号从小到大顺序执行，只做结构升级，不做业务补偿。
 */

const SCHEMA_VERSION = 1;

/** 迁移表：键为目标版本号，值为 (items) => items */
const MIGRATIONS = {
  // 2: (items) => items,  // 未来结构变更时在此追加
};

/**
 * 校验并升级集合数据。
 * @returns {{ ok: boolean, items?: any, reason?: string }}
 */
function readCollection(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
    return { ok: false, reason: '结构不合法（items 必须为数组）' };
  }
  return upgrade(payload.items, payload.schemaVersion);
}

/** 设置集合的 items 为对象而非数组 */
function readSettings(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.items !== 'object' || Array.isArray(payload.items)) {
    return { ok: false, reason: '结构不合法（items 必须为对象）' };
  }
  return upgrade(payload.items, payload.schemaVersion);
}

function upgrade(items, fromVersion) {
  let version = Number(fromVersion) || 1;
  if (version > SCHEMA_VERSION) {
    return { ok: false, reason: `数据版本 ${version} 高于当前支持的 ${SCHEMA_VERSION}` };
  }
  let data = items;
  while (version < SCHEMA_VERSION) {
    version += 1;
    const migrate = MIGRATIONS[version];
    if (migrate) data = migrate(data);
  }
  return { ok: true, items: data };
}

module.exports = { SCHEMA_VERSION, readCollection, readSettings };