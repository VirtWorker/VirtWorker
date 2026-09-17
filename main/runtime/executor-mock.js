/**
 * 模拟执行器（首批 + 能力注入）
 * 目标：让「创建 → 执行 → 需要操作 → 恢复 → 产出」整条链路可演示、可复现，且不依赖外部账号与网络。
 * 能力注入：执行时读取执行者已挂载的 Skill / 连接器 / 知识库，并在步骤日志与结果中真实体现
 *           （知识库命中片段会被引用）。后续以同样的接口替换为真实 LLM 执行器。
 */

const workerService = require('../services/worker-service');
const capabilityService = require('../services/capability-service');

/** 按角色生成步骤计划，保证计划贴近角色职责 */
const ROLE_STEPS = {
  通用助理: ['理解任务目标', '收集与整理素材', '形成结论建议', '生成交付物'],
  数据分析: ['理解分析目标', '收集与清洗数据', '统计与建模分析', '生成分析报告'],
  内容创作: ['理解创作目标', '收集与整理素材', '撰写内容初稿', '润色与定稿'],
  研发工程: ['理解需求目标', '定位相关代码', '实现并自测', '产出变更说明']
};

const ARTIFACTS = {
  通用助理: ['任务摘要.md'],
  数据分析: ['分析报告.md', '数据摘要.csv'],
  内容创作: ['内容初稿.docx'],
  研发工程: ['变更说明.md']
};

/** 目标中出现这些词时，执行中会请求用户确认口径（规则化，保证演示可复现） */
const CONFIRM_KEYWORDS = ['确认', '口径', '是否', '选择', '优先级', '审批'];

/** 阶段锚点：用于在步骤计划被能力注入改变后仍能定位到语义阶段 */
const COLLECT_ANCHOR = /收集|定位/;
const PROCESS_ANCHOR = /形成结论|统计|建模|撰写|实现/;
/** 需要检索知识库的步骤（收集类 / 显式检索类 / 流程节点） */
const RETRIEVE_ANCHOR = /检索|收集|定位|资料/;

const MIN_STEP_MS = 300;
const MAX_STEP_MS = 900;

// ==================== 计划 ====================

function makeStep(index, title, extra = {}) {
  return {
    step: index + 1,
    title,
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    log: '',
    citations: [],
    ...extra
  };
}

/** 单 Worker 执行计划：按角色步骤，挂载知识库时插入检索步骤 */
function buildSteps(task, worker) {
  const titles = [...(ROLE_STEPS[worker?.role] || ROLE_STEPS['通用助理'])];
  const capabilities = capabilityService.resolveWorkerCapabilities(worker?.id);
  if (capabilities.knowledge.length) titles.splice(1, 0, '检索知识库');
  return titles.map((title, index) => makeStep(index, title, { workerId: worker?.id || null }));
}

/** WorkerFlow 执行计划：每个节点一步，携带节点指令与节点 Worker */
function buildFlowSteps(task, plan) {
  return plan.nodes.map((node, index) =>
    makeStep(index, node.title, {
      // 指令模板支持 {goal} 占位，执行时替换为任务目标
      instruction: String(node.instruction).replace(/\{goal\}/g, task.goal),
      workerId: node.worker ? node.worker.id : null,
      workerName: node.worker ? node.worker.name : ''
    })
  );
}

function stepDelay() {
  return Math.round(MIN_STEP_MS + Math.random() * (MAX_STEP_MS - MIN_STEP_MS));
}

// ==================== 执行 ====================

function resolveStepWorker(task, step) {
  if (step.workerId) return workerService.getWorker(step.workerId);
  return workerService.resolveExecutorWorker(task.assignee);
}

function needsRetrieval(step) {
  return Boolean(step.instruction) || RETRIEVE_ANCHOR.test(step.title);
}

/** 执行一步：返回日志与知识引用（引用会落库到步骤上，供结果汇总） */
function runStep(task, step) {
  const worker = resolveStepWorker(task, step);
  const citations = worker && needsRetrieval(step) ? capabilityService.searchForWorker(worker.id, task.goal, 2) : [];
  const citeText = citations.length ? `（引用：${citations.map((hit) => hit.file).join('、')}）` : '';
  const seed = task.goal.length + step.step * 7;
  const count = (seed % 20) + 6;
  const title = step.title;

  let log;
  if (step.instruction) {
    log = `节点「${step.title}」（${step.workerName || '未绑定'}）按指令执行：${clip(step.instruction, 40)}${citeText}`;
  } else if (title.includes('检索')) {
    log = citations.length
      ? `命中 ${citations.length} 条知识片段${citeText}`
      : '知识库中未检索到相关内容，改用通用知识继续';
  } else if (title.includes('理解')) {
    log = `已解析目标与约束：${clip(task.goal, 40)}`;
  } else if (title.includes('收集') || title.includes('定位')) {
    log = `${title.includes('代码') ? `已定位 ${count} 处相关实现` : `已收集 ${count} 条相关素材`}${citeText}`;
  } else if (title.includes('统计') || title.includes('分析')) {
    log = `已完成统计与聚类，得到 ${Math.max(2, count - 4)} 个关键结论`;
  } else if (title.includes('撰写') || title.includes('实现')) {
    log = '已完成初稿实现并自测通过';
  } else if (title.includes('生成') || title.includes('产出') || title.includes('定稿') || title.includes('报告')) {
    log = '已生成交付物（模拟）';
  } else {
    log = `${title}已完成`;
  }

  return { log, citations };
}

