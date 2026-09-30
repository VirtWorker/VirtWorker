/**
 * 存储写入节流测试（对应优化项 #16）
 * 验证：变更先入缓存立即可读；flush 后才落盘；合并窗口内多次写只产生一次文件写入。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../main/store/db');

let dir;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-db-'));
  db.init(path.join(dir, 'data'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('db 写入节流', () => {
  test('插入后立即可从缓存读取，flush 前磁盘文件尚未生成', () => {
    db.insert('workers', { id: 'wk_t1', name: '节流测试', groupIds: [], capabilityIds: [] });
    expect(db.find('workers', 'wk_t1')).toBeTruthy();
    expect(fs.existsSync(path.join(dir, 'data', 'workers.json'))).toBe(false);
  });

  test('flush 后数据完整落盘', () => {
    db.update('workers', 'wk_t1', { name: '已改名' });
    db.insert('workers', { id: 'wk_t2', name: '第二条', groupIds: [], capabilityIds: [] });
    db.flush();

    const payload = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'workers.json'), 'utf8'));
    expect(payload.items.map((item) => item.id)).toEqual(['wk_t1', 'wk_t2']);
    expect(payload.items.find((item) => item.id === 'wk_t1').name).toBe('已改名');
  });

  test('remove 后 flush 同步磁盘', () => {
    db.remove('workers', 'wk_t2');
    db.flush();
    const payload = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'workers.json'), 'utf8'));
    expect(payload.items.map((item) => item.id)).toEqual(['wk_t1']);
  });
});

describe('db 备份轮换（两代备份，防唯一备份在覆盖瞬间损坏）', () => {
  test('连续 flush 后 .bak 为上一代、.bak2 为上上代', () => {
    db.insert('workers', { id: 'wk_b1', name: 'v1', groupIds: [], capabilityIds: [] });
    db.flush();
    db.update('workers', 'wk_b1', { name: 'v2' });
    db.flush();

    const bak = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'workers.json.bak'), 'utf8'));
    expect(bak.items.find((item) => item.id === 'wk_b1').name).toBe('v1');

    db.update('workers', 'wk_b1', { name: 'v3' });
    db.flush();

    const bak2 = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'workers.json.bak2'), 'utf8'));
    expect(bak2.items.find((item) => item.id === 'wk_b1').name).toBe('v1');
    const bak1 = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'workers.json.bak'), 'utf8'));
    expect(bak1.items.find((item) => item.id === 'wk_b1').name).toBe('v2');
  });
});

describe('db 批量与定向读取原语（P3-19）', () => {
  test('insertMany 一次落盘，query/count 浅读取且返回克隆', () => {
    const before = db.count('workers');
    const items = [1, 2, 3, 4, 5].map((i) => ({
      id: `wk_bulk${i}`,
      name: `bulk${i}`,
      groupIds: [],
      capabilityIds: []
    }));
    const returned = db.insertMany('workers', items);
    expect(returned[0]).not.toBe(items[0]); // 返回克隆，缓存不被外部持有
    expect(db.count('workers')).toBe(before + 5);

    const hits = db.query('workers', (worker) => worker.name.startsWith('bulk'));
    expect(hits.length).toBe(5);
    expect(hits[0]).not.toBe(items[0]);

    db.flush();
    const payload = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'workers.json'), 'utf8'));
    expect(payload.items.filter((worker) => worker.name.startsWith('bulk')).length).toBe(5);
  });

  test('append O(1) 追加；keepLast 保留匹配项的最后 N 条', () => {
    for (let i = 0; i < 6; i += 1) {
      db.append('taskevents', { id: `ev_t${i}`, taskId: 'tk_prune', type: 'log', message: String(i), at: '2026-01-01T00:00:00.000Z' });
    }
    const removed = db.keepLast('taskevents', (event) => event.taskId === 'tk_prune', 3);
    expect(removed).toBe(3);
    expect(db.query('taskevents', (event) => event.taskId === 'tk_prune').map((event) => event.id)).toEqual([
      'ev_t3',
      'ev_t4',
      'ev_t5'
    ]);
  });
});

describe('schema v1→v2 迁移：任务时间线拆分（P3-30）', () => {
  test('v1 tasks 内嵌 events 迁移到 taskevents 集合，任务剥离并落盘为 v2', () => {
    const migrationDir = path.join(dir, 'migration');
    fs.mkdirSync(path.join(migrationDir, 'data'), { recursive: true });
    const v1 = {
      schemaVersion: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      items: [
        {
          id: 'tk_mig1',
          title: '旧任务',
          status: 'succeeded',
          createdAt: '2026-01-01T00:00:00.000Z',
          events: [
            { id: 'ev_1', taskId: 'tk_mig1', type: 'created', message: '创建', at: '2026-01-01T00:00:01.000Z' },
            { id: 'ev_2', taskId: 'tk_mig1', type: 'result_ready', message: '完成', at: '2026-01-01T00:00:02.000Z' }
          ]
        },
        { id: 'tk_mig2', title: '无事件任务', status: 'queued', createdAt: '2026-01-01T00:00:00.000Z', events: [] }
      ]
    };
    fs.writeFileSync(path.join(migrationDir, 'data', 'tasks.json'), JSON.stringify(v1), 'utf8');

    db.init(path.join(migrationDir, 'data'));

    // 任务对象已剥离内嵌 events
    const migrated = db.find('tasks', 'tk_mig1');
    expect(migrated).toBeTruthy();
    expect(migrated).not.toHaveProperty('events');
    expect(db.find('tasks', 'tk_mig2')).toBeTruthy();
    // 时间线进入独立集合且顺序保持
    expect(db.query('taskevents', (event) => event.taskId === 'tk_mig1').map((event) => event.id)).toEqual(['ev_1', 'ev_2']);

    db.flush();
    const written = JSON.parse(fs.readFileSync(path.join(migrationDir, 'data', 'tasks.json'), 'utf8'));
    expect(written.schemaVersion).toBe(2);
    expect(written.items[0]).not.toHaveProperty('events');
    const eventsFile = JSON.parse(fs.readFileSync(path.join(migrationDir, 'data', 'taskevents.json'), 'utf8'));
    expect(eventsFile.schemaVersion).toBe(2);
    expect(eventsFile.items.length).toBe(2);
  });

  test('迁移幂等：以 v2 数据再次 init 不产生重复时间线', () => {
    const migrationDir = path.join(dir, 'migration');
    const before = db.query('taskevents', () => true).length;
    db.init(path.join(migrationDir, 'data'));
    expect(db.query('taskevents', () => true).length).toBe(before);
  });

  test('版本高于当前支持时回退 .bak', () => {
    const futureDir = path.join(dir, 'future');
    fs.mkdirSync(path.join(futureDir, 'data'), { recursive: true });
    const future = { schemaVersion: 99, updatedAt: 'x', items: [{ id: 'wk_x' }] };
    const backup = { schemaVersion: 2, updatedAt: 'x', items: [{ id: 'wk_bak' }] };
    fs.writeFileSync(path.join(futureDir, 'data', 'workers.json'), JSON.stringify(future), 'utf8');
    fs.writeFileSync(path.join(futureDir, 'data', 'workers.json.bak'), JSON.stringify(backup), 'utf8');

    db.init(path.join(futureDir, 'data'));
    expect(db.find('workers', 'wk_bak')).toBeTruthy();
    expect(db.find('workers', 'wk_x')).toBeNull();
  });
});
