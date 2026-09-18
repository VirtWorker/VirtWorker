/**
 * 实体 ID 生成：前缀标识实体类型（wk/gp/tk/at/ev/fl/sh/nd），便于日志与 UI 中快速辨识。
 * 结构：前缀 + base36 时间戳 + 随机十六进制。时间戳保证单调可排序，随机部分保证同毫秒内不碰撞；
 * 相比纯 3 字节随机，实体量级增长后生日碰撞概率可忽略。
 * 注意：仅前缀段有语义（task-service 按 `gp_` / `fl_` 判定类型），随机段保持 [a-z0-9] 以兼容 URL 匹配。
 */
const { randomBytes } = require('node:crypto');

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

module.exports = { createId };
