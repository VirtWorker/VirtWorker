/**
 * 目录授权 ticket 测试（对应优化项 #7）
 * 验证：签发-消费闭环、目录不一致拒绝、重放拒绝、过期拒绝。
 */

import { describe, test, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dirGrant = require('../main/runtime/dir-grant');

describe('dir-grant 一次性目录授权', () => {
  test('有效 ticket 且目录一致时通过', () => {
    const ticket = dirGrant.grant('D:\\docs');
    expect(dirGrant.consume(ticket, 'D:\\docs')).toBe(true);
  });

  test('目录不一致时拒绝', () => {
    const ticket = dirGrant.grant('D:\\docs');
    expect(dirGrant.consume(ticket, 'C:\\Windows')).toBe(false);
  });

  test('ticket 消费后不可重放', () => {
    const ticket = dirGrant.grant('D:\\once');
    expect(dirGrant.consume(ticket, 'D:\\once')).toBe(true);
    expect(dirGrant.consume(ticket, 'D:\\once')).toBe(false);
  });

  test('伪造/空 ticket 一律拒绝', () => {
    expect(dirGrant.consume('', 'D:\\any')).toBe(false);
    expect(dirGrant.consume('deadbeef', 'D:\\any')).toBe(false);
    expect(dirGrant.consume(undefined, undefined)).toBe(false);
  });

  test('过期 ticket 被拒绝（TTL 5 分钟，仅推进时钟验证）', () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    try {
      const ticket = dirGrant.grant('D:\\ttl');
      vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
      expect(dirGrant.consume(ticket, 'D:\\ttl')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
