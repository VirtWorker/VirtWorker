/**
 * 实体 ID 生成：前缀标识实体类型（wk/gp/tk/ar/ev），便于日志与 UI 中快速辨识。
 */
const { randomBytes } = require('node:crypto');

function createId(prefix) {
  return `${prefix}_${randomBytes(3).toString('hex')}`;
}

module.exports = { createId };