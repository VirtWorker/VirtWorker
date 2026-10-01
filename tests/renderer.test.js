// @vitest-environment happy-dom
/**
 * 渲染层最小测试集（O15）
 * 此前渲染层 0 测试，安全与数据流核心（escapeHtml/safeStyle、store、api.latest）无回归防护。
 * 用 happy-dom 提供 window/document，直接加载浏览器 IIFE 模块（与 bundle 同一份源码）。
 */

import { describe, test, expect, beforeAll } from 'vitest';

let VW;

beforeAll(async () => {
  await import('../renderer/js/util.js');
  await import('../renderer/js/store.js');
  await import('../renderer/js/api.js');
  VW = window.VW;
});

describe('util.escapeHtml（安全关键：防属性逃逸）', () => {
  test('尖括号与引号全部转义', () => {
    expect(VW.util.escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;'
    );
    expect(VW.util.escapeHtml('" onmouseover="alert(1)')).toBe(
      '&quot; onmouseover=&quot;alert(1)'
    );
    // 输出中不得残留任何可逃逸属性/标签的原始字符（不同 DOM 实现的实体写法可能不同）
    const out = VW.util.escapeHtml("'><script>");
    expect(out).not.toContain("'");
    expect(out).not.toContain('"');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  test('普通文本原样返回，null/undefined 归一为空串', () => {
    expect(VW.util.escapeHtml('普通文本 123')).toBe('普通文本 123');
    expect(VW.util.escapeHtml(null)).toBe('');
    expect(VW.util.escapeHtml(undefined)).toBe('');
  });
});

describe('util.safeStyle（style 属性白名单）', () => {
  test('合法颜色/渐变通过', () => {
    expect(VW.util.safeStyle('linear-gradient(135deg,#6ee7a0,#10a54a)')).toBe(
      'linear-gradient(135deg,#6ee7a0,#10a54a)'
    );
  });

  test('引号/冒号/事件等可逃逸属性的字符被拒并回退', () => {
    expect(VW.util.safeStyle('red;background:url(x)')).toBe('');
    expect(VW.util.safeStyle('"onmouseover="x')).toBe('');
    expect(VW.util.safeStyle('red', '#eef0f2')).toBe('red');
    expect(VW.util.safeStyle('bad"', '#eef0f2')).toBe('#eef0f2');
  });
});

describe('store：切片订阅与相等性跳过（O9）', () => {
  test('set 仅通知内容变化的切片，内容未变不赋值不通知', () => {
    const seen = [];
    const off = VW.store.on(['tasks', 'stats'], () => seen.push('fired'));
    VW.store.set({ tasks: [{ id: 'tk_1' }], stats: { total: 1 } });
    expect(seen.length).toBe(2); // 两个切片都变化：同一处理器按切片各触发一次（与既有行为一致）

    seen.length = 0;
    // 内容相同（主进程克隆数据每次都是新引用）：不应触发渲染
    VW.store.set({ tasks: [{ id: 'tk_1' }] });
    expect(seen.length).toBe(0);

    seen.length = 0;
    VW.store.set({ tasks: [{ id: 'tk_2' }] });
    expect(seen.length).toBe(1);
    off();
  });

  test('merge 未变字段跳过通知（侧边栏搜索等高频 ui 合并不再触发全量重渲染）', () => {
    const seen = [];
    const off = VW.store.on('ui', () => seen.push('fired'));
    VW.store.merge('ui', { dashboardTab: 'action' });
    expect(seen.length).toBe(0); // 默认值相同：跳过
    VW.store.merge('ui', { dashboardTab: 'result' });
    expect(seen.length).toBe(1);
    off();
  });

  test('setFilters 更新筛选切片', () => {
    VW.store.setFilters('task', { keyword: 'abc' });
    expect(VW.store.state.filters.task.keyword).toBe('abc');
    VW.store.setFilters({ statsPeriod: 'week' });
    expect(VW.store.state.filters.statsPeriod).toBe('week');
  });

  test('assigneeOptions 聚合 Worker/Group/WorkerFlow', () => {
    VW.store.set({
      workers: [{ id: 'wk_1', name: 'A' }],
      groups: [{ id: 'gp_1', name: 'G' }],
      flows: [{ id: 'fl_1', name: 'F' }]
    });
    const options = VW.store.assigneeOptions();
    expect(options.map((item) => item.value)).toEqual(['wk_1', 'gp_1', 'fl_1']);
  });
});

describe('api.latest 过期响应防护（O9 回归防护）', () => {
  test('同一 key 并发请求只有最后一次的结果生效', async () => {
    const applied = [];
    let releaseOld;
    const old = VW.api.latest(
      'k1',
      () => new Promise((resolve) => (releaseOld = resolve)),
      (result) => applied.push(result)
    );
    const fresh = VW.api.latest('k1', () => Promise.resolve('new'), (result) => applied.push(result));

    await fresh;
    expect(applied).toEqual(['new']);
    releaseOld('old');
    await old;
    expect(applied).toEqual(['new']); // 过期响应被丢弃
  });

  test('不同 key 互不影响；错误照常抛给调用方', async () => {
    const applied = [];
    await VW.api.latest('k2', () => Promise.resolve('a'), (r) => applied.push(r));
    await VW.api.latest('k3', () => Promise.resolve('b'), (r) => applied.push(r));
    expect(applied).toEqual(['a', 'b']);

    await expect(
      VW.api.latest('k4', () => Promise.reject(new Error('boom')), () => {})
    ).rejects.toThrow('boom');
  });
});
