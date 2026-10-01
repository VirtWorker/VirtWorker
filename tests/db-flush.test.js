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

  test('版本过高且无有效备份时进入只读保护，绝不写盘覆盖原数据（O5）', () => {
    const roDir = path.join(dir, 'readonly');
    fs.mkdirSync(path.join(roDir, 'data'), { recursive: true });
    const future = { schemaVersion: 99, updatedAt: 'x', items: [{ id: 'wk_keep', name: '新版本写入的数据' }] };
    fs.writeFileSync(path.join(roDir, 'data', 'workers.json'), JSON.stringify(future), 'utf8');

    db.init(path.join(roDir, 'data'));
    expect(db.isReadOnly()).toBe(true);
    // 数据无法解析进内存（内存为空），但原文件必须原样保留
    expect(db.find('workers', 'wk_keep')).toBeNull();

    // 只读模式下一切写入被拒绝：flush 后主文件未被覆盖，也没有产生备份文件
    db.insert('workers', { id: 'wk_new', name: '本会话数据', groupIds: [], capabilityIds: [] });
    db.setSettings({ taskRetentionDays: 1 });
    db.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(roDir, 'data', 'workers.json'), 'utf8'));
    expect(raw.schemaVersion).toBe(99);
    expect(raw.items[0].id).toBe('wk_keep');
    expect(fs.existsSync(path.join(roDir, 'data', 'workers.json.bak'))).toBe(false);

    // 重新 init（模拟应用升级后重启）复位只读保护
    db.init(path.join(dir, 'data'));
    expect(db.isReadOnly()).toBe(false);
  });

  test('schemaVersion 缺失的 v1 tasks 文件仍迁移内嵌时间线（NaN 边缘，BUG-7）', () => {
    const nanDir = path.join(dir, 'nan-version');
    fs.mkdirSync(path.join(nanDir, 'data'), { recursive: true });
    // 故意不写 schemaVersion 字段：Number(undefined)=NaN，旧判断 NaN<2 为 false 会跳过提取，
    // 而 schema.upgrade 把缺失版本按 v1 处理剥离 events → 时间线静默丢失
    const legacy = {
      updatedAt: '2026-01-01T00:00:00.000Z',
      items: [
        {
          id: 'tk_nan',
          title: '无版本号旧任务',
          status: 'succeeded',
          createdAt: '2026-01-01T00:00:00.000Z',
          events: [{ id: 'ev_nan1', taskId: 'tk_nan', type: 'created', message: '创建', at: '2026-01-01T00:00:01.000Z' }]
        }
      ]
    };
    fs.writeFileSync(path.join(nanDir, 'data', 'tasks.json'), JSON.stringify(legacy), 'utf8');

    db.init(path.join(nanDir, 'data'));
    expect(db.query('taskevents', (event) => event.taskId === 'tk_nan').map((event) => event.id)).toEqual(['ev_nan1']);
    expect(db.find('tasks', 'tk_nan')).not.toHaveProperty('events'); // schema 照常剥离内嵌字段

    db.init(path.join(dir, 'data')); // 恢复主数据目录
  });
});

