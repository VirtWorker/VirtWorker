/**
 * 设置域逻辑（F2 从 ipc/index.js 拆出）：默认值、入参边界收敛、执行器私有配置合并与掩码装饰。
 * 保留在 IPC 层（而非服务层）是既有安全决策：settings:update / executor:configure 是渲染层
 * 可直达的写入口，校验放在 IPC 边界可防「绕过 mergeExecutorConfig 的 vault 加密、明文落库」的旁路。
 */

const db = require('../store/db');
const bus = require('../runtime/event-bus');
const httpServer = require('../runtime/http-server');
const vault = require('../util/secret-vault');

const DEFAULT_SETTINGS = {
  taskView: 'list',
  period: 'month',
  mockRandomAction: true,
  notify: true,
  catchUpMissed: true,
  apiPort: httpServer.DEFAULT_PORT,
  /** 已结束且已查收的任务保留天数 */
  taskRetentionDays: 90,
  /** 界面主题：浅色 / 深色 / 跟随系统 */
  theme: 'system',
  /** 任务并发上限（O16，1..20），运行时按 capacity() 即时生效 */
  maxConcurrent: 5,
  /** 激活执行器（仅由 executor:activate 写入，重启后恢复） */
  activeExecutor: 'mock',
  /** need_action 超时（小时，0 = 关闭）与处置策略（O10） */
  actionTimeoutHours: 48,
  actionTimeoutPolicy: 'remind',
  /** 执行器私有配置命名空间（O16）：{ [executorName]: { key: value | sealed } }，密钥经 vault 加密 */
  executorConfig: {}
};
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
const TASK_VIEWS = ['list', 'board'];
const PERIODS = ['week', 'month', 'quarter'];
const THEMES = ['light', 'dark', 'system'];

function readSettings() {
  return { ...DEFAULT_SETTINGS, ...db.getSettings() };
}

/** 下发渲染层的设置视图：执行器配置中的密文以只读掩码呈现（O16） */
function decorateSettings(settings) {
  return { ...settings, executorConfig: decorateExecutorConfig(settings.executorConfig) };
}

/** 入参校验只做边界收敛，业务校验仍在服务层 */
function sanitizeSettings(patch = {}) {
  const safe = {};
  SETTINGS_KEYS.forEach((key) => {
    if (patch[key] === undefined) return;
    // activeExecutor / executorConfig 只能经 executor:activate / executor:configure 写入：
    // 在此放行会让渲染层旁路 mergeExecutorConfig 的 vault 加密，把密钥明文落库
    if (key === 'activeExecutor' || key === 'executorConfig') return;
    if (key === 'taskView' && !TASK_VIEWS.includes(patch[key])) return;
    if (key === 'period' && !PERIODS.includes(patch[key])) return;
    if (key === 'theme' && !THEMES.includes(patch[key])) return;
    if (key === 'apiPort') {
      const port = Number(patch[key]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
      safe[key] = port;
      return;
    }
    if (key === 'taskRetentionDays') {
      const days = Number(patch[key]);
      if (!Number.isInteger(days) || days < 1 || days > 3650) return;
      safe[key] = days;
      return;
    }
    if (key === 'maxConcurrent') {
      const cap = Number(patch[key]);
      if (!Number.isInteger(cap) || cap < 1 || cap > 20) return;
      safe[key] = cap;
      return;
    }
    if (key === 'actionTimeoutHours') {
      const hours = Number(patch[key]);
      if (!Number.isInteger(hours) || hours < 0 || hours > 8760) return;
      safe[key] = hours;
      return;
    }
    if (key === 'actionTimeoutPolicy' && !['fail', 'continue', 'remind'].includes(patch[key])) return;
    safe[key] = typeof DEFAULT_SETTINGS[key] === 'boolean' ? Boolean(patch[key]) : patch[key];
  });
  return safe;
}

// ==================== 执行器私有配置（O16） ====================

/** 敏感键命名约定：命中即 seal 落库，永不明文存储 */
const SENSITIVE_CONFIG_KEY_RE = /(key|secret|token|password|credential)/i;

/**
 * 合并执行器配置补丁：{ [executorName]: { key: value } }。
 * - 敏感键：字符串值经 vault.seal 落库；空字符串清除该键
 * - 掩码回传（{ masked: true, mask }，见 decorateExecutorConfig）：保留库内原值，防止掩码覆盖密文
 * - 其余键：字符串 ≤2048 字、布尔/数值透传
 */
function mergeExecutorConfig(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  const current = readSettings().executorConfig || {};
  const next = { ...current };
  let sealedUnprotected = false;
  for (const [name, config] of Object.entries(patch).slice(0, 20)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      delete next[name];
      continue;
    }
    const merged = { ...(next[name] || {}) };
    for (const [key, value] of Object.entries(config).slice(0, 30)) {
      if (typeof value === 'boolean' || typeof value === 'number') {
        merged[key] = value;
        continue;
      }
      const text = String(value ?? '');
      if (value && typeof value === 'object' && value.masked === true) {
        // 只读掩码回传 = 保留现有值（与自动化 Token 的 O6 契约同款语义）
        continue;
      }
      if (!text) {
        delete merged[key];
        continue;
      }
      if (SENSITIVE_CONFIG_KEY_RE.test(key)) {
        // 与自动化 Token 同款形态：{ sealed, mask }——密文落库、掩码供展示
        const sealedValue = vault.seal(text.slice(0, 2048));
        if (sealedValue.mode !== 'encrypted') sealedUnprotected = true;
        merged[key] = { sealed: sealedValue, mask: vault.mask(text.slice(0, 2048)) };
      } else {
        merged[key] = text.slice(0, 2048);
      }
    }
    next[name] = merged;
  }
  // 系统密钥链不可用时密钥仅 base64 编码存储，必须让用户知情（与连接器凭据同款告警，BUG-6）
  if (sealedUnprotected) {
    bus.emit('app:notice', {
      level: 'warning',
      title: '执行器密钥未获得系统级加密保护',
      body: '当前系统密钥链不可用，执行器配置中的敏感密钥仅做了基础编码存储。请检查 Windows 凭据服务是否正常。'
    });
  }
  return next;
}

/** 下发渲染层的执行器配置：密文替换为只读掩码，掩码回传时库内原值得以保留 */
function decorateExecutorConfig(executorConfig) {
  const config = executorConfig || {};
  return Object.fromEntries(
    Object.entries(config).map(([name, entries]) => [
      name,
      Object.fromEntries(
        Object.entries(entries || {}).map(([key, value]) => [
          key,
          value && typeof value === 'object' && value.sealed ? { masked: true, mask: value.mask || '' } : value
        ])
      )
    ])
  );
}

module.exports = {
  DEFAULT_SETTINGS,
  readSettings,
  decorateSettings,
  sanitizeSettings,
  mergeExecutorConfig,
  decorateExecutorConfig
};
