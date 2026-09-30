/**
 * 文件日志测试（对应优化项 #19）
 * 验证：写入落盘、console 镜像、轮转不报错。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const logger = require('../main/util/logger');

let dir;
const originalLog = console.log;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-log-'));
});

afterAll(() => {
  console.log = originalLog;
  logger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('logger 文件日志', () => {
  test('console 输出镜像到日志文件', () => {
    logger.init(dir);
    logger.mirrorConsole();
    console.log('hello-from-test');
    console.error('boom-from-test');
    logger.close(); // 刷新写入流

    const content = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
    expect(content).toContain('hello-from-test');
    expect(content).toContain('[ERROR]');
    expect(content).toContain('boom-from-test');
  });

  test('日志目录缺失时自动创建且不抛错', () => {
    const nested = path.join(dir, 'deep', 'logs');
    expect(() => logger.init(nested)).not.toThrow();
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe('logger 级别与脱敏（P1-16）', () => {
  test('低于阈值的级别不落盘，敏感字段被掩码', () => {
    const levelDir = path.join(dir, 'levels');
    process.env.VIRTWORKER_LOG_LEVEL = 'error';
    try {
      logger.init(levelDir);
      console.log('debug-ish-info', { token: 'abc123', nested: { apiKey: 'xyz789' }, plain: 'visible' });
      console.error('only-error-visible');
      logger.close();

      const content = fs.readFileSync(path.join(levelDir, 'main.log'), 'utf8');
      // INFO 低于 error 阈值：整条不落盘
      expect(content).not.toContain('debug-ish-info');
      expect(content).toContain('only-error-visible');
    } finally {
      delete process.env.VIRTWORKER_LOG_LEVEL;
    }
  });

  test('info 级别落盘时敏感字段掩码、普通字段保留', () => {
    logger.init(dir);
    console.log('config loaded', { token: 'abc123', nested: { apiKey: 'xyz789' }, plain: 'visible' });
    logger.close();

    const content = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
    expect(content).toContain('config loaded');
    expect(content).toContain('***');
    expect(content).toContain('visible');
    expect(content).not.toContain('abc123');
    expect(content).not.toContain('xyz789');
  });
});