function clip(text, length) {
  const value = String(text ?? '');
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function confirmRequest() {
  return {
    type: 'confirm',
    title: '是否按当前理解继续执行？',
    detail: '执行者已整理出对目标的理解，确认后继续推进；若选择调整，你的意见会记录到任务时间线。',
    options: [
      { value: 'yes', label: '按此继续' },
      { value: 'no', label: '需要调整' }
    ],
    defaultValue: 'yes'
  };
}

function selectionRequest(task) {
  if (task.goal.includes('优先级')) {
    return {
      type: 'selection',
      title: '请选择优先级的判定口径',
      detail: '不同口径会得到不同的排序结果，请确认后继续。',
      options: [
        { value: 'impact', label: '按影响面（受影响用户数）' },
        { value: 'frequency', label: '按出现频次' },
        { value: 'revenue', label: '按关联营收' }
      ],
      defaultValue: 'impact'
    };
  }
  return {
    type: 'selection',
    title: '请选择统计口径',
    detail: '检测到多个可用数据口径，需要你确认后再继续计算。',
    options: [
      { value: 'amount', label: '按金额统计' },
      { value: 'count', label: '按条数统计' }
    ],
    defaultValue: 'amount'
  };
}

function inputRequest() {
  return {
    type: 'input',
    title: '补充信息后继续',
    detail: '执行到关键步骤，需要你补充一点背景信息（可留空直接继续）。',
    form: [{ name: 'note', label: '补充说明', required: false, type: 'text' }],
    defaultValue: null
  };
}

/** 按语义锚点定位步骤；锚点缺失时退化为倒数第二步 */
function anchorOf(task, pattern) {
  const matched = task.steps.find((step) => pattern.test(step.title));
  if (matched) return matched.step;
  return task.steps.length > 1 ? task.steps.length - 1 : null;
}

/**
 * 判断当前步骤是否需要请求用户操作。
 * 首批每个任务最多注入一次，保证链路可预测；规则优先于概率。
 */
function maybeAction(task, step, ctx) {
  if (ctx.actionUsed) return null;

  if (task.confirmFirst && step.step === anchorOf(task, COLLECT_ANCHOR)) return confirmRequest();

  const keywordHit = CONFIRM_KEYWORDS.some((keyword) => task.goal.includes(keyword));
  if (keywordHit && step.step === anchorOf(task, PROCESS_ANCHOR)) return selectionRequest(task);

  // 兜底概率注入：可在设置中关闭，避免自动化测试不稳定
  const isSecondToLast = step.step === task.steps.length - 1;
  if (ctx.randomAction && isSecondToLast && Math.random() < 0.15) return inputRequest();
  return null;
}

// ==================== 结果 ====================

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** 汇总本次执行实际用到的能力（取所有步骤涉及的 Worker 挂载项） */
function collectCapabilities(task) {
  const workerIds = [...new Set(task.steps.map((step) => step.workerId).filter(Boolean))];
  if (!workerIds.length) return { skills: [], connectors: [], knowledge: [] };
  const groups = workerIds.map((id) => capabilityService.resolveWorkerCapabilities(id));
  return {
    skills: uniqueById(groups.flatMap((group) => group.skills)),
    connectors: uniqueById(groups.flatMap((group) => group.connectors)),
    knowledge: uniqueById(groups.flatMap((group) => group.knowledge))
  };
}

/** 取用户提交内容的可读文案（选项取 label，输入取填写值） */
function answerText(request, answer) {
  if (!answer) return '';
  const option = (request.options || []).find((item) => item.value === answer.value);
  if (option) return option.label;
  const values = Object.values(answer.form || {}).filter(Boolean);
  if (values.length) return values.join(' / ');
  return String(answer.value || '');
}

function buildResult(task, worker) {
  const artifacts = (ARTIFACTS[worker?.role] || ARTIFACTS['通用助理']).slice();
  if (task.workspace?.cwd) artifacts.push(`说明-${task.workspace.cwd.replace(/[\\/:*?"<>|]/g, '_')}.txt`);

  const capabilities = collectCapabilities(task);
  const citations = task.steps.flatMap((step) => step.citations || []);
  const answered = answerText(task.actionRequest, task.actionRequest?.answer);

  const parts = [`已围绕「${task.title}」完成 ${task.steps.length} 个步骤`];
  if (answered) parts.push(`采纳了你提交的「${answered}」`);
  if (capabilities.knowledge.length) parts.push(`引用了 ${capabilities.knowledge.length} 个知识库、${citations.length} 条知识片段`);
  if (capabilities.skills.length) parts.push(`使用了 ${capabilities.skills.map((item) => item.title).join('、')}`);

  const capabilityLines = [];
  if (capabilities.skills.length) capabilityLines.push(`Skill：${capabilities.skills.map((item) => item.title).join('、')}`);
  if (capabilities.connectors.length) capabilityLines.push(`连接器：${capabilities.connectors.map((item) => item.title).join('、')}`);
  if (capabilities.knowledge.length) capabilityLines.push(`知识库：${capabilities.knowledge.map((item) => item.title).join('、')}`);

  return {
    summary: `${parts.join('，')}。`,
    text: `本次执行由「${task.assignee.name}」完成，共产出 ${artifacts.length} 项交付物${
      capabilityLines.length ? `；${capabilityLines.join('；')}` : ''
    }。如需调整结论，可直接基于同一目标再次创建任务。`,
    artifacts,
    capabilities: {
      skills: capabilities.skills.map((item) => item.title),
      connectors: capabilities.connectors.map((item) => item.title),
      knowledge: capabilities.knowledge.map((item) => item.title),
      citations
    }
  };
}

module.exports = {
  buildSteps,
  buildFlowSteps,
  stepDelay,
  runStep,
  maybeAction,
  buildResult,
  CONFIRM_KEYWORDS
};