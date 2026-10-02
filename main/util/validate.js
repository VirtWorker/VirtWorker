/**
 * 统一入参校验助手（O12）
 * 约定：外部输入（IPC / 本地 API / IM 入站）非法一律抛 VALIDATION_FAILED，禁止静默改写；
 *       仅系统内部调用允许默认值兜底。此前「trim + 长度上限 + 同名冲突」的组合散落在 6+ 处、
 *       长度上限各自为政，本模块收敛实现并统一错误文案口径。
 */

const { fail } = require('./errors');

/** 必填文本：trim 后非空且不超长，返回规范化文本 */
function requiredText(value, { label, max = 100 } = {}) {
  const text = String(value ?? '').trim();
  if (!text) throw fail.validation(`请填写${label}`);
  if (text.length > max) throw fail.validation(`${label}最多 ${max} 个字符`);
  return text;
}

/** 可选文本：空值归一为空字符串，超长静默截断（描述类字段的既有语义，保留便于 IM 等长输入） */
function optionalText(value, max = 100) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * 唯一性校验：同名记录已存在（可排除自身）时抛 CONFLICT。
 * items 可传数组（全量克隆的旧用法）或免克隆的 existsFn（B1）：
 * existsFn(candidate, exceptId) 返回是否冲突——服务层配合 db.exists 做零克隆校验。
 */
function assertUniqueName(items, name, { label, exceptId } = {}) {
  const conflict =
    typeof items === 'function' ? items(name, exceptId) : items.some((item) => item.name === name && item.id !== exceptId);
  if (conflict) throw fail.conflict(`已存在同名${label}「${name}」`);
  return name;
}

/** 枚举校验：值必须命中枚举，否则 VALIDATION_FAILED（替代散落的 includes 静默忽略） */
function assertEnum(value, allowed, { label } = {}) {
  if (!allowed.includes(value)) throw fail.validation(`无效的${label}`);
  return value;
}

/**
 * 数组字段守卫：字段缺省（undefined）返回 undefined 由调用方决定默认值；
 * 显式传入但不是数组时抛错——防止「传错类型即静默清空」的危险默认值（如一键卸载全部能力）。
 */
function requireArray(value, { label } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw fail.validation(`${label}格式不正确`);
  return value;
}

/** 正整数解析：兼容数字字符串（外部调用方常见形态），非法返回 null */
function toPositiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

module.exports = { requiredText, optionalText, assertUniqueName, assertEnum, requireArray, toPositiveInt };
