/**
 * 自动任务（Automation）领域服务
 * 职责：定时/事件/API 三类触发器的配置校验、下次触发时间推算、启停与增删改查、统计。
 * 说明：本服务只负责「配置与计划」，实际触发时机由 runtime/scheduler 决定；
 *       触发后统一调用 task-service 创建任务，与手动创建共用同一套执行链路。
 */

const { randomBytes } = require('node:crypto');
const db = require('../store/db');
const bus = require('../runtime/event-bus');
const vault = require('../util/secret-vault');
const taskService = require('./task-service');
const { createId } = require('../util/id');
const { requiredText, optionalText, assertUniqueName, assertEnum } = require('../util/validate');
const { nowIso } = require('../util/time');
const { fail } = require('../util/errors');

const TRIGGER_LABEL = { schedule: '定时', event: '事件', api: 'API' };

const SCHEDULE_MODES = {
  interval: '按间隔重复',
  hourly: '每小时',
  daily: '每天',
  weekly: '每周',
  once: '仅一次'
};

const EVENT_SOURCES = {
  task_succeeded: '任意任务完成时',
  task_failed: '任意任务失败时'
};

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 状态筛选枚举（O12）：IPC 契约只认存储枚举 */
const STATUS_FILTER = { enabled: true, disabled: false };

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function pad(number) {
  return String(number).padStart(2, '0');
}

/** 把结构化配置渲染成一句人话，用于列表展示 */
function describeTrigger(trigger) {
  if (trigger.type === 'event') {
    const source = EVENT_SOURCES[trigger.event?.source] || '业务事件';
    return trigger.event?.assigneeId ? `${source}（限定执行者）` : source;
  }
  if (trigger.type === 'api') return '通过本地端点触发';
  const schedule = trigger.schedule || {};
  switch (schedule.mode) {
    case 'interval':
      return `每 ${schedule.everyMinutes} 分钟`;
    case 'hourly':
      return `每小时第 ${schedule.minute} 分`;
    case 'daily':
      return `每天 ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case 'weekly':
      return `每${WEEKDAY_LABEL[schedule.weekday]} ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case 'once':
      return `仅一次（${schedule.at ? schedule.at.replace('T', ' ') : '未设置'}）`;
    default:
      return '未设置';
  }
}

/** 错峰抖动窗口（OPT-8）：墙上时钟锚定模式（hourly/daily/weekly）的自动任务若同刻配置，
 *  会在同一时刻一起建任务（真实 LLM 执行器接入后还叠加 API 限流压力）。
 *  对下次触发时刻施加 ±5 分钟抖动把队列错开。确定性来源：以 (seed=自动化ID, 精确槽位时刻)
 *  散列——同一自动任务在同一槽位的推算结果恒定（create/update/markFired 重复推算不漂移），
 *  不同自动化/不同槽位近似均匀散开；interval 本就锚定各自 previousDue、once 是用户指定
 *  时刻，均不参与抖动；不传 seed（纯函数直调/测试）不抖动。 */
const JITTER_WINDOW_MS = 5 * 60 * 1000;

function slotJitterMs(seed, slotMs) {
  if (!seed) return 0;
  const text = `${seed}@${slotMs}`;
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return (hash % (2 * JITTER_WINDOW_MS + 1)) - JITTER_WINDOW_MS; // [-5min, +5min]
}

/**
 * 推算下次触发时间（纯函数，无副作用；seed 传自动化 ID 时对墙上时钟模式做确定性错峰抖动）
 * 定时器只用到毫秒级精度，故全部按本地时间计算。
 */
