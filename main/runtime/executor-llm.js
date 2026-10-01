/**
 * 真实 LLM 执行器（NEW-1）：OpenAI 兼容 /chat/completions。
 * - 执行计划复用 mock 的角色模板与流程节点展开（计划与执行引擎无关，语义锚点一致）
 * - runStep 将目标 / 步骤 / 节点指令 / 知识库命中片段组装为 prompt 调用模型，
 *   模型输出作为步骤日志落库；ctx.signal 中止时同步中断网络请求
 * - 私有配置（baseUrl / model / apiKey / temperature / maxTokens / maxParallel）
 *   存于 settings.executorConfig.llm，经 executor:configure 写入（apiKey 由 vault 加密落库）
 * - 用户操作请求沿用 mock 的规则化注入（confirmFirst / 关键词口径确认），不引入随机暂停
 */

const db = require('../store/db');
const vault = require('../util/secret-vault');
const workerService = require('../services/worker-service');
const capabilityService = require('../services/capability-service');
const mock = require('./executor-mock');

const name = 'llm';

/** 步骤日志截断上限：模型输出直接作为步骤日志落库，防超长内容撑爆集合文件 */
const LOG_LIMIT = 2000;
/** 单步超时：LLM 生成较慢，给足余量（运行时超时后中止请求并按失败收口） */
const STEP_TIMEOUT_MS = 180 * 1000;
/** 结果汇报的超时（独立于步骤超时，失败仅降级为本地汇总，不影响任务完成） */
const SUMMARY_TIMEOUT_MS = 30 * 1000;

