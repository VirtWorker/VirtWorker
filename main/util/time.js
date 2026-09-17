/**
 * 时间工具：统一 ISO 字符串口径与「数据周期」换算。
 * 全应用时间一律以 ISO 字符串（UTC）存储，展示层再做本地化格式。
 */

/** 数据周期枚举 → 天数（与看板筛选器的三个选项一一对应） */
const PERIOD_DAYS = { week: 7, month: 30, quarter: 90 };

function nowIso() {
  return new Date().toISOString();
}

/** 周期起始时间；未识别的周期返回 null，表示不做时间过滤 */
function periodStart(period) {
  const days = PERIOD_DAYS[period];
  if (!days) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function isWithinPeriod(iso, period) {
  const start = periodStart(period);
  if (!start) return true;
  return String(iso || '') >= start;
}

module.exports = { nowIso, periodStart, isWithinPeriod, PERIOD_DAYS };