function computeNextRun(trigger, from = new Date(), seed = null) {
  if (!trigger || trigger.type !== 'schedule') return null;
  const schedule = trigger.schedule || {};
  const base = new Date(from.getTime());
  let next; // switch 各分支要么赋值后 break，要么直接 return

  switch (schedule.mode) {
    case 'interval': {
      const minutes = clampInt(schedule.everyMinutes, 1, 1440, 30);
      next = new Date(base.getTime() + minutes * 60 * 1000);
      break;
    }
    case 'hourly': {
      next = new Date(base);
      next.setSeconds(0, 0);
      next.setMinutes(clampInt(schedule.minute, 0, 59, 0));
      if (next.getTime() <= base.getTime()) next.setHours(next.getHours() + 1);
      break;
    }
    case 'daily': {
      next = new Date(base);
      next.setHours(clampInt(schedule.hour, 0, 23, 9), clampInt(schedule.minute, 0, 59, 0), 0, 0);
      if (next.getTime() <= base.getTime()) next.setDate(next.getDate() + 1);
      break;
    }
    case 'weekly': {
      next = new Date(base);
      next.setHours(clampInt(schedule.hour, 0, 23, 9), clampInt(schedule.minute, 0, 59, 0), 0, 0);
      let delta = (clampInt(schedule.weekday, 0, 6, 1) - next.getDay() + 7) % 7;
      if (delta === 0 && next.getTime() <= base.getTime()) delta = 7;
      next.setDate(next.getDate() + delta);
      break;
    }
    case 'once': {
      const at = schedule.at ? new Date(schedule.at) : null;
      if (!at || Number.isNaN(at.getTime()) || at.getTime() <= base.getTime()) return null;
      return at.toISOString();
    }
    default:
      return null;
  }

  if (seed && schedule.mode !== 'interval' && schedule.mode !== 'once') {
    const jittered = new Date(next.getTime() + slotJitterMs(seed, next.getTime()));
    // 抖动不得把触发时刻推到基准之前（如 hourly 槽位距基准不足 5 分钟时的负向抖动），
    // 此时退回精确槽位——该自动化本槽位仍与其余同刻任务同发，属可接受的少数情况
    if (jittered.getTime() > base.getTime()) return jittered.toISOString();
  }
  return next.toISOString();
}

/** 校验并归一化触发器配置 */
function normalizeTrigger(input = {}) {
  const type = TRIGGER_LABEL[input.type] ? input.type : 'schedule';
  if (type === 'schedule') {
    // O12：缺省视为 daily（内部默认值语义）；显式传入无效模式一律校验失败
    const mode = input.schedule?.mode === undefined
      ? 'daily'
      : assertEnum(input.schedule.mode, Object.keys(SCHEDULE_MODES), { label: '定时模式' });
    const schedule = { mode };
    if (mode === 'interval') schedule.everyMinutes = clampInt(input.schedule?.everyMinutes, 1, 1440, 30);
    if (mode === 'hourly') schedule.minute = clampInt(input.schedule?.minute, 0, 59, 0);
    if (mode === 'daily') {
      schedule.hour = clampInt(input.schedule?.hour, 0, 23, 9);
      schedule.minute = clampInt(input.schedule?.minute, 0, 59, 0);
    }
    if (mode === 'weekly') {
      schedule.weekday = clampInt(input.schedule?.weekday, 0, 6, 1);
      schedule.hour = clampInt(input.schedule?.hour, 0, 23, 9);
      schedule.minute = clampInt(input.schedule?.minute, 0, 59, 0);
    }
    if (mode === 'once') {
      const at = input.schedule?.at ? new Date(input.schedule.at) : null;
      if (!at || Number.isNaN(at.getTime())) throw fail.validation('请选择「仅一次」的触发时间');
      schedule.at = at.toISOString();
    }
    return { type, schedule };
  }

  if (type === 'event') {
    const source = EVENT_SOURCES[input.event?.source] ? input.event.source : 'task_succeeded';
    const assigneeId = input.event?.assigneeId ? String(input.event.assigneeId) : '';
    if (assigneeId) taskService.resolveAssignee(assigneeId); // 执行者必须存在
    return { type, event: { source, assigneeId } };
  }

  return { type, api: { token: buildApiCredential(input.api?.token) } };
}

