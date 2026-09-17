/**
 * 内置技能目录（Skills 市场数据源）
 * 现阶段随应用分发，保证离线可用；后续接入远端市场时只替换本模块的数据来源，
 * 上层的安装/挂载/执行注入逻辑无需改动。
 */

const SKILL_CATEGORIES = [
  { name: '全部分类', key: 'all' },
  { name: 'DevOps 与部署', key: 'devops' },
  { name: '效率工具', key: 'tool' },
  { name: '研究与分析', key: 'research' },
  { name: '内容创作', key: 'writing' },
  { name: '设计与 UI', key: 'design' },
  { name: '数据与 AI', key: 'data' },
  { name: '文档与写作', key: 'docs' }
];

const SKILL_CATALOG = [
  { id: 'sk_research', title: '深入研究', category: 'research', reco: true, color: '#fdeaf1', fg: '#e05299', author: '@Jose-Luis-Nu...', downloads: 30773, desc: '通过来源验证、三角测量和引用支持的报告对技术主题进行系统的深入研究。' },
  { id: 'sk_ui_design', title: 'UI 设计', category: 'design', reco: true, color: '#fdeaf1', fg: '#e05299', author: '@daymade', downloads: 29902, desc: '从参考 UI 图像中提取设计系统并生成可实施的 UI 设计提示。' },
  { id: 'sk_diagram', title: '技术图表生成', category: 'design', reco: true, color: '#eef0f2', fg: '#5c6066', author: '@yofine', downloads: 21929, desc: '帮你把「系统怎么组成、流程怎么走、模块怎么连」画成一张好读的技术示意图。' },
  { id: 'sk_analysis', title: '分析数据分析', category: 'data', reco: false, color: '#e2f5f4', fg: '#159e94', author: '@Mindrally', downloads: 21055, desc: '使用 Python、Jupyter 和现代数据工具实施分析、数据分析和可视化最佳实践。' },
  { id: 'sk_frontend', title: '前端设计', category: 'design', reco: false, color: '#fdeaf1', fg: '#e05299', author: '@pcaro90', downloads: 19209, desc: '创建具有高设计质量的独特的生产级前端界面。' },
  { id: 'sk_bi', title: '智能小Q-数据分析', category: 'data', reco: true, color: '#e8f1fd', fg: '#3d7fe0', author: '@Alibaba Cloud', downloads: 16021, desc: '超级数据分析技能，用户只需自然语言提问，即可智能匹配并分析 Excel 或 Quick BI 数据集。' },
  { id: 'sk_content', title: '内容研究撰写', category: 'writing', reco: false, color: '#e2f5f4', fg: '#159e94', author: '@ComposioHQ', downloads: 15236, desc: '通过进行研究、添加引文、改进挂钩、迭代大纲以及提供每个部分的实时反馈，协助编写高质量内容。' },
  { id: 'sk_market', title: '市场研究报告', category: 'research', reco: false, color: '#e2f5f4', fg: '#159e94', author: '@K-Dense-AI', downloads: 12475, desc: '以顶级咨询公司（麦肯锡、BCG、Gartner）的风格生成全面的市场研究报告（50 多页）。' },
  { id: 'sk_notion_graphic', title: 'Notion 信息图', category: 'design', reco: true, color: '#eef0f2', fg: '#5c6066', author: '@lexburner (dao...', downloads: 11535, desc: '根据参考文档批量生成 Notion 风格松弛感手绘信息图组图。' },
  { id: 'sk_slides', title: '宝玉幻灯片制作', category: 'writing', reco: false, color: '#fdf3e2', fg: '#d98a1f', author: '@TuYv', downloads: 10209, desc: '根据内容生成专业幻灯片，先创建包含样式说明的大纲，再逐页渲染幻灯片图片。' },
  { id: 'sk_image', title: '图像增强器', category: 'tool', reco: false, color: '#fdf3e2', fg: '#d98a1f', author: '@image-tool', downloads: 9877, desc: '通过增强分辨率、清晰度和清晰度来提高图像质量，尤其是屏幕截图的质量。' },
  { id: 'sk_copy', title: '文案写作', category: 'writing', reco: false, color: '#fdeaf1', fg: '#e05299', author: '@copywriter', downloads: 9120, desc: '在撰写标题、着陆页文案、号召性用语、电子邮件主题行或说明性内容时使用此技能。' },
  { id: 'sk_plan', title: '创建计划', category: 'tool', reco: false, color: '#e2f5f4', fg: '#159e94', author: '@planner', downloads: 8543, desc: '将需求转换为可执行的故事，其中包含任务、依赖关系和针对编码执行的技术指导。' },
  { id: 'sk_docs', title: '文档', category: 'docs', reco: false, color: '#eef0f2', fg: '#5c6066', author: '@docs-kit', downloads: 7866, desc: '读取、写入、转换和分析文档 — 通过 PDF、DOCX、XLSX、PPTX 子技能创建与处理文档。' },
  { id: 'sk_excel', title: 'Excel 分析', category: 'data', reco: false, color: '#e2f5f4', fg: '#159e94', author: '@excel-pro', downloads: 6987, desc: '分析 Excel 电子表格、创建数据透视表、生成图表并执行数据分析。' },
  { id: 'sk_cicd', title: 'CI/CD 编排', category: 'devops', reco: false, color: '#e8f1fd', fg: '#3d7fe0', author: '@devops-kit', downloads: 6421, desc: '生成并维护流水线配置，处理构建、测试、发布阶段的环境与密钥注入。' },
  { id: 'sk_log', title: '日志排障', category: 'devops', reco: false, color: '#eef0f2', fg: '#5c6066', author: '@sre-tools', downloads: 5188, desc: '从海量日志中定位异常模式，给出根因线索与修复建议。' },
  { id: 'sk_meeting', title: '会议纪要整理', category: 'tool', reco: false, color: '#fdf3e2', fg: '#d98a1f', author: '@workflow-lab', downloads: 4902, desc: '把会议记录整理成结论、待办与责任人清单。' }
];

/** 分类下的技能数量（用于侧栏计数展示） */
function categoryCounts() {
  const counts = {};
  SKILL_CATALOG.forEach((skill) => {
    counts[skill.category] = (counts[skill.category] || 0) + 1;
  });
  return SKILL_CATEGORIES.map((category) => ({
    ...category,
    count: category.key === 'all' ? SKILL_CATALOG.length : counts[category.key] || 0
  }));
}

module.exports = { SKILL_CATEGORIES, SKILL_CATALOG, categoryCounts };