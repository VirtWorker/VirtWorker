/**
 * 知识库导入回归测试。
 * 修复背景：createKnowledge 曾先入库后索引，目录没有可索引文本时抛错，
 *          但 capabilities 里已留下 status=indexed、无任何片段的「幽灵知识库」。
 * 现约定：索引成功才入库，失败时不残留 capability 或 chunks。
 * 注：导入链路（scanFiles/indexDirectory）已全链路 fs.promises 异步化以避免阻塞主进程，
 *     因此 createKnowledge/reindexKnowledge 均为 async。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const capabilityService = require('../main/services/capability-service');
const { initTempDb, cleanupTempDb, db } = await import('./setup.js');

let dir;
let emptyDir;
let textDir;

beforeAll(() => {
  dir = initTempDb();
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtworker-empty-'));
  textDir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtworker-text-'));
  fs.writeFileSync(path.join(textDir, 'notes.md'), '# 笔记\nVirtWorker 是数字员工应用。');
});

afterAll(() => {
  cleanupTempDb(dir);
  fs.rmSync(emptyDir, { recursive: true, force: true });
  fs.rmSync(textDir, { recursive: true, force: true });
});

describe('createKnowledge 索引与入库一致性', () => {
  test('目录没有可索引文本时创建失败，且不留下幽灵知识库记录', async () => {
    await expect(capabilityService.createKnowledge({ name: '空目录', dir: emptyDir })).rejects.toThrow(/没有可索引/);
    expect(db.all('capabilities')).toHaveLength(0);
    expect(db.all('chunks')).toHaveLength(0);
  });

  test('正常目录：索引成功后入库，片段可检索', async () => {
    const created = await capabilityService.createKnowledge({ name: '笔记库', dir: textDir });
    const stored = db.find('capabilities', created.id);
    expect(stored).toBeTruthy();
    expect(stored.status).toBe('indexed');
    expect(db.all('chunks').some((chunk) => chunk.capabilityId === created.id)).toBe(true);

    const hits = capabilityService.searchKnowledge(created.id, '数字员工');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain('数字员工');
  });
});

describe('知识库检索缓存失效（P3-20）', () => {
  test('reindex 替换片段后检索反映新内容（内存索引已重建）', async () => {
    const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtworker-cache-'));
    try {
      fs.writeFileSync(path.join(docsDir, 'a.txt'), '旧内容 alpha');
      const kb = await capabilityService.createKnowledge({ name: `缓存库${Date.now()}`, dir: docsDir });

      expect(capabilityService.searchKnowledge(kb.id, 'alpha', 5).length).toBe(1);

      fs.writeFileSync(path.join(docsDir, 'a.txt'), '新内容 beta');
      await capabilityService.reindexKnowledge(kb.id);

      expect(capabilityService.searchKnowledge(kb.id, 'alpha', 5).length).toBe(0);
      expect(capabilityService.searchKnowledge(kb.id, 'beta', 5).length).toBe(1);
    } finally {
      fs.rmSync(docsDir, { recursive: true, force: true });
    }
  });

  test('批量索引落盘（insertMany）后片段计数正确', async () => {
    const before = db.count('chunks');
    const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtworker-bulk-'));
    try {
      fs.writeFileSync(path.join(docsDir, 'a.md'), '批量索引内容一。' + '很长的内容。'.repeat(80));
      fs.writeFileSync(path.join(docsDir, 'b.md'), '批量索引内容二。' + '另外的内容。'.repeat(80));
      const kb = await capabilityService.createKnowledge({ name: `批量库${Date.now()}`, dir: docsDir });
      expect(db.count('chunks')).toBeGreaterThan(before);
      const stored = db.query('chunks', (chunk) => chunk.capabilityId === kb.id);
      expect(stored.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(docsDir, { recursive: true, force: true });
    }
  });
});