/** 判断是否为详情接口（decorate）下发的只读 Token 掩码对象。
 *  掩码形态：{ masked: true, mask, mode }（历史版本无 masked 标记，按「有 mask 无 sealed」兼容识别）；
 *  库内密文形态：{ sealed, mask, mode }；旧版明文为字符串。三者不可混淆。 */
function isMaskedToken(token) {
  return Boolean(
    token &&
      typeof token === 'object' &&
      !token.sealed &&
      (token.masked === true || typeof token.mask === 'string')
  );
}

/** API Token：seal 后落盘（与 IM/连接器凭据同一保险箱标准，不再明文）。
 *  已是加密对象（编辑保留旧 Token）原样透传；兼容读取迁移前的明文字符串。 */
function buildApiCredential(existing) {
  if (existing && typeof existing === 'object' && existing.sealed) return existing;
  if (isMaskedToken(existing)) {
    // 把只读掩码当作新明文 Token 保存的实际效果是「凭据被静默轮换」——最难排查的一类故障，必须显式拒绝
    throw fail.validation('不能把 Token 掩码作为新 Token 保存：请保留原值（省略 token 字段）或重新生成 Token');
  }
  const plain = typeof existing === 'string' && existing ? existing : `vw_${randomBytes(12).toString('hex')}`;
  const sealed = vault.seal(plain);
  return { sealed, mask: vault.mask(plain), mode: sealed.mode };
}

