/**
 * 自动任务（Automation）领域服务
 * 职责：定时/事件/API 三类触发器的配置校验、下次触发时间推算、启停与增删改查、统计。
 * 说明：本服务只负责「配置与计划」，实际触发时机由 runtime/scheduler 决定；
 *       触发后统一调用 task-service 创建任务，与手动创建共用同一套执行链路。
 */

const { randomBytes } = require('node:crypto');
const db = require('../store/db');
const bus = require('../runtime/event-bus');
const taskService = require('./task-service');
const { createId } = require('../util/id');
const { nowIso } = require('../util/time');
const { fail } = require('../util/errors');

const TRIGGER_LABEL = { schedule: '定时', event: '事件', api: 'API' };
/** 界面筛选/展示用（与 index.html 中的 option 文本对应） */
const TRIGGER_FILTER = { 定时: 'schedule', 事件: 'event', API: 'api' };

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

const STATUS_FILTER = { 已启用: true, 已停用: false };

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

/**
 * 推算下次触发时间（纯函数，无副作用）
 * 定时器只用到毫秒级精度，故全部按本地时间计算。
 */
function computeNextRun(trigger, from = new Date()) {
  if (!trigger || trigger.type !== 'schedule') return null;
  const schedule = trigger.schedule || {};
  const base = new Date(from.getTime());

  switch (schedule.mode) {
    case 'interval': {
      const minutes = clampInt(schedule.everyMinutes, 1, 1440, 30);
      return new Date(base.getTime() + minutes * 60 * 1000).toISOString();
    }
    case 'hourly': {
      const next = new Date(base);
      next.setSeconds(0, 0);
      next.setMinutes(clampInt(schedule.minute, 0, 59, 0));
      if (next.getTime() <= base.getTime()) next.setHours(next.getHours() + 1);
      return next.toISOString();
    }
    case 'daily': {
      const next = new Date(base);
      next.setHours(clampInt(schedule.hour, 0, 23, 9), clampInt(schedule.minute, 0, 59, 0), 0, 0);
      if (next.getTime() <= base.getTime()) next.setDate(next.getDate() + 1);
      return next.toISOString();
    }
    case 'weekly': {
      const next = new Date(base);
      next.setHours(clampInt(schedule.hour, 0, 23, 9), clampInt(schedule.minute, 0, 59, 0), 0, 0);
      let delta = (clampInt(schedule.weekday, 0, 6, 1) - next.getDay() + 7) % 7;
      if (delta === 0 && next.getTime() <= base.getTime()) delta = 7;
      next.setDate(next.getDate() + delta);
      return next.toISOString();
    }
    case 'once': {
      const at = schedule.at ? new Date(schedule.at) : null;
      if (!at || Number.isNaN(at.getTime()) || at.getTime() <= base.getTime()) return null;
      return at.toISOString();
    }
    default:
      return null;
  }
}

