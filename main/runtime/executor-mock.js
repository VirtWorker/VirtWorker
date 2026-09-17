/**
 * 模拟执行器（首批）
 * 目标：让「创建 → 执行 → 需要操作 → 恢复 → 产出」整条链路可演示、可复现，
 *       且不依赖任何外部账号与网络。后续以同样的接口替换为真实 LLM 执行器。
 */

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

/** 单步耗时（毫秒），保留随机性以贴近真实执行观感 */
const MIN_STEP_MS = 300;
const MAX_STEP_MS = 900;

function buildSteps(task, worker) {
  const titles = ROLE_STEPS[worker?.role] || ROLE_STEPS['通用助理'];
  return titles.map((title, index) => ({
    step: index + 1,
    title,
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    log: ''
  }));
}

function stepDelay() {
  return Math.round(MIN_STEP_MS + Math.random() * (MAX_STEP_MS - MIN_STEP_MS));
}

/** 生成过程日志：用目标长度派生伪随机数量，保证同一任务日志稳定 */
function stepLog(task, step) {
  const seed = task.goal.length + step.step * 7;
  const count = (seed % 20) + 6;
  const title = step.title;

  if (title.includes('理解')) {
    return `已解析目标与约束：${task.goal.slice(0, 40)}${task.goal.length > 40 ? '…' : ''}`;
  }
  if (title.includes('收集') || title.includes('定位')) {
    return title.includes('代码')
      ? `已定位 ${count} 处相关实现`
      : `已收集 ${count} 条相关素材`;
  }
  if (title.includes('统计') || title.includes('分析')) {
    return `已完成统计与聚类，得到 ${Math.max(2, count - 4)} 个关键结论`;
  }
  if (title.includes('撰写') || title.includes('实现')) {
    return '已完成初稿实现并自测通过';
  }
  if (title.includes('生成') || title.includes('产出') || title.includes('定稿') || title.includes('报告')) {
    return '已生成交付物（模拟）';
  }
  return `${title}已完成`;
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

/**
 * 判断当前步骤是否需要请求用户操作。
 * 首批每个任务最多注入一次，保证链路可预测；规则优先于概率。
 */
function maybeAction(task, step, ctx) {
  if (ctx.actionUsed) return null;

  if (task.confirmFirst && step.step === 2) return confirmRequest();
  if (CONFIRM_KEYWORDS.some((keyword) => task.goal.includes(keyword)) && step.step === 3) {
    return selectionRequest(task);
  }
  // 兜底概率注入：可在设置中关闭，避免自动化测试不稳定
  const isSecondToLast = step.step === task.steps.length - 1;
  if (ctx.randomAction && isSecondToLast && Math.random() < 0.15) return inputRequest();
  return null;
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

  const answered = answerText(task.actionRequest, task.actionRequest?.answer);
  const extra = answered ? `，并采纳了你在执行中提交的「${answered}」` : '';

  return {
    summary: `已围绕「${task.title}」完成 ${task.steps.length} 个步骤${extra}。`,
    text: `本次执行由「${task.assignee.name}」完成，共产出 ${artifacts.length} 项交付物；如需调整结论，可直接基于同一目标再次创建任务。`,
    artifacts
  };
}

module.exports = { buildSteps, stepDelay, stepLog, maybeAction, buildResult, CONFIRM_KEYWORDS };