/** 组装 API 触发的调用命令（含明文 Token，仅供主进程写剪贴板，绝不下发渲染层） */
function buildInvocation(id, port) {
  const automation = getOrThrow(id);
  if (automation.trigger.type !== 'api') {
    throw fail.invalidState('仅 API 触发的自动任务可以复制调用命令');
  }
  const token = revealApiToken(automation);
  const base = Number(port) || 17891;
  const payload = JSON.stringify({ goal: '' }).replace(/"/g, String.fromCharCode(92) + '"'); // {"goal":""} → 转义内嵌引号供 shell 使用
  const command = `curl -X POST http://127.0.0.1:${base}/automations/${automation.id}/run -H "X-VirtWorker-Token: ${token}" -H "Content-Type: application/json" -d "${payload}"`;
  return { command, tokenMask: automation.trigger.api?.token?.mask || '' };
}

/** 取明文 Token（仅供主进程校验与复制到剪贴板，绝不下发渲染层）；兼容旧版明文数据 */
function revealApiToken(automation) {
  const token = automation?.trigger?.api?.token;
  if (!token) return '';
  if (typeof token === 'string') return token;
  return vault.open(token.sealed);
}

/** 取通知签名密钥明文（SEC-9，仅供主进程投递签名，绝不下发渲染层）；兼容旧版明文字符串 */
function revealNotifySecret(automation) {
  const secret = automation?.notify?.webhookSecret;
  if (!secret) return '';
  if (typeof secret === 'string') return secret;
  return vault.open(secret.sealed);
}

/** 重新生成 API Token：旧 Token 立即失效（泄漏后的换锁入口），归档一并作废 */
function regenerateToken(id) {
  const automation = getOrThrow(id);
  if (automation.trigger.type !== 'api') throw fail.invalidState('仅 API 触发的自动任务可以重新生成 Token');
  const next = {
    ...automation,
    trigger: { ...automation.trigger, api: { token: buildApiCredential(null) } },
    retiredApiToken: null,
    updatedAt: nowIso()
  };
  db.update('automations', id, next);
  publish(next, 'automation:updated');
  return decorate(next);
}

/** 归一化任务输入模板 */
function normalizeInput(input = {}) {
  const goal = String(input.goal ?? '').trim();
  if (!goal) throw fail.validation('请填写自动任务要执行的目标');
  if (goal.length > 500) throw fail.validation('任务目标最多 500 字');
  return {
    goal,
    workspace: String(input.workspace ?? '').trim(),
    priority: ['low', 'normal', 'high', 'urgent'].includes(input.priority) ? input.priority : 'normal',
    confirmFirst: Boolean(input.confirmFirst)
  };
}

/** 出站通知配置（F2）：任务终态时向 webhookUrl POST 结构化事件（由 runtime/webhook-notifier 投递）。
 *  webhookSecret（SEC-9）可选：请求签名密钥，字符串经 vault.seal 落库（与 API Token 同一保险箱标准）；
 *  库内密文对象（合并路径未轮换时）原样透传；空值清除。decorate 只下发掩码形态。 */
function normalizeNotify(input = {}) {
  const url = String(input?.webhookUrl ?? '').trim().slice(0, 500);
  if (!url) return { webhookUrl: '', webhookSecret: '' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw fail.validation('Webhook 地址不是合法的 URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw fail.validation('Webhook 地址必须以 http:// 或 https:// 开头');
  }
  if (parsed.username || parsed.password) {
    throw fail.validation('Webhook 地址不应携带账号密码（请在接收端校验签名）');
  }
  let webhookSecret = '';
  const rawSecret = input?.webhookSecret;
  if (rawSecret && typeof rawSecret === 'object' && rawSecret.sealed) {
    webhookSecret = rawSecret; // 既有密文透传：合并路径中未提供新密钥即保留
  } else if (typeof rawSecret === 'string' && rawSecret.trim()) {
    const plain = rawSecret.trim().slice(0, 200);
    const sealed = vault.seal(plain);
    webhookSecret = { sealed, mask: vault.mask(plain), mode: sealed.mode };
  }
  return { webhookUrl: parsed.href, webhookSecret };
}

function listAll() {
  return db.all('automations');
}

/** 按 id 读取（B1 免全集合克隆）：找不到返回 null（getOrThrow 的无异常版），
 *  供 http-server 每请求鉴权与 webhook 通知等热路径使用 */
function findById(id) {
  return db.find('automations', id);
}

function getOrThrow(id) {
  const automation = db.find('automations', id);
  if (!automation) throw fail.notFound('自动任务不存在');
  return automation;
}

function decorate(automation) {
  // retiredApiToken 是归档的 Token 密文（触发类型切离 api 时保留），绝不下发渲染层
  const { retiredApiToken, ...rest } = automation;
  const isApi = rest.trigger.type === 'api';
  // API Token 的密文/明文都不下发渲染层，只给掩码（复制调用命令经专用通道在主进程完成）；
  // masked 标记声明这是只读对象：客户端原样回传时等价于「保留现有 Token」，不会被当作新明文
  const trigger = isApi
    ? {
        ...rest.trigger,
        api: {
          masked: true,
          mask: rest.trigger.api?.token?.mask || '',
          mode: rest.trigger.api?.token?.mode || ''
        }
      }
    : rest.trigger;
  // 通知签名密钥同款掩码（SEC-9）：密文绝不出库，掩码回传等价于保留
  const notify =
    rest.notify?.webhookSecret && rest.notify.webhookSecret.sealed
      ? {
          ...rest.notify,
          webhookSecret: {
            masked: true,
            mask: rest.notify.webhookSecret.mask || '',
            mode: rest.notify.webhookSecret.mode || ''
          }
        }
      : rest.notify;
  return {
    ...rest,
    notify,
    trigger,
    triggerLabel: TRIGGER_LABEL[rest.trigger.type],
    triggerText: describeTrigger(rest.trigger),
    tokenMask: isApi ? rest.trigger.api?.token?.mask || '' : '',
    /** 端点信息只在 API 触发时下发给界面，便于用户复制 */
    endpoint: isApi ? `/automations/${rest.id}/run` : null
  };
}

function publish(automation, eventType) {
  bus.emit(eventType, decorate(automation));
  bus.command('automation:changed', automation.id);
}

// ==================== 查询 ====================

function list(filter = {}) {
  let items = listAll();
  const keyword = String(filter.keyword ?? '').trim().toLowerCase();
  if (keyword) {
    items = items.filter((item) => `${item.name} ${item.desc} ${item.input.goal}`.toLowerCase().includes(keyword));
  }
  if (filter.executorId) {
    items = items.filter((item) => item.executor.id === filter.executorId);
  }
  const triggerType = TRIGGER_LABEL[filter.triggerType] ? filter.triggerType : null;
  if (triggerType) items = items.filter((item) => item.trigger.type === triggerType);

  const enabled = STATUS_FILTER[filter.status];
  if (enabled !== undefined) items = items.filter((item) => item.enabled === enabled);

  // 排序枚举（O12）：'' = 最近创建（默认），'updated' = 最近更新
  const sortByUpdated = filter.sort === 'updated';
  items = [...items].sort((a, b) =>
    sortByUpdated ? b.updatedAt.localeCompare(a.updatedAt) : b.createdAt.localeCompare(a.createdAt)
  );
  return { items: items.map(decorate), total: items.length };
}

function stats() {
  const items = listAll();
  return {
    total: items.length,
    enabled: items.filter((item) => item.enabled).length,
    workerCount: items.filter((item) => item.executor.type !== 'flow').length,
    flowCount: items.filter((item) => item.executor.type === 'flow').length
  };
}

function detail(id) {
  const automation = getOrThrow(id);
  return {
    automation: decorate(automation),
    runs: taskService.list({ refId: id, period: '', limit: 20 }).items
  };
}

// ==================== 增删改 ====================

function create(params = {}) {
  const name = requiredText(params.name, { label: '自动任务名称', max: 40 });
  assertUniqueName((candidate) => db.exists('automations', (a) => a.name === candidate), name, {
    label: '自动任务'
  });

  const executor = taskService.resolveAssignee(params.executorId);
  const trigger = normalizeTrigger(params.trigger);

  const automation = {
    id: createId('at'),
    name,
    desc: optionalText(params.desc, 100),
    enabled: params.enabled === undefined ? true : Boolean(params.enabled),
    trigger,
    executor: { type: executor.type, id: executor.id, name: executor.name },
    input: normalizeInput(params.input),
    notify: normalizeNotify(params.notify),
    lastRunAt: null,
    lastTaskId: null,
    runCount: 0,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  automation.nextRunAt = automation.enabled ? computeNextRun(trigger, new Date(), automation.id) : null;

  db.insert('automations', automation);
  publish(automation, 'automation:created');
  return decorate(automation);
}

function update(id, patch = {}) {
  const automation = getOrThrow(id);
  const next = { ...automation };

  if (patch.name !== undefined) {
    const name = requiredText(patch.name, { label: '自动任务名称', max: 40 });
    assertUniqueName((candidate) => db.exists('automations', (a) => a.name === candidate && a.id !== id), name, {
      label: '自动任务',
      exceptId: id
    });
    next.name = name;
  }
  if (patch.desc !== undefined) next.desc = optionalText(patch.desc, 100);
  if (patch.input !== undefined) next.input = normalizeInput({ ...automation.input, ...patch.input });
  if (patch.notify !== undefined) {
    const incomingNotify = { ...patch.notify };
    // 只读掩码回传 = 保留现有签名密钥（SEC-9，与 API Token 的 O6 契约同款语义）：
    // 若把掩码对象合并进 normalizeNotify，会被当作垃圾值清空既有密钥
    if (isMaskedToken(incomingNotify.webhookSecret)) delete incomingNotify.webhookSecret;
    next.notify = normalizeNotify({ ...automation.notify, ...incomingNotify });
  }
  if (patch.executorId !== undefined) {
    const executor = taskService.resolveAssignee(patch.executorId);
    next.executor = { type: executor.type, id: executor.id, name: executor.name };
  }
  if (patch.trigger !== undefined) {
    const incoming = { ...patch.trigger };
    if (isMaskedToken(incoming.api?.token)) {
      // 客户端把详情接口下发的只读掩码原样回传（「编辑→原样保存」的常规客户端模式）：
      // 等价于「保留现有 Token」，绝不能当作新明文走 seal（那会静默轮换凭据）
      incoming.api = automation.trigger.api;
    }
    // 触发类型切离 api：归档旧 Token 密文，避免切换即凭据丢失
    if (automation.trigger.type === 'api' && incoming.type !== 'api') {
      next.retiredApiToken = automation.trigger.api?.token || null;
    }
    // 切回 api 且未提供新 Token：优先恢复归档的旧 Token（此时库内已无现役 api 配置，
    // 不恢复的话 buildApiCredential 会静默生成新 Token，上游调用方全部 401）
    if (incoming.type === 'api' && automation.trigger.type !== 'api') {
      if (incoming.api?.token) {
        next.retiredApiToken = null; // 显式提供了新 Token，归档作废
      } else if (automation.retiredApiToken) {
        incoming.api = { token: automation.retiredApiToken };
        next.retiredApiToken = null;
      }
    }
    // 保留已有 API Token，避免编辑时静默更换凭据
    next.trigger = normalizeTrigger({ api: automation.trigger.api, ...incoming });
  }
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);

  next.nextRunAt = next.enabled ? computeNextRun(next.trigger, new Date(), next.id) : null;
  next.updatedAt = nowIso();

  db.update('automations', id, next);
  publish(next, 'automation:updated');
  return decorate(next);
}

function toggle(id, enabled) {
  return update(id, { enabled });
}

function remove(id) {
  getOrThrow(id);
  db.remove('automations', id);
  bus.emit('automation:removed', { id });
  bus.command('automation:changed', id);
  return { id };
}

/**
 * 停用执行者已失效的自动任务：删除 Worker / 删除或清空 Group / 删除 Flow 的统一级联入口。
 * 失效自动化若保持启用，调度器每次触发都会失败且用户无感知（「启用中却永不成功」的静默故障态），
 * 必须显式停用并通知。返回被停用的自动化 id 列表（供删除接口回传与测试断言）。
 */
function disableByExecutor(matcher = {}, reason = '') {
  const groupIds = Array.isArray(matcher.groupIds) ? matcher.groupIds : matcher.groupId ? [matcher.groupId] : [];
  const disabled = [];
  listAll()
    .filter((automation) => {
      if (!automation.enabled) return false;
      const executor = automation.executor || {};
      if (matcher.workerId && executor.type === 'worker' && executor.id === matcher.workerId) return true;
      if (groupIds.length && executor.type === 'group' && groupIds.includes(executor.id)) return true;
      if (matcher.flowId && executor.type === 'flow' && executor.id === matcher.flowId) return true;
      return false;
    })
    .forEach((automation) => {
      update(automation.id, { enabled: false });
      bus.emit('app:notice', {
        level: 'warning',
        title: `自动任务「${automation.name}」已停用`,
        body: reason || '其执行者已失效，请重新指定执行者后再启用'
      });
      disabled.push(automation.id);
    });
  return disabled;
}

// ==================== 运行时回调 ====================

/** 触发成功后推进计划：记录运行次数、最近运行时间与下次触发时间 */
function markFired(id, taskId, meta = {}) {
  const automation = getOrThrow(id);
  const isOnce = automation.trigger.type === 'schedule' && automation.trigger.schedule.mode === 'once';
  // interval 从「计划触发时刻」起算下次时间，避免每次顺延导致周期逐渐漂移；
  // hourly/daily/weekly 锚定墙上时钟无漂移，保持从当前时刻起算。
  // 长停机追赶上限：计划触发点落后已超过一个完整间隔（应用停开数天后补跑的形态）时，
  // 不再以过期时刻为基准逐周期补账——那会让调度器以最小定时器间隔连续触发制造任务洪峰，
  // 而是直接以当前时刻重排，保证「错过的只补本次这一次」
  const previousDue = automation.nextRunAt ? new Date(automation.nextRunAt) : null;
  let base;
  if (automation.trigger.schedule?.mode === 'interval' && previousDue && !Number.isNaN(previousDue.getTime())) {
    const everyMs = clampInt(automation.trigger.schedule.everyMinutes, 1, 1440, 30) * 60 * 1000;
    base = previousDue.getTime() + everyMs > Date.now() ? previousDue : undefined;
  }
  const next = {
    ...automation,
    lastRunAt: nowIso(),
    lastTaskId: taskId,
    lastRunReason: meta.reason || null,
    runCount: (automation.runCount || 0) + 1,
    enabled: isOnce ? false : automation.enabled, // 仅一次的自动任务触发后自动停用
    nextRunAt: isOnce ? null : computeNextRun(automation.trigger, base, automation.id),
    updatedAt: nowIso()
  };
  db.update('automations', id, next);
  bus.emit('automation:updated', decorate(next));
  return decorate(next);
}

/** 跳过错过的触发：仅把计划推进到下一次，不计入运行次数（用于关闭「补跑」时） */
function advanceSchedule(id) {
  const automation = getOrThrow(id);
  const next = { ...automation, nextRunAt: computeNextRun(automation.trigger, new Date(), automation.id), updatedAt: nowIso() };
  // 「仅一次」已过期且补跑关闭时不再有下次触发：自动停用，避免"启用中却永不触发"的死配置
  if (
    next.enabled &&
    !next.nextRunAt &&
    next.trigger.type === 'schedule' &&
    next.trigger.schedule?.mode === 'once'
  ) {
    next.enabled = false;
    bus.emit('app:notice', {
      level: 'warning',
      title: `自动任务「${automation.name}」已停用`,
      body: '触发时间已过且补跑未开启，不再调度'
    });
  }
  db.update('automations', id, next);
  bus.emit('automation:updated', decorate(next));
  return decorate(next);
}

/** 计划内待触发的定时自动任务（已到期且启用）。
 *  where 结构化匹配（B1）：只克隆「启用中的定时型」，调度器 tick 的周期性读取不再全量深拷贝 */
function dueSchedules(now = Date.now()) {
  return db
    .where('automations', { enabled: true, 'trigger.type': 'schedule' })
    .filter(
      (item) =>
        item.nextRunAt && new Date(item.nextRunAt).getTime() <= now
    );
}

/** 最早的定时触发时间，供调度器决定下一次唤醒（where 只克隆定时型条目，B1） */
function earliestNextRun() {
  const times = db
    .where('automations', { enabled: true, 'trigger.type': 'schedule' })
    .map((item) => (item.nextRunAt ? new Date(item.nextRunAt).getTime() : Number.NaN))
    .filter((time) => !Number.isNaN(time));
  return times.length ? Math.min(...times) : null;
}

/** 事件触发器：匹配指定事件源且启用的自动任务 */
function listEnabledByEvent(source) {
  return listAll().filter(
    (item) => item.enabled && item.trigger.type === 'event' && item.trigger.event.source === source
  );
}

module.exports = {
  TRIGGER_LABEL,
  SCHEDULE_MODES,
  EVENT_SOURCES,
  WEEKDAY_LABEL,
  computeNextRun,
  describeTrigger,
  list,
  listAll,
  findById,
  stats,
  detail,
  create,
  update,
  toggle,
  remove,
  disableByExecutor,
  markFired,
  advanceSchedule,
  dueSchedules,
  earliestNextRun,
  listEnabledByEvent,
  regenerateToken,
  revealApiToken,
  revealNotifySecret,
  buildInvocation
};