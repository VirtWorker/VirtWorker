/**
 * 真实 LLM 执行器测试（NEW-1）
 * fetch 打桩模拟 OpenAI 兼容 /chat/completions：验证契约声明、prompt 组装、
 * 未配置/网络失败/空响应的错误路径、aborted 取消语义、规则化用户操作请求与结果汇总降级。
 * 纯 Node 环境（无 electron），db 经 setup.js 的临时目录初始化。
 */

import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { initTempDb, cleanupTempDb, db, executor, workerService } from './setup.js';

const require = createRequire(import.meta.url);
const llm = require('../main/runtime/executor-llm');
const vault = require('../main/util/secret-vault');
const { SKILL_CATALOG } = require('../main/data/skill-catalog');
const capabilityService = require('../main/services/capability-service');
const SKILL_FIRST_ID = SKILL_CATALOG[0].id;

const dir = initTempDb();

// ==================== fetch 打桩 ====================

const originalFetch = globalThis.fetch;
let fetchImpl;
let fetchCalls = 0;

function stubFetch(impl) {
  fetchImpl = impl;
  fetchCalls = 0;
  globalThis.fetch = async (url, options) => {
    fetchCalls += 1;
    return fetchImpl(url, options);
  };
}

/** 标准 OpenAI 兼容成功响应 */
function okResponse(content, usage) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { role: 'assistant', content } }], usage: usage || null }),
    text: async () => ''
  };
}

afterAll(() => {
  globalThis.fetch = originalFetch;
  cleanupTempDb(dir);
});

beforeEach(() => {
  db.setSettings({ executorConfig: {} });
  stubFetch(async () => okResponse('模型输出'));
});

// ==================== 契约 ====================

describe('executor-llm 契约声明', () => {
  test('满足 executor 注册契约并可注册/切换', () => {
    executor.register(llm);
    expect(executor.listNames()).toContain('llm');
    executor.setActive('llm');
    expect(executor.getActive().name).toBe('llm');
  });

  test('运行时调优参数声明合理', () => {
    expect(llm.stepTimeoutMs()).toBeGreaterThanOrEqual(120 * 1000); // LLM 生成慢，需长于缺省 120s
    expect(llm.stepRetryLimit()).toBeGreaterThanOrEqual(1); // 网络瞬时失败依赖步骤级重试
    expect(llm.maxParallel()).toBeGreaterThanOrEqual(1);
    expect(llm.stepDelay()).toBeLessThan(1000); // 真实调用本身耗时，无需模拟间隔
  });
});

// ==================== runStep ====================

