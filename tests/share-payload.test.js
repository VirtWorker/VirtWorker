/**
 * 资源包深校验测试（对应优化项 #11）
 * 验证 validatePayload 对畸形/超大结构的拒绝，与合法包的通过。
 */

import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shareService = require('../main/services/share-service');
const { validatePayload } = shareService;

const validWorker = {
  kind: 'virtworker.resource',
  version: 1,
  resourceType: 'worker',
  resource: { name: '小助手', role: '通用助理', env: 'local', desc: '' },
  capabilities: []
};
const validFlow = {
  kind: 'virtworker.resource',
  version: 1,
  resourceType: 'flow',
  resource: { name: '流程A', desc: '' },
  nodes: [{ title: '步骤', instruction: '做事', workerName: '小助手' }]
};

describe('share validatePayload', () => {
  test('合法 Worker / Flow 包通过', () => {
    expect(() => validatePayload(validWorker)).not.toThrow();
    expect(() => validatePayload(validFlow)).not.toThrow();
  });

  test('缺少 resource / 类型错误被拒绝', () => {
    expect(() => validatePayload({ ...validWorker, resource: undefined })).toThrow(/resource/);
    expect(() => validatePayload({ ...validWorker, resource: 'str' })).toThrow(/resource/);
    expect(() => validatePayload({ ...validWorker, resource: { name: 123 } })).toThrow(/name/);
  });

  test('worker 缺 capabilities / flow 缺 nodes 被拒绝', () => {
    expect(() => validatePayload({ ...validWorker, capabilities: undefined })).toThrow(/capabilities/);
    expect(() => validatePayload({ ...validFlow, nodes: undefined })).toThrow(/nodes/);
  });

  test('超大数组被拒绝', () => {
    const huge = Array.from({ length: 100 }, () => ({}));
    expect(() => validatePayload({ ...validFlow, nodes: huge })).toThrow(/节点/);
    expect(() => validatePayload({ ...validWorker, capabilities: huge })).toThrow(/能力/);
  });

  test('nodes / capabilities 元素为 null 或数组等畸形结构被拒绝', () => {
    expect(() => validatePayload({ ...validFlow, nodes: [null] })).toThrow(/节点格式/);
    expect(() => validatePayload({ ...validFlow, nodes: [['x']] })).toThrow(/节点格式/);
    expect(() => validatePayload({ ...validFlow, nodes: ['字符串节点'] })).toThrow(/节点格式/);
    expect(() => validatePayload({ ...validWorker, capabilities: [null] })).toThrow(/能力清单格式/);
  });

  test('kind / version / resourceType 基础校验仍生效', () => {
    expect(() => validatePayload({ ...validWorker, kind: 'other' })).toThrow(/标识/);
    expect(() => validatePayload({ ...validWorker, version: 99 })).toThrow(/版本/);
    expect(() => validatePayload({ ...validWorker, resourceType: 'skill' })).toThrow(/不支持/);
  });

  test('version 非整数 / 0 / 负数 / 缺失被拒绝（BUG-39，此前 NaN 全部放行）', () => {
    expect(() => validatePayload({ ...validWorker, version: Number.NaN })).toThrow(/版本/);
    expect(() => validatePayload({ ...validWorker, version: 0 })).toThrow(/版本/);
    expect(() => validatePayload({ ...validWorker, version: -1 })).toThrow(/版本/);
    expect(() => validatePayload({ ...validWorker, version: '1' })).toThrow(/版本/);
    expect(() => validatePayload({ ...validWorker, version: undefined })).toThrow(/版本/);
  });
});
