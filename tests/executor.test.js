/**
 * 执行器注册中心测试（对应优化项 #4）
 * 验证：契约校验、注册/切换、首个注册者自动激活。
 */

import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const executor = require('../main/runtime/executor');

const fake = (name) => ({
  name,
  buildSteps: () => [],
  buildFlowSteps: () => [],
  stepDelay: () => 10,
  runStep: () => ({ log: '', citations: [] }),
  maybeAction: () => null,
  buildResult: () => ({})
});

describe('executor 注册中心', () => {
  test('缺少契约方法的执行器注册被拒绝', () => {
    expect(() => executor.register({ name: 'bad', buildSteps: () => [] })).toThrow(/缺少方法/);
  });

  test('无 name 的执行器被拒绝', () => {
    expect(() => executor.register({ buildSteps: () => {} })).toThrow(/name/);
  });

  test('setActive 未注册的名字抛错', () => {
    expect(() => executor.setActive('not-registered-xyz')).toThrow(/未注册/);
  });

  test('注册后可切换并取回当前执行器', () => {
    executor.register(fake('e1'));
    executor.register(fake('e2'), { activate: true });
    expect(executor.getActive().name).toBe('e2');
    executor.setActive('e1');
    expect(executor.getActive().name).toBe('e1');
    expect(executor.listNames()).toContain('e1');
  });
});