describe('数据快照备份与恢复（F5）', () => {
  beforeAll(() => {
    // 前一个 describe 把 db 指向了别的目录，这里恢复主数据目录并复位只读
    db.init(path.join(dir, 'data'));
    db.removeWhere('workers', () => true);
  });

  test('backup 复制全部数据文件并轮换旧快照（保留 7 份）', () => {
    db.insert('workers', { id: 'wk_snap', name: '快照数据', groupIds: [], capabilityIds: [] });
    db.flush();

    const first = db.backup();
    expect(first.files).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(first.dir, 'workers.json'))).toBe(true);
    expect(first.kept).toBe(1);

    // 伪造 7 份过期快照，加上当前共 8 份 → 轮换后剩 7
    const root = db.backupsRoot();
    for (let i = 1; i <= 7; i += 1) {
      fs.mkdirSync(path.join(root, `2026010${i}-000000`), { recursive: true });
    }
    const second = db.backup();
    expect(second.kept).toBe(7);
    const remaining = fs.readdirSync(root).filter((name) => /^\d{8}-\d{6}$/.test(name));
    expect(remaining.length).toBe(7);
  });

  test('listBackups 新→旧排列；restore 覆盖数据目录并触发只读保护', () => {
    const list = db.listBackups();
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].files).toBeGreaterThan(0);
    // 名称即时间序：倒序排列
    const names = list.map((snap) => snap.name);
    expect([...names].sort().reverse()).toEqual(names);

    // 破坏当前数据 → 恢复最新快照 → 数据回来
    db.removeWhere('workers', () => true);
    db.flush();
    expect(db.count('workers')).toBe(0);

    const result = db.restore(list[0].name);
    expect(result.restored).toBe(list[0].name);
    expect(result.files).toBeGreaterThan(0);
    expect(db.isReadOnly()).toBe(true); // 恢复后本会话禁止写盘，防内存态覆盖恢复结果

    db.init(path.join(dir, 'data')); // 重启加载恢复的数据，只读复位
    expect(db.isReadOnly()).toBe(false);
    expect(db.find('workers', 'wk_snap')).toBeTruthy();
  });

  test('restore 校验快照名与存在性', () => {
    expect(() => db.restore('../escape')).toThrow(/不合法/);
    expect(() => db.restore('20990101-000000')).toThrow(/不存在/);
  });
});

describe('O7 写放大治理：紧凑序列化与临时文件清理', () => {
  test('集合文件紧凑落盘（缩进会让任务高频更新的全量重写再膨胀 30%+），settings 保留缩进', () => {
    db.insert('workers', { id: 'wk_c1', name: '紧凑', groupIds: [], capabilityIds: [] });
    db.setSettings({ taskRetentionDays: 60 });
    db.flush();

    const rawWorkers = fs.readFileSync(path.join(dir, 'data', 'workers.json'), 'utf8');
    expect(rawWorkers).not.toContain('\n');

    const rawSettings = fs.readFileSync(path.join(dir, 'data', 'settings.json'), 'utf8');
    expect(rawSettings).toContain('\n  "');
  });

  test('init 清理上次崩溃遗留的 *.json.tmp', () => {
    fs.writeFileSync(path.join(dir, 'data', 'workers.json.tmp'), 'garbage', 'utf8');
    db.init(path.join(dir, 'data'));
    expect(fs.existsSync(path.join(dir, 'data', 'workers.json.tmp'))).toBe(false);
  });
});

describe('O11 结构化匹配器：where / countWhere / removeWhere / keepLast', () => {
  beforeAll(() => {
    db.init(path.join(dir, 'data')); // 复位到主数据目录
    db.removeWhere('tasks', () => true);
    db.removeWhere('taskevents', () => true);
  });

  test('等值 / IN / 点路径匹配；where 返回克隆不污染缓存', () => {
    db.insert('tasks', { id: 'tk_w1', status: 'queued', assignee: { id: 'wk_a' }, priority: 'high' });
    db.insert('tasks', { id: 'tk_w2', status: 'running', assignee: { id: 'wk_b' }, priority: 'low' });

    expect(db.where('tasks', { 'assignee.id': 'wk_a' }).map((task) => task.id)).toEqual(['tk_w1']);
    expect(db.where('tasks', { status: ['queued', 'running'] }).length).toBe(2);
    expect(db.where('tasks', { 'assignee.id': ['wk_a', 'wk_b'], priority: 'high' }).map((task) => task.id)).toEqual([
      'tk_w1'
    ]);

    const hits = db.where('tasks', { 'assignee.id': 'wk_a' });
    hits[0].status = 'mutated';
    expect(db.find('tasks', 'tk_w1').status).toBe('queued');

    expect(db.countWhere('tasks', { status: 'running' })).toBe(1);
    expect(db.countWhere('tasks', (task) => task.priority === 'low')).toBe(1); // 函数谓词兼容
  });

  test('removeWhere / keepLast 接受匹配器（purge 批量化与时间线修剪的基础）', () => {
    db.append('taskevents', { id: 'ev_w1', taskId: 'tk_w1', type: 'log', at: '2026-01-01T00:00:00.000Z' });
    db.append('taskevents', { id: 'ev_w2', taskId: 'tk_w1', type: 'log', at: '2026-01-01T00:00:01.000Z' });
    db.append('taskevents', { id: 'ev_w3', taskId: 'tk_other', type: 'log', at: '2026-01-01T00:00:02.000Z' });

    expect(db.removeWhere('taskevents', { taskId: 'tk_w1' }).removed).toBe(2);
    expect(db.count('taskevents')).toBe(1);

    // 函数谓词保持兼容（worker-cascade 等既有测试依赖 removeWhere(() => true)）
    expect(db.removeWhere('taskevents', () => true).removed).toBe(1);

    db.append('taskevents', { id: 'ev_k1', taskId: 'tk_keep', type: 'log', at: '2026-01-01T00:00:03.000Z' });
    db.append('taskevents', { id: 'ev_k2', taskId: 'tk_keep', type: 'log', at: '2026-01-01T00:00:04.000Z' });
    db.append('taskevents', { id: 'ev_k3', taskId: 'tk_keep', type: 'log', at: '2026-01-01T00:00:05.000Z' });
    expect(db.keepLast('taskevents', { taskId: 'tk_keep' }, 2)).toBe(1);
    expect(db.where('taskevents', { taskId: 'tk_keep' }).map((event) => event.id)).toEqual(['ev_k2', 'ev_k3']);
  });
});

