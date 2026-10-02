/**
 * capability-service 领域服务测试（D1 测试补缺）
 * 覆盖：技能安装/卸载与挂载校验链、连接器授权/撤销（凭据不出服务层）、
 * Worker 能力分组解析（resolveWorkerCapabilities）与 detachFromWorkers 摘除。
 * 能力挂载是执行器注入（executor-llm / mock 的能力上下文）的数据源，回归此前无防护。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { initTempDb, cleanupTempDb, db, workerService, bus } from './setup.js';

const require = createRequire(import.meta.url);
const capabilityService = require('../main/services/capability-service');
const flowService = require('../main/services/flow-service');
const { SKILL_CATALOG } = require('../main/data/skill-catalog');

let dir;

beforeAll(() => {
  dir = initTempDb();
});

afterAll(() => {
  cleanupTempDb(dir);
});

describe('capability-service：Skill 安装与挂载校验链', () => {
  let worker;

  beforeEach(() => {
    ['workers', 'capabilities', 'chunks'].forEach((name) => db.removeWhere(name, () => true));
    worker = workerService.createWorker({ name: '能力测试者' });
  });

  test('installSkill：安装目录中的技能并标记市场状态', () => {
    const skillId = SKILL_CATALOG[0].id;
    const installed = capabilityService.installSkill(skillId);
    expect(installed.type).toBe('skill');
    expect(installed.skillId).toBe(skillId);
    expect(installed.status).toBe('installed');

    const market = capabilityService.skillMarket();
    expect(market.items.find((item) => item.id === skillId).installed).toBe(true);
  });

  test('重复安装返回 CONFLICT，未知技能返回 NOT_FOUND', () => {
    const skillId = SKILL_CATALOG[0].id;
    capabilityService.installSkill(skillId);
    expect(() => capabilityService.installSkill(skillId)).toThrow(/已安装/);
    expect(() => capabilityService.installSkill('cp_no_such')).toThrow(/不存在/);
  });

  test('挂载校验链：Worker 只能挂载已存在的能力', () => {
    const installed = capabilityService.installSkill(SKILL_CATALOG[0].id);
    workerService.updateWorker(worker.id, { capabilityIds: [installed.id] });
    expect(capabilityService.mountedWorkers(installed.id)).toBe(1);
    // 已卸载的能力不可挂载（原「静默清空」危险默认值的校验路径）
    expect(() => workerService.updateWorker(worker.id, { capabilityIds: ['cp_ghost'] })).toThrow(/已卸载/);
  });

  test('uninstall：从所有 Worker 摘除后删除能力本体', () => {
    const installed = capabilityService.installSkill(SKILL_CATALOG[0].id);
    workerService.updateWorker(worker.id, { capabilityIds: [installed.id] });

    capabilityService.uninstall(installed.id);

    const detached = workerService.getWorker(worker.id);
    expect(detached.capabilityIds).toEqual([]);
    expect(capabilityService.resolveWorkerCapabilities(worker.id).skills).toEqual([]);
    expect(() => workerService.updateWorker(worker.id, { capabilityIds: [installed.id] })).toThrow(/已卸载/);
  });
});

describe('capability-service：连接器授权与撤销', () => {
  beforeEach(() => {
    ['workers', 'capabilities'].forEach((name) => db.removeWhere(name, () => true));
  });

  test('authorizeConnector：凭据加密落库，对外仅暴露掩码', () => {
    const decorated = capabilityService.authorizeConnector('feishu', { secret: 'tdd-secret-token-123456' });
    expect(decorated.status).toBe('authorized');
    expect(decorated.credentialMask).toContain('•'); // 掩码形态（••••尾号）
    expect(decorated.credentialMask).not.toContain('tdd-secret');
    // 密文不出服务层：装饰结果不含 credential 字段
    expect('credential' in decorated).toBe(false);

    const stored = db.find('capabilities', decorated.id);
    expect(stored.credential.sealed).toBeTruthy(); // 库内为 seal 后密文形态
    expect(JSON.stringify(stored)).not.toContain('tdd-secret-token-123456');

    const catalog = capabilityService.connectorCatalog();
    expect(catalog.find((item) => item.key === 'feishu').status).toBe('authorized');
  });

  test('重复授权复用同一条能力记录（更新凭据而非新建）', () => {
    const first = capabilityService.authorizeConnector('feishu', { secret: 'token-a' });
    const second = capabilityService.authorizeConnector('feishu', { secret: 'token-b' });
    expect(second.id).toBe(first.id);
    expect(capabilityService.list({ type: 'connector' }).length).toBe(1);
  });

  test('缺少凭据被校验拦截，未知连接器返回 NOT_FOUND', () => {
    expect(() => capabilityService.authorizeConnector('feishu', {})).toThrow(/凭据/);
    expect(() => capabilityService.authorizeConnector('no_such', { secret: 'x' })).toThrow(/不存在/);
  });

  test('revokeConnector：状态回到未授权、凭据清空；非连接器类型拒绝撤销', () => {
    const authorized = capabilityService.authorizeConnector('github', { secret: 'ghp_test' });
    const revoked = capabilityService.revokeConnector(authorized.id);
    expect(revoked.status).toBe('unauthorized');

    const stored = db.find('capabilities', authorized.id);
    expect(stored.credential).toBeNull();
    // 未授权连接器不进入执行器注入分组
    workerService.createWorker({ name: '撤销测试者' });

    const skill = capabilityService.installSkill(SKILL_CATALOG[0].id);
    expect(() => capabilityService.revokeConnector(skill.id)).toThrow(/不是连接器/);
  });
});

describe('capability-service：resolveWorkerCapabilities 分组与摘除', () => {
  let worker;

  beforeEach(() => {
    ['workers', 'capabilities'].forEach((name) => db.removeWhere(name, () => true));
    worker = workerService.createWorker({ name: '分组测试者' });
  });

  test('按类型分组，未授权连接器不进入 connectors', () => {
    const skill = capabilityService.installSkill(SKILL_CATALOG[0].id);
    const connector = capabilityService.authorizeConnector('slack', { secret: 'xoxb-test' });
    workerService.updateWorker(worker.id, { capabilityIds: [skill.id, connector.id] });

    const resolved = capabilityService.resolveWorkerCapabilities(worker.id);
    expect(resolved.skills.map((item) => item.id)).toEqual([skill.id]);
    expect(resolved.connectors.map((item) => item.id)).toEqual([connector.id]);
    expect(resolved.knowledge).toEqual([]);

    // 撤销授权后连接器不再注入执行器
    capabilityService.revokeConnector(connector.id);
    expect(capabilityService.resolveWorkerCapabilities(worker.id).connectors).toEqual([]);
  });

  test('Worker 不存在时返回空分组（不抛错，执行器注入路径容错）', () => {
    const resolved = capabilityService.resolveWorkerCapabilities('wk_ghost');
    expect(resolved).toEqual({ skills: [], connectors: [], knowledge: [] });
  });

  test('detachFromWorkers：能力删除路径从全部 Worker 摘除并广播 worker:updated', () => {
    const skill = capabilityService.installSkill(SKILL_CATALOG[0].id);
    const other = workerService.createWorker({ name: '另一个挂载者' });
    workerService.updateWorker(worker.id, { capabilityIds: [skill.id] });
    workerService.updateWorker(other.id, { capabilityIds: [skill.id] });

    const events = [];
    const off = bus.on ? bus.on('worker:updated', (payload) => events.push(payload.id)) : null;
    capabilityService.uninstall(skill.id);
    if (off) off();

    expect(workerService.getWorker(worker.id).capabilityIds).toEqual([]);
    expect(workerService.getWorker(other.id).capabilityIds).toEqual([]);
    expect(events.length).toBe(2);
  });
});

describe('capability-service：Flow 节点引用摘除（BUG-38）', () => {
  beforeEach(() => {
    ['workers', 'capabilities', 'chunks', 'flows'].forEach((name) => db.removeWhere(name, () => true));
  });

  test('卸载能力时从所有流程节点摘除引用并广播 flow:updated', () => {
    const skill = capabilityService.installSkill(SKILL_CATALOG[0].id);
    const nodeWorker = workerService.createWorker({ name: '流程节点工' });
    const flow = flowService.create({
      name: '引用摘除流程',
      nodes: [{ workerId: nodeWorker.id, instruction: '用技能干活', capabilityIds: [skill.id] }]
    });
    expect(db.find('flows', flow.id).nodes[0].capabilityIds).toEqual([skill.id]);

    const events = [];
    const off = bus.on('flow:updated', (payload) => events.push(payload.id));
    capabilityService.uninstall(skill.id);
    off();

    // 修复前：Flow 节点的 capabilityIds 悬空，buildPlan 会把已删除能力带进执行上下文
    expect(db.find('flows', flow.id).nodes[0].capabilityIds).toEqual([]);
    expect(events).toContain(flow.id);
  });
});