function readConfig() {
  const all = db.getSettings().executorConfig || {};
  const cfg = all.llm || {};
  const temperature = Number(cfg.temperature);
  const maxTokens = Number(cfg.maxTokens);
  const maxParallel = Number(cfg.maxParallel);
  return {
    baseUrl: String(cfg.baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(cfg.model || '').trim(),
    apiKey: plainApiKey(cfg.apiKey),
    temperature: temperature >= 0 && temperature <= 2 ? temperature : 0.7,
    maxTokens: maxTokens > 0 ? Math.min(Math.round(maxTokens), 8192) : 0,
    maxParallel: maxParallel >= 1 && maxParallel <= 10 ? Math.round(maxParallel) : 2
  };
}

/** apiKey 在库内为 { sealed, mask } 形态（executor:configure 的 vault 加密约定），解封为明文供请求头使用 */
function plainApiKey(entry) {
  if (!entry) return '';
  if (typeof entry === 'object' && entry.sealed) {
    try {
      return vault.open(entry.sealed);
    } catch (error) {
      return '';
    }
  }
  return typeof entry === 'string' ? entry : '';
}

function clip(text, length) {
  const value = String(text ?? '');
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

// ==================== 计划 ====================

// 执行计划与 mock 完全一致：角色步骤模板 + 挂载知识库时插入检索步骤 + 流程节点展开
const { buildSteps, buildFlowSteps } = mock;

function stepDelay() {
  return 150; // 真实调用本身耗时，仅保留小间隔避免请求风暴
}

function stepTimeoutMs() {
  return STEP_TIMEOUT_MS;
}

function stepRetryLimit() {
  return 2; // 网络/限流类瞬时失败由运行时的步骤级重试兜底（指数退避）
}

function maxParallel() {
  return readConfig().maxParallel;
}

// ==================== 执行 ====================

/** 组装 prompt：系统设定（角色人设）+ 用户消息（目标 / 步骤 / 指令 / 知识片段 / 用户补充） */
function buildMessages(task, step, worker, citations) {
  const persona = worker
    ? `你是数字员工「${worker.name}」，角色：${worker.role || '通用助理'}${worker.desc ? `。职责：${clip(worker.desc, 200)}` : ''}`
    : '你是数字员工的执行引擎';
  const system = `${persona}。请以第一人称推进分配给你的工作步骤，直接输出该步骤的实际工作成果与结论，简洁专业，不要输出与步骤无关的客套或免责内容。`;

  const lines = [
    `任务目标：${task.goal}`,
    `当前步骤（${step.step}/${task.steps.length}）：${step.title}`
  ];
  if (step.instruction) lines.push(`节点指令：${step.instruction}`);
  if (task.workspace?.cwd) lines.push(`工作目录：${task.workspace.cwd}`);
  if (citations.length) {
    lines.push('以下是与任务相关的本地知识库片段，可在成果中引用：');
    citations.forEach((hit, index) => {
      lines.push(`[${index + 1}] ${hit.file || hit.title || '片段'}：${clip(hit.snippet || hit.text || hit.content || '', 400)}`);
    });
  }
  const answered = mock.answerText(task.actionRequest, task.actionRequest?.answer);
  if (answered) lines.push(`用户已确认/补充：${answered}`);
  lines.push('请输出本步骤的工作成果：');

  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n\n') }
  ];
}

/** 调用 OpenAI 兼容接口；网络失败 / 非 2xx / 空响应均抛错（由运行时步骤级重试或失败收口） */
async function chatCompletion(cfg, messages, signal) {
  if (signal?.aborted) throw new Error('aborted');
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const body = { model: cfg.model, messages, temperature: cfg.temperature, stream: false };
  if (cfg.maxTokens) body.max_tokens = cfg.maxTokens;

  let response;
  try {
    response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    // 取消识别以信号为准（task-runtime 以 error.message === 'aborted' 或 signal.aborted 判定取消）
    if (signal?.aborted) throw new Error('aborted');
    throw new Error(`无法连接模型服务（${cfg.baseUrl}）：${error.message || error}`, { cause: error });
  }
  if (!response.ok) {
    const detail = clip(await response.text().catch(() => ''), 300);
    const error = new Error(`模型服务返回 ${response.status}${detail ? `：${detail}` : ''}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) throw new Error('模型返回内容为空');
  return { content: String(content), usage: data.usage || null };
}

/**
 * 执行一步：检索知识库 → 组装 prompt → 调用模型。
 * 返回 { log, citations }：模型输出作为步骤日志（含 token 用量与知识引用），引用落库供结果汇总。
 */
async function runStep(task, step, ctx) {
  const signal = ctx?.signal;
  if (signal?.aborted) throw new Error('aborted');

  const cfg = readConfig();
  if (!cfg.baseUrl || !cfg.model) {
    throw new Error('LLM 执行器未配置完成（需要 API 地址与模型名），请在设置中心填写并保存后重试');
  }

  const worker = step.workerId
    ? workerService.getWorker(step.workerId)
    : workerService.resolveExecutorWorker(task.assignee);
  const citations =
    worker && (step.instruction || mock.RETRIEVE_ANCHOR.test(step.title))
      ? capabilityService.searchForWorker(worker.id, task.goal, 2)
      : [];

  const { content, usage } = await chatCompletion(cfg, buildMessages(task, step, worker, citations), signal);

  const citeText = citations.length ? `\n（引用：${citations.map((hit) => hit.file).join('、')}）` : '';
  const usageText = usage?.total_tokens ? `\n（tokens：${usage.prompt_tokens ?? '?'} + ${usage.completion_tokens ?? '?'} = ${usage.total_tokens}）` : '';
  return { log: clip(content.trim(), LOG_LIMIT) + usageText + citeText, citations };
}

/**
 * 用户操作请求：沿用 mock 的规则化注入（规则优先、可预测），但不引入随机兜底——
 * 真实执行的任务由模型按目标推进，随机暂停只会增加无意义打扰。
 */
function maybeAction(task, step, ctx) {
  if (ctx?.actionUsed) return null;
  const anchorOf = (pattern) => {
    const matched = task.steps.find((item) => pattern.test(item.title));
    return matched ? matched.step : task.steps.length > 1 ? task.steps.length - 1 : null;
  };
  if (task.confirmFirst && step.step === anchorOf(mock.COLLECT_ANCHOR)) return mock.confirmRequest();
  if (mock.CONFIRM_KEYWORDS.some((keyword) => task.goal.includes(keyword)) && step.step === anchorOf(mock.PROCESS_ANCHOR)) {
    return mock.selectionRequest(task);
  }
  return null;
}

// ==================== 结果 ====================

/** 汇总各步骤产出生成结果汇报；失败降级为本地汇总，绝不让已成功的任务卡在收尾 */
async function buildResult(task, worker) {
  const capabilities = mock.collectCapabilities(task);
  const citations = task.steps.flatMap((step) => step.citations || []);
  const answered = mock.answerText(task.actionRequest, task.actionRequest?.answer);

  let summary = '';
  try {
    const cfg = readConfig();
    if (cfg.baseUrl && cfg.model) {
      const messages = [
        { role: 'system', content: '你是任务执行链路的汇报助手。基于各步骤产出撰写简短的结果汇报（80 字以内，直接输出正文，不要标题与客套）。' },
        {
          role: 'user',
          content: `任务「${task.title}」，目标：${task.goal}\n各步骤产出：\n${task.steps
            .map((step) => `${step.step}. ${step.title}：${clip(step.log, 200)}`)
            .join('\n')}${answered ? `\n用户补充：${answered}` : ''}`
        }
      ];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
      timer.unref?.();
      try {
        const { content } = await chatCompletion(cfg, messages, controller.signal);
        summary = clip(content.trim(), 300);
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    console.warn('[executor-llm] 结果汇报生成失败，降级为本地汇总:', error.message || error);
  }
  if (!summary) summary = localSummary(task, capabilities, citations, answered);

  return {
    summary,
    text: `本次执行由「${task.assignee?.name || worker?.name || '数字员工'}」调用大模型（${readConfig().model || '未配置'}）完成 ${task.steps.length} 个步骤。如需调整结论，可直接基于同一目标再次创建任务。`,
    artifacts: deriveArtifacts(task, worker),
    capabilities: {
      skills: capabilities.skills.map((item) => item.title),
      connectors: capabilities.connectors.map((item) => item.title),
      knowledge: capabilities.knowledge.map((item) => item.title),
      citations
    }
  };
}

/** 本地兜底汇总：与 mock 同款口径，从步骤日志与能力挂载推导 */
function localSummary(task, capabilities, citations, answered) {
  const parts = [`已围绕「${task.title}」完成 ${task.steps.length} 个步骤`];
  if (answered) parts.push(`采纳了你提交的「${answered}」`);
  if (capabilities.knowledge.length) parts.push(`引用了 ${capabilities.knowledge.length} 个知识库、${citations.length} 条知识片段`);
  if (capabilities.skills.length) parts.push(`使用了 ${capabilities.skills.map((item) => item.title).join('、')}`);
  return `${parts.join('，')}。`;
}

/** 交付物命名与 mock 同款（按角色 + 工作目录），保持看板展示一致 */
function deriveArtifacts(task, worker) {
  const artifacts = (mock.ARTIFACTS[worker?.role] || mock.ARTIFACTS['通用助理']).slice();
  if (task.workspace?.cwd) artifacts.push(`说明-${task.workspace.cwd.replace(/[\\/:*?"<>|]/g, '_')}.txt`);
  return artifacts;
}

module.exports = {
  name,
  buildSteps,
  buildFlowSteps,
  stepDelay,
  runStep,
  maybeAction,
  buildResult,
  stepTimeoutMs,
  stepRetryLimit,
  maxParallel
};