describe('executor-llm runStep', () => {
  const task = {
    id: 'tk_llm1',
    goal: '整理竞品对比要点',
    title: '竞品调研',
    steps: [{ step: 1, title: '理解任务目标' }, { step: 2, title: '形成结论建议' }],
    actionRequest: null
  };
  const step = { step: 1, title: '理解任务目标', workerId: null, instruction: '' };

  test('未配置 baseUrl/model 时抛出可读错误', async () => {
    await expect(llm.runStep(task, step, {})).rejects.toThrow(/未配置/);
    expect(fetchCalls).toBe(0);
  });

  test('baseUrl 带 userinfo 在请求前被拦截（SEC-5 出站校验兜底旧数据）', async () => {
    db.setSettings({
      executorConfig: { llm: { baseUrl: 'https://user:pass@api.example.com', model: 'test-model' } }
    });
    await expect(llm.runStep(task, step, {})).rejects.toThrow(/userinfo/);
    expect(fetchCalls).toBe(0);
  });

  test('调用 OpenAI 兼容接口：URL/模型/鉴权头正确，模型输出作为步骤日志', async () => {
    db.setSettings({
      executorConfig: {
        llm: {
          baseUrl: 'https://api.example.com/v1/',
          model: 'test-model',
          apiKey: { sealed: vault.seal('sk-test-123'), mask: '••••-123' },
          temperature: 0.3,
          maxTokens: 1024
        }
      }
    });
    let captured;
    stubFetch(async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return okResponse('竞品对比已完成', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    });

    const outcome = await llm.runStep(task, step, { signal: new AbortController().signal });

    expect(captured.url).toBe('https://api.example.com/v1/chat/completions'); // 末尾斜杠已收敛
    expect(captured.options.headers.Authorization).toBe('Bearer sk-test-123'); // vault 解封后的明文密钥
    expect(captured.body.model).toBe('test-model');
    expect(captured.body.stream).toBe(false);
    expect(captured.body.temperature).toBe(0.3);
    expect(captured.body.max_tokens).toBe(1024);
    expect(captured.body.messages[0].role).toBe('system');
    expect(captured.body.messages[1].content).toContain('整理竞品对比要点'); // 任务目标注入
    expect(captured.body.messages[1].content).toContain('理解任务目标'); // 步骤标题注入
    expect(outcome.log).toContain('竞品对比已完成');
    expect(outcome.log).toContain('120'); // token 用量记入日志
    expect(outcome.citations).toEqual([]);
  });

  test('无密钥（本地 Ollama 类服务）不带 Authorization 头', async () => {
    db.setSettings({ executorConfig: { llm: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5' } } });
    let captured;
    stubFetch(async (url, options) => {
      captured = { options, body: JSON.parse(options.body) };
      return okResponse('ok');
    });
    await llm.runStep(task, step, {});
    expect(captured.options.headers.Authorization).toBeUndefined();
    expect(captured.body.temperature).toBe(0.7); // 缺省温度
  });

  test('非 2xx 抛出带状态码的错误（运行时按步骤级重试处理）', async () => {
    db.setSettings({ executorConfig: { llm: { baseUrl: 'https://api.example.com/v1', model: 'm' } } });
    stubFetch(async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited' }));
    await expect(llm.runStep(task, step, {})).rejects.toThrow(/429/);
  });

  test('空响应抛错', async () => {
    db.setSettings({ executorConfig: { llm: { baseUrl: 'https://api.example.com/v1', model: 'm' } } });
    stubFetch(async () => okResponse('  '));
    await expect(llm.runStep(task, step, {})).rejects.toThrow(/为空/);
  });

  test('ctx.signal 已中止时直接以 aborted 抛出（取消语义，不重试不收口失败）', async () => {
    db.setSettings({ executorConfig: { llm: { baseUrl: 'https://api.example.com/v1', model: 'm' } } });
    const controller = new AbortController();
    controller.abort();
    await expect(llm.runStep(task, step, { signal: controller.signal })).rejects.toThrow('aborted');
    expect(fetchCalls).toBe(0);
  });

  test('无挂载知识库时不注入知识片段段落，引用为空', async () => {
    db.setSettings({ executorConfig: { llm: { baseUrl: 'https://api.example.com/v1', model: 'm' } } });
    const worker = workerService.createWorker({ name: 'LLM 检索工', role: '数据分析' });
    let body;
    stubFetch(async (url, options) => {
      body = JSON.parse(options.body);
      return okResponse('ok');
    });
    const outcome = await llm.runStep(
      { ...task, assignee: { type: 'worker', id: worker.id } },
      { ...step, title: '收集与整理素材' },
      {}
    );
    expect(body.messages[1].content).not.toContain('知识库片段');
    expect(outcome.citations).toEqual([]);
  });
});

// ==================== maybeAction ====================

describe('executor-llm maybeAction（规则化，无随机注入）', () => {
  test('confirmFirst 在收集锚点步骤注入确认请求', () => {
    const task = { goal: '整理报告', confirmFirst: true, steps: [{ step: 1, title: '理解任务目标' }, { step: 2, title: '收集与整理素材' }] };
    const action = llm.maybeAction(task, task.steps[1], { actionUsed: false });
    expect(action?.type).toBe('confirm');
  });

  test('目标含口径关键词时在选择阶段注入选择请求', () => {
    const task = { goal: '统计本月优先级排序', confirmFirst: false, steps: [{ step: 1, title: '收集与整理素材' }, { step: 2, title: '统计与建模分析' }] };
    const action = llm.maybeAction(task, task.steps[1], { actionUsed: false });
    expect(action?.type).toBe('selection');
  });

  test('已用过操作或无规则命中时不注入；连续多次调用结果确定（无随机）', () => {
    const task = { goal: '普通任务', confirmFirst: false, steps: [{ step: 1, title: '理解任务目标' }] };
    expect(llm.maybeAction(task, task.steps[0], { actionUsed: true })).toBeNull();
    for (let i = 0; i < 20; i += 1) {
      expect(llm.maybeAction(task, task.steps[0], { actionUsed: false })).toBeNull();
    }
  });
});

// ==================== buildResult ====================

describe('executor-llm buildResult', () => {
  const baseTask = {
    id: 'tk_llm2',
    title: '写周报',
    goal: '汇总本周进展',
    steps: [{ step: 1, title: '理解任务目标', log: '已解析目标' }],
    assignee: { type: 'worker', id: 'wk_none', name: '周报员' },
    actionRequest: null
  };

  test('LLM 汇报成功时使用模型输出作为 summary', async () => {
    db.setSettings({ executorConfig: { llm: { baseUrl: 'https://api.example.com/v1', model: 'm' } } });
    stubFetch(async () => okResponse('本周完成三项进展，风险已识别。'));
    const result = await llm.buildResult(baseTask, null);
    expect(result.summary).toBe('本周完成三项进展，风险已识别。');
    expect(result.capabilities).toHaveProperty('citations');
    expect(Array.isArray(result.artifacts)).toBe(true);
  });

  test('LLM 失败时降级为本地汇总，不抛错（任务已完成不应卡在收尾）', async () => {
    db.setSettings({ executorConfig: { llm: { baseUrl: 'https://api.example.com/v1', model: 'm' } } });
    stubFetch(async () => {
      throw new Error('connection refused');
    });
    const result = await llm.buildResult(baseTask, null);
    expect(result.summary).toContain('写周报');
    expect(result.summary).toContain('1 个步骤');
  });

  test('未配置 LLM 时直接本地汇总且不发起请求', async () => {
    db.setSettings({ executorConfig: {} });
    let called = 0;
    stubFetch(async () => {
      called += 1;
      return okResponse('x');
    });
    const result = await llm.buildResult(baseTask, null);
    expect(called).toBe(0);
    expect(result.summary).toContain('1 个步骤');
  });
});

// 计划构建复用 mock：角色步骤 + 流程节点展开
describe('executor-llm 执行计划（复用 mock 模板）', () => {
  test('buildSteps 按角色生成并携带 workerId', () => {
    const worker = workerService.createWorker({ name: '计划工', role: '内容创作' });
    const steps = llm.buildSteps({ goal: '写文案' }, workerService.getWorker(worker.id));
    expect(steps.map((step) => step.title)).toEqual(['理解创作目标', '收集与整理素材', '撰写内容初稿', '润色与定稿']);
    expect(steps.every((step) => step.workerId === worker.id)).toBe(true);
  });

  test('buildFlowSteps 展开节点并替换 {goal} 占位', () => {
    const steps = llm.buildFlowSteps(
      { goal: '季度总结' },
      { nodes: [{ title: '起草', instruction: '围绕 {goal} 起草', worker: null }] }
    );
    expect(steps[0].instruction).toBe('围绕 季度总结 起草');
  });
});

describe('executor-llm Skill 注入（E2）', () => {
  const task = {
    id: 'tk_llm_skill',
    goal: '整理周报要点',
    title: '周报',
    steps: [{ step: 1, title: '理解任务目标' }],
    actionRequest: null
  };
  const step = { step: 1, title: '理解任务目标', workerId: null, instruction: '' };

  beforeEach(() => {
    ['workers', 'capabilities'].forEach((name) => db.removeWhere(name, () => true));
    db.setSettings({
      executorConfig: { llm: { baseUrl: 'https://api.example.com/v1', model: 'test-model' } }
    });
  });

  test('挂载的 Skill 以执行上下文进入提示词（此前技能只影响结果文案）', async () => {
    const skill = capabilityService.installSkill(SKILL_FIRST_ID);
    const worker = workerService.createWorker({ name: '带技能执行者' });
    workerService.updateWorker(worker.id, { capabilityIds: [skill.id] });

    let captured;
    stubFetch(async (url, options) => {
      captured = { body: JSON.parse(options.body) };
      return okResponse('ok');
    });
    await llm.runStep({ ...task }, { ...step, workerId: worker.id }, {});

    const userContent = captured.body.messages[1].content;
    expect(userContent).toContain('已挂载以下技能');
    expect(userContent).toContain(skill.title);
  });

  test('未挂载技能的 Worker 不注入技能段', async () => {
    const worker = workerService.createWorker({ name: '无技能执行者' });
    let captured;
    stubFetch(async (url, options) => {
      captured = { body: JSON.parse(options.body) };
      return okResponse('ok');
    });
    await llm.runStep({ ...task }, { ...step, workerId: worker.id }, {});
    expect(captured.body.messages[1].content).not.toContain('已挂载以下技能');
  });
});

describe('executor-llm 配置派生与写入校验（BUG-34 / SEC-5）', () => {
  test('maxParallel 不触发 apiKey 解密：热路径免 DPAPI 解密（BUG-34）', () => {
    const plain = 'sk-vault-roundtrip-key';
    db.setSettings({
      executorConfig: {
        llm: {
          baseUrl: 'https://api.example.com',
          model: 'm',
          maxParallel: 4,
          apiKey: { sealed: vault.seal(plain), mask: '••••' }
        }
      }
    });
    const openSpy = vi.spyOn(vault, 'open');
    try {
      expect(llm.maxParallel()).toBe(4);
      expect(openSpy).not.toHaveBeenCalled(); // 修复前：readConfig 无条件解封，每次派发一次 DPAPI 解密
    } finally {
      openSpy.mockRestore();
    }
  });

  test('executor:configure 写入时校验 llm baseUrl（SEC-5），合法地址去尾斜杠', () => {
    const settingsDomain = require('../main/ipc/settings');
    expect(() =>
      settingsDomain.mergeExecutorConfig({ llm: { baseUrl: 'https://user:pass@evil.example.com' } })
    ).toThrow(/userinfo/);
    const merged = settingsDomain.mergeExecutorConfig({ llm: { baseUrl: 'https://api.example.com/v1///' } });
    expect(merged.llm.baseUrl).toBe('https://api.example.com/v1');
  });
});
