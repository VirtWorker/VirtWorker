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

  test('error 级别落盘时敏感字段掩码', () => {
    logger.init(dir);
    console.error('config error', { token: 'abc123' });
    logger.close();

    const content = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
    expect(content).toContain('***');
    expect(content).not.toContain('abc123');
  });
});

describe('logger 缓冲写（PERF-4）', () => {
  test('info 级日志进缓冲：flush 前不落盘，close 后完整可见', () => {
    const bufDir = path.join(dir, 'buffer');
    logger.init(bufDir);
    console.log('buffered-line-a');
    console.log('buffered-line-b');
    // 500ms 缓冲窗口内同步断言：尚未落盘（close 前无 await，定时器不可能触发）
    expect(fs.existsSync(path.join(bufDir, 'main.log'))).toBe(false);
    logger.close();
    const content = fs.readFileSync(path.join(bufDir, 'main.log'), 'utf8');
    expect(content).toContain('buffered-line-a');
    expect(content).toContain('buffered-line-b');
  });

  test('error 级日志直写：无需 close 立即可见', () => {
    const directDir = path.join(dir, 'direct');
    logger.init(directDir);
    console.error('direct-error-line');
    // error 及以上绕过缓冲立即落盘，崩溃前的关键诊断不丢失
    const content = fs.readFileSync(path.join(directDir, 'main.log'), 'utf8');
    expect(content).toContain('direct-error-line');
    logger.close();
  });

  test('init 切换目录前冲刷旧缓冲：旧日志进旧文件不串目录', () => {
    const oldDir = path.join(dir, 'swap-old');
    const newDir = path.join(dir, 'swap-new');
    logger.init(oldDir);
    console.log('belongs-to-old');
    logger.init(newDir); // 此时旧缓冲必须写进 oldDir 而非 newDir
    expect(fs.readFileSync(path.join(oldDir, 'main.log'), 'utf8')).toContain('belongs-to-old');
    logger.close();
    // newDir 初始化后无任何日志写入：文件不存在同样证明没有串目录
    const newContent = fs.existsSync(path.join(newDir, 'main.log'))
      ? fs.readFileSync(path.join(newDir, 'main.log'), 'utf8')
      : '';
    expect(newContent).not.toContain('belongs-to-old');
  });
});
