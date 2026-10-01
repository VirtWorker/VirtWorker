/**
 * 凭据保险箱测试（安全关键路径，此前零覆盖）
 * 验证：safeStorage 可用/不可用两条路径的 seal/open 往返、密文不含明文、掩码不泄密、畸形输入安全。
 * electron 在纯 Node 下导出的是二进制路径字符串而非 API，这里注入 stub 覆盖加密分支
 * （与 ipc-contract.test.js 同款 require.cache 手法，vitest 按文件隔离进程互不影响）。
 */

import { describe, test, expect } from 'vitest';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let encryptionAvailable = true;
let decryptShouldThrow = false;
const electronResolved = require.resolve('electron');
const stubModule = new Module(electronResolved, null);
stubModule.filename = electronResolved;
stubModule.loaded = true;
stubModule.exports = {
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    // 真实 safeStorage.decryptString 返回 string，桩保持同型；decryptShouldThrow 模拟 DPAPI 损坏（BUG-17）
    decryptString: (buffer) => {
      if (decryptShouldThrow) throw new Error('decryption failed');
      return buffer.toString('utf8').replace(/^enc:/, '');
    }
  }
};
require.cache[electronResolved] = stubModule;

const vault = require('../main/util/secret-vault');
const bus = require('../main/runtime/event-bus');

describe('secret-vault 凭据保险箱', () => {
  test('safeStorage 可用时加密往返，密文不含明文', () => {
    encryptionAvailable = true;
    expect(vault.isEncryptionAvailable()).toBe(true);

    const sealed = vault.seal('super-secret-token');
    expect(sealed.mode).toBe('encrypted');
    expect(sealed.value).not.toContain('super-secret-token');
    expect(vault.open(sealed)).toBe('super-secret-token');
  });

  test('safeStorage 不可用时降级 base64 并标记模式，往返仍可用', () => {
    encryptionAvailable = false;
    expect(vault.isEncryptionAvailable()).toBe(false);

    const sealed = vault.seal('plain-fallback');
    expect(sealed.mode).toBe('base64');
    expect(vault.open(sealed)).toBe('plain-fallback');
  });

  test('open 对畸形/空输入安全返回空串', () => {
    expect(vault.open(null)).toBe('');
    expect(vault.open(undefined)).toBe('');
    expect(vault.open({})).toBe('');
    expect(vault.open({ mode: 'encrypted', value: '' })).toBe('');
  });

  test('seal 空值与 mask 均不回传明文', () => {
    encryptionAvailable = true;
    const sealed = vault.seal('');
    expect(vault.open(sealed)).toBe('');

    expect(vault.mask('abcdefghijkl')).toBe('••••ijkl');
    expect(vault.mask('abc')).toBe('••••');
    expect(vault.mask('')).toBe('');
    expect(vault.mask(null)).toBe('');
  });

  test('解密异常降级返回空串并推送一次告警，不向上抛错（BUG-17）', () => {
    encryptionAvailable = true;
    const sealed = vault.seal('will-fail');
    const notices = [];
    const off = bus.on((notice) => notices.push(notice));
    try {
      expect(vault.open(sealed)).toBe('will-fail'); // 先成功解密一次，确保告警状态为复位（与用例顺序无关）
      decryptShouldThrow = true;
      // 跨机器迁移/DPAPI 损坏：open 不抛错，返回空串让上层走「未配置」分支
      expect(vault.open(sealed)).toBe('');
      expect(vault.open(sealed)).toBe('');
      const decryptNotices = notices.filter(
        (item) => item.type === 'app:notice' && item.payload.title === '凭据解密失败'
      );
      expect(decryptNotices.length).toBe(1); // 高频调用只告警一次，不刷爆通知
      expect(decryptNotices[0].payload.level).toBe('error');
    } finally {
      off();
      decryptShouldThrow = false;
    }
  });

  test('解密恢复成功后告警状态复位，再次失败会重新告警（BUG-17）', () => {
    encryptionAvailable = true;
    const sealed = vault.seal('round-trip');
    const notices = [];
    const off = bus.on((notice) => notices.push(notice));
    try {
      expect(vault.open(sealed)).toBe('round-trip'); // 先确保告警状态为复位（与用例顺序无关）
      decryptShouldThrow = true;
      expect(vault.open(sealed)).toBe(''); // 失败：告警
      expect(vault.open(sealed)).toBe(''); // 连续失败：抑制
      decryptShouldThrow = false;
      expect(vault.open(sealed)).toBe('round-trip'); // 成功：复位 decryptBroken
      decryptShouldThrow = true;
      expect(vault.open(sealed)).toBe(''); // 再次失败：重新告警
      expect(notices.filter((item) => item.type === 'app:notice' && item.payload.title === '凭据解密失败').length).toBe(2);
    } finally {
      off();
      decryptShouldThrow = false;
    }
  });
});