/** 校验并归一化触发器配置 */
function normalizeTrigger(input = {}) {
  const type = TRIGGER_LABEL[input.type] ? input.type : 'schedule';
  if (type === 'schedule') {
    const mode = SCHEDULE_MODES[input.schedule?.mode] ? input.schedule.mode : 'daily';
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

  return { type, api: { token: input.api?.token || `vw_${randomBytes(12).toString('hex')}` } };
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

function listAll() {
  return db.all('automations');
}

function getOrThrow(id) {
  const automation = db.find('automations', id);
  if (!automation) throw fail.notFound('自动任务不存在');
  return automation;
}

function decorate(automation) {
  return {
    ...automation,
    triggerLabel: TRIGGER_LABEL[automation.trigger.type],
    triggerText: describeTrigger(automation.trigger),
    /** 端点信息只在 API 触发时下发给界面，便于用户复制 */
    endpoint: automation.trigger.type === 'api' ? `/automations/${automation.id}/run` : null
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
  if (filter.executorId && filter.executorId !== '全部执行者') {
    items = items.filter((item) => item.executor.id === filter.executorId);
  }
  const triggerType = TRIGGER_FILTER[filter.triggerType] || (TRIGGER_LABEL[filter.triggerType] ? filter.triggerType : null);
  if (triggerType) items = items.filter((item) => item.trigger.type === triggerType);

  const enabled = STATUS_FILTER[filter.status];
  if (enabled !== undefined) items = items.filter((item) => item.enabled === enabled);

  const sort = filter.sort || '最近创建';
  items = [...items].sort((a, b) =>
    sort === '最近更新' ? b.updatedAt.localeCompare(a.updatedAt) : b.createdAt.localeCompare(a.createdAt)
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
  const name = String(params.name ?? '').trim();
  if (!name) throw fail.validation('请填写自动任务名称');
  if (name.length > 40) throw fail.validation('名称最多 40 个字符');
  if (listAll().some((item) => item.name === name)) throw fail.conflict(`已存在同名自动任务「${name}」`);

  const executor = taskService.resolveAssignee(params.executorId);
  const trigger = normalizeTrigger(params.trigger);

  const automation = {
    id: createId('at'),
    name,
    desc: String(params.desc ?? '').trim().slice(0, 100),
    enabled: params.enabled === undefined ? true : Boolean(params.enabled),
    trigger,
    executor: { type: executor.type, id: executor.id, name: executor.name },
    input: normalizeInput(params.input),
    lastRunAt: null,
    lastTaskId: null,
    runCount: 0,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  automation.nextRunAt = automation.enabled ? computeNextRun(trigger) : null;

  db.insert('automations', automation);
  publish(automation, 'automation:created');
  return decorate(automation);
}

function update(id, patch = {}) {
  const automation = getOrThrow(id);
  const next = { ...automation };

  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw fail.validation('请填写自动任务名称');
    if (listAll().some((item) => item.id !== id && item.name === name)) {
      throw fail.conflict(`已存在同名自动任务「${name}」`);
    }
    next.name = name;
  }
  if (patch.desc !== undefined) next.desc = String(patch.desc).trim().slice(0, 100);
  if (patch.input !== undefined) next.input = normalizeInput({ ...automation.input, ...patch.input });
  if (patch.executorId !== undefined) {
    const executor = taskService.resolveAssignee(patch.executorId);
    next.executor = { type: executor.type, id: executor.id, name: executor.name };
  }
  if (patch.trigger !== undefined) {
    // 保留已有 API Token，避免编辑时静默更换凭据
    next.trigger = normalizeTrigger({ api: automation.trigger.api, ...patch.trigger });
  }
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);

  next.nextRunAt = next.enabled ? computeNextRun(next.trigger) : null;
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

// ==================== 运行时回调 ====================

/** 触发成功后推进计划：记录运行次数、最近运行时间与下次触发时间 */
function markFired(id, taskId, meta = {}) {
  const automation = getOrThrow(id);
  const isOnce = automation.trigger.type === 'schedule' && automation.trigger.schedule.mode === 'once';
  const next = {
    ...automation,
    lastRunAt: nowIso(),
    lastTaskId: taskId,
    lastRunReason: meta.reason || null,
    runCount: (automation.runCount || 0) + 1,
    enabled: isOnce ? false : automation.enabled, // 仅一次的自动任务触发后自动停用
    nextRunAt: isOnce ? null : computeNextRun(automation.trigger),
    updatedAt: nowIso()
  };
  db.update('automations', id, next);
  bus.emit('automation:updated', decorate(next));
  return decorate(next);
}

/** 跳过错过的触发：仅把计划推进到下一次，不计入运行次数（用于关闭「补跑」时） */
function advanceSchedule(id) {
  const automation = getOrThrow(id);
  const next = { ...automation, nextRunAt: computeNextRun(automation.trigger), updatedAt: nowIso() };
  db.update('automations', id, next);
  bus.emit('automation:updated', decorate(next));
  return decorate(next);
}

/** 计划内待触发的定时自动任务（已到期且启用） */
function dueSchedules(now = Date.now()) {
  return listAll().filter(
    (item) =>
      item.enabled &&
      item.trigger.type === 'schedule' &&
      item.nextRunAt &&
      new Date(item.nextRunAt).getTime() <= now
  );
}

/** 最早的定时触发时间，供调度器决定下一次唤醒 */
function earliestNextRun() {
  const times = listAll()
    .filter((item) => item.enabled && item.trigger.type === 'schedule' && item.nextRunAt)
    .map((item) => new Date(item.nextRunAt).getTime())
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
  stats,
  detail,
  create,
  update,
  toggle,
  remove,
  markFired,
  advanceSchedule,
  dueSchedules,
  earliestNextRun,
  listEnabledByEvent
};