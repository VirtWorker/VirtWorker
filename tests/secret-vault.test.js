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
const electronResolved = require.resolve('electron');
const stubModule = new Module(electronResolved, null);
stubModule.filename = electronResolved;
stubModule.loaded = true;
stubModule.exports = {
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    // 真实 safeStorage.decryptString 返回 string，桩保持同型
    decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, '')
  }
};
require.cache[electronResolved] = stubModule;

const vault = require('../main/util/secret-vault');

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
});
