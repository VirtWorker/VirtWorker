/**
 * 资源包能力引用重映射测试（对应优化项 #17b）
 * 验证：导出 flow 携带 capabilityRefs；导入时按名称映射为本机 ID，匹配不到产生警告。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initTempDb, cleanupTempDb, db, shareService, workerService } from './setup.js';

let dir;

beforeAll(() => {
  dir = initTempDb();
});

afterAll(() => {
  cleanupTempDb(dir);
});

describe('flow 资源包 capabilityRefs', () => {
  beforeEach(() => {
    ['workers', 'flows', 'capabilities'].forEach((name) => db.removeWhere(name, () => true));
  });

  test('导出的节点携带能力名称引用', () => {
    const worker = workerService.createWorker({ name: '编排者' });
    db.insert('capabilities', { id: 'cp_local', type: 'skill', title: '网页搜索', connectorKey: null });
    db.insert('flows', {
      id: 'fl_test',
      name: '测试流程',
      desc: '',
      nodes: [{ id: 'nd_1', title: '步骤1', workerId: worker.id, instruction: '做事', capabilityIds: ['cp_local'] }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const payload = shareService.buildFlowPayload('fl_test');
    expect(payload.nodes[0].capabilityRefs).toEqual([{ title: '网页搜索', type: 'skill', connectorKey: null }]);
  });

  test('导入时 refs 映射为本机 ID；未安装能力产生警告', () => {
    workerService.createWorker({ name: '编排者' });
    db.insert('capabilities', { id: 'cp_other', type: 'skill', title: '网页搜索', connectorKey: null });

    const payload = {
      kind: 'virtworker.resource',
      version: 1,
      resourceType: 'flow',
      resource: { name: '跨设备流程', desc: '' },
      nodes: [
        {
          title: '步骤1',
          instruction: '做事',
          workerName: '编排者',
          capabilityRefs: [
            { title: '网页搜索', type: 'skill', connectorKey: null },
            { title: '未安装能力', type: 'skill', connectorKey: null }
          ]
        }
      ]
    };

    const result = shareService.importPayload(payload);
    expect(result.type).toBe('flow');
    expect(result.flow.nodes[0].capabilityIds).toEqual(['cp_other']);
    expect(result.warnings.some((w) => w.includes('未安装能力'))).toBe(true);
  });

  test('旧包（无 refs）退回按本机 ID 过滤', () => {
    workerService.createWorker({ name: '编排者' });
    db.insert('capabilities', { id: 'cp_keep', type: 'skill', title: '保留', connectorKey: null });

    const payload = {
      kind: 'virtworker.resource',
      version: 1,
      resourceType: 'flow',
      resource: { name: '旧版流程', desc: '' },
      nodes: [
        {
          title: '步骤1',
          instruction: '做事',
          workerName: '编排者',
          capabilityIds: ['cp_keep', 'cp_missing']
        }
      ]
    };

    const result = shareService.importPayload(payload);
    expect(result.flow.nodes[0].capabilityIds).toEqual(['cp_keep']);
  });
});
