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
  { name: '文档与写作', key: 'docs' },
  { name: '自动化与流程', key: 'automation' },
  { name: '安全合规', key: 'security' }
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
  { id: 'sk_meeting', title: '会议纪要整理', category: 'tool', reco: false, color: '#fdf3e2', fg: '#d98a1f', author: '@workflow-lab', downloads: 4902, desc: '把会议记录整理成结论、待办与责任人清单。' },
  // ---- DevOps 与部署 ----
  { id: 'sk_docker', title: '容器运维', category: 'devops', reco: false, color: '#e8f1fd', fg: '#3d7fe0', author: '@container-kit', downloads: 4812, desc: '生成 Dockerfile 与 Compose 配置，诊断容器运行时问题并给出资源优化建议。' },
  { id: 'sk_dbops', title: '数据库运维', category: 'devops', reco: false, color: '#e8f1fd', fg: '#3d7fe0', author: '@dba-tools', downloads: 4310, desc: 'SQL 调优、慢查询分析与索引建议，覆盖主流关系型数据库的日常运维任务。' },
  { id: 'sk_monitor', title: '监控告警分析', category: 'devops', reco: false, color: '#eef0f2', fg: '#5c6066', author: '@sre-tools', downloads: 3906, desc: '解读 Prometheus / Grafana 指标，定位告警根因并生成值班处置建议。' },
  // ---- 效率工具 ----
  { id: 'sk_rss', title: '信息聚合', category: 'tool', reco: false, color: '#e2f5f4', fg: '#159e94', author: '@feed-lab', downloads: 4668, desc: '订阅并聚合多源资讯，按主题去重排序，输出每日简报。' },
  { id: 'sk_files', title: '批量文件处理', category: 'tool', reco: false, color: '#eef0f2', fg: '#5c6066', author: '@file-ops', downloads: 4155, desc: '批量重命名、格式转换、内容抽取与归档整理，规则可复用。' },
  { id: 'sk_schedule', title: '日程规划', category: 'tool', reco: false, color: '#fdf3e2', fg: '#d98a1f', author: '@planner', downloads: 3624, desc: '把目标拆解为周计划与日程块，平衡优先级与可用时间。' },
  // ---- 研究与分析 ----
  { id: 'sk_compare', title: '竞品分析', category: 'research', reco: false, color: '#e2f5f4', fg: '#159e94', author: '@market-research', downloads: 4477, desc: '从定价、功能矩阵、用户口碑多维度对比竞品，输出结构化竞争格局报告。' },
  { id: 'sk_paper', title: '论文速读', category: 'research', reco: false, color: '#fdeaf1', fg: '#e05299', author: '@scholar-ai', downloads: 4092, desc: '快速提炼论文的贡献、方法与局限，生成通俗版导读与延伸问题清单。' },
  { id: 'sk_trend', title: '行业趋势追踪', category: 'research', reco: false, color: '#e8f1fd', fg: '#3d7fe0', author: '@trendwatch', downloads: 3551, desc: '聚合行业报告与新闻，识别技术趋势拐点并评估其影响。' },
  // ---- 内容创作 ----
  { id: 'sk_seo', title: 'SEO 内容优化', category: 'writing', reco: false, color: '#e2f5f4', fg: '#159e94', author: '@growth-writer', downloads: 4389, desc: '面向搜索意图优化文章结构与关键词布局，兼顾可读性与收录效果。' },
  { id: 'sk_social', title: '社媒文案', category: 'writing', reco: false, color: '#fdeaf1', fg: '#e05299', author: '@social-kit', downloads: 3965, desc: '为公众号、小红书、微博等平台生成符合语境的短文案与话题标签。' },
  { id: 'sk_news', title: '新闻快讯', category: 'writing', reco: false, color: '#eef0f2', fg: '#5c6066', author: '@newsroom', downloads: 3410, desc: '把原始素材压缩为倒金字塔结构的快讯，标题与摘要一次到位。' },
  // ---- 设计与 UI ----
  { id: 'sk_ux', title: '交互评审', category: 'design', reco: false, color: '#fdeaf1', fg: '#e05299', author: '@ux-review', downloads: 4251, desc: '按可用性启发式逐项审查界面流程，输出问题清单与改进优先级。' },
  { id: 'sk_brand', title: '品牌规范', category: 'design', reco: false, color: '#fdf3e2', fg: '#d98a1f', author: '@brand-kit', downloads: 3733, desc: '从现有素材提炼品牌色板、字体与语气规范，并生成使用指南。' },
  { id: 'sk_icon', title: '图标设计', category: 'design', reco: false, color: '#eef0f2', fg: '#5c6066', author: '@icon-forge', downloads: 3286, desc: '批量生成风格统一的线性 / 面性图标方案，可导出为 SVG 规格。' },
  // ---- 数据与 AI ----
  { id: 'sk_sql', title: 'SQL 助手', category: 'data', reco: false, color: '#e2f5f4', fg: '#159e94', author: '@sql-buddy', downloads: 4530, desc: '自然语言转 SQL，解释执行计划并优化慢查询，支持主流方言。' },
  { id: 'sk_crawler', title: '网页采集', category: 'data', reco: false, color: '#e8f1fd', fg: '#3d7fe0', author: '@crawler-kit', downloads: 3847, desc: '按规则抓取并清洗公开网页数据，输出结构化表格（遵守站点访问约定）。' },
  { id: 'sk_viz', title: '数据可视化', category: 'data', reco: false, color: '#fdeaf1', fg: '#e05299', author: '@viz-studio', downloads: 3375, desc: '为数据集匹配合适的图表类型，生成可复用的可视化配置。' },
  // ---- 文档与写作 ----
  { id: 'sk_api_docs', title: 'API 文档', category: 'docs', reco: false, color: '#e8f1fd', fg: '#3d7fe0', author: '@docs-kit', downloads: 4178, desc: '从代码与接口定义生成 API 参考文档，含示例请求与错误码表。' },
  { id: 'sk_translate', title: '技术翻译', category: 'docs', reco: false, color: '#e2f5f4', fg: '#159e94', author: '@lingo', downloads: 3688, desc: '保持术语一致的技术文档翻译，自动维护双语术语表。' },
  { id: 'sk_sop', title: '操作手册', category: 'docs', reco: false, color: '#eef0f2', fg: '#5c6066', author: '@sop-writer', downloads: 3244, desc: '把操作流程整理为可执行的标准作业程序（SOP），含异常处理分支。' },
  // ---- 自动化与流程 ----
  { id: 'sk_rpa', title: '流程自动化', category: 'automation', reco: false, color: '#e8f1fd', fg: '#3d7fe0', author: '@rpa-lab', downloads: 4566, desc: '把重复的网页 / 桌面操作编排为可重复执行的自动化流程。' },
  { id: 'sk_emailtriage', title: '邮件分诊', category: 'automation', reco: false, color: '#fdeaf1', fg: '#e05299', author: '@inbox-ops', downloads: 3598, desc: '按紧急度与主题给邮件分类打标，草拟回复并汇总待办。' },
  { id: 'sk_report', title: '日报周报生成', category: 'automation', reco: false, color: '#fdf3e2', fg: '#d98a1f', author: '@report-bot', downloads: 3122, desc: '从任务系统与文档中汇总进展，生成结构化的日报 / 周报。' },
  // ---- 安全合规 ----
  { id: 'sk_codesec', title: '代码安全扫描', category: 'security', reco: false, color: '#eef0f2', fg: '#5c6066', author: '@sec-kit', downloads: 3991, desc: '按常见漏洞清单（注入 / 越权 / 敏感信息）审查代码并给出修复建议。' },
  { id: 'sk_audit', title: '合规自查', category: 'security', reco: false, color: '#e2f5f4', fg: '#159e94', author: '@compliance', downloads: 2957, desc: '对照通用合规基线检查数据收集与存储约定，输出差距清单。' }
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