describe('taskevents 追加日志：写放大治理（PERF-1）', () => {
  const dataDir = () => path.join(dir, 'data-events');
  const logOf = () => path.join(dataDir(), 'taskevents.log');
  const baseOf = () => path.join(dataDir(), 'taskevents.json');
  const event = (id) => ({ id, taskId: 'tk_log', type: 'log', message: id, at: '2026-01-01T00:00:00.000Z' });

  beforeAll(() => {
    db.init(dataDir());
  });

  test('append 走追加日志，不经全量重写（flush 后 base 文件仍不生成）', () => {
    db.append('taskevents', event('ev_l1'));
    db.flush(); // append 不再标记脏：无 taskevents 全量写

    const logLines = fs.readFileSync(logOf(), 'utf8').trim().split('\n');
    expect(JSON.parse(logLines[0]).id).toBe('ev_l1');
    expect(fs.existsSync(baseOf())).toBe(false);
    expect(db.count('taskevents')).toBe(1);
  });

  test('重新 init 回放日志恢复事件；重复行按 id 去重', () => {
    // 模拟「全量写成功但日志截断失败」的残留：同一事件在日志中出现两次
    fs.appendFileSync(logOf(), `${JSON.stringify(event('ev_l1'))}\n`, 'utf8');
    db.init(dataDir());
    expect(db.where('taskevents', { taskId: 'tk_log' }).map((event) => event.id)).toEqual(['ev_l1']);
  });

  test('removeWhere 全量落盘后日志清空，已删事件重启后不复活', () => {
    db.removeWhere('taskevents', () => true);
    db.flush();
    expect(fs.readFileSync(logOf(), 'utf8')).toBe(''); // 全量写成功即清空日志

    db.append('taskevents', event('ev_l2'));
    db.init(dataDir()); // 模拟重启加载：base + 日志回放
    expect(db.where('taskevents', { taskId: 'tk_log' }).map((event) => event.id)).toEqual(['ev_l2']);
  });

  test('追加达到阈值后触发压缩：base 收编全部事件、日志清空、计数复位', () => {
    // 先重置为干净状态（清空 base/日志/计数），让压缩触发点完全确定
    db.removeWhere('taskevents', () => true);
    db.flush();
    for (let i = 0; i < db.EVENTS_LOG_COMPACT_LINES; i += 1) {
      db.append('taskevents', event(`ev_c${i}`));
    }
    const payload = JSON.parse(fs.readFileSync(baseOf(), 'utf8'));
    expect(payload.items.filter((item) => item.taskId === 'tk_log')).toHaveLength(db.EVENTS_LOG_COMPACT_LINES);
    expect(fs.readFileSync(logOf(), 'utf8')).toBe('');

    // 压缩后计数已复位：继续追加仍走追加路径，不触发第二次压缩
    db.append('taskevents', event('ev_c_after'));
    expect(JSON.parse(fs.readFileSync(logOf(), 'utf8').trim()).id).toBe('ev_c_after');
    expect(db.countWhere('taskevents', { taskId: 'tk_log' })).toBe(db.EVENTS_LOG_COMPACT_LINES + 1);
  });
});
