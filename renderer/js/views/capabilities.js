/**
 * 能力与资源页：技能市场 / 我的技能
 * 当前阶段保持既有假数据渲染；安装、连接器、知识库、WorkerFlow 将在后续阶段补全。
 */
window.VW = window.VW || {};

VW.views = VW.views || {};

VW.views.capabilities = (() => {
  const { escapeHtml } = VW.util;

  const categories = [
    { name: '全部分类', count: 43700 },
    { name: 'DevOps 与部署', count: 12629 },
    { name: '效率工具', count: 12516 },
    { name: '研究与分析', count: 3362 },
    { name: '内容创作', count: 7281 },
    { name: '设计与 UI', count: 3891 },
    { name: '数据与 AI', count: 3034 },
    { name: '文档与写作', count: 3939 }
  ];

  /** 技能市场模拟数据（参照产品规划填充，后续接入真实数据源） */
  const skills = [
    { title: '深入研究', reco: true, color: '#fdeaf1', fg: '#e05299', desc: '通过来源验证、三角测量和引用支持的报告对技术主题进行系统的深入研究。', author: '@Jose-Luis-Nu...', downloads: 30773 },
    { title: 'UI 设计', reco: true, color: '#fdeaf1', fg: '#e05299', desc: '从参考 UI 图像中提取设计系统并生成可实施的 UI 设计提示。', author: '@daymade', downloads: 29902 },
    { title: '技术图表生成', reco: true, color: '#eef0f2', fg: '#5c6066', desc: '帮你把「系统怎么组成、流程怎么走、模块怎么连」画成一张好读的技术示意图，看起来像工程。', author: '@yofine', downloads: 21929 },
    { title: '分析数据分析', reco: false, color: '#e2f5f4', fg: '#159e94', desc: '使用 Python、Jupyter 和现代数据工具实施分析、数据分析和可视化最佳实践。', author: '@Mindrally', downloads: 21055 },
    { title: '前端设计', reco: false, color: '#fdeaf1', fg: '#e05299', desc: '创建具有高设计质量的独特的生产级前端界面。', author: '@pcaro90', downloads: 19209 },
    { title: '智能小Q-数据分析', reco: true, color: '#e8f1fd', fg: '#3d7fe0', desc: '超级数据分析技能，用户只需自然语言提问，即可智能匹配并分析 Excel 或 Quick BI 数据集。', author: '@Alibaba Cloud', downloads: 16021 },
    { title: '内容研究撰写', reco: false, color: '#e2f5f4', fg: '#159e94', desc: '通过进行研究、添加引文、改进挂钩、迭代大纲以及提供每个部分的实时反馈，协助编写高质量内容。', author: '@ComposioHQ', downloads: 15236 },
    { title: '市场研究报告', reco: false, color: '#e2f5f4', fg: '#159e94', desc: '以顶级咨询公司（麦肯锡、BCG、Gartner）的风格生成全面的市场研究报告（50 多页）。', author: '@K-Dense-AI', downloads: 12475 },
    { title: 'Notion 信息图', reco: true, color: '#eef0f2', fg: '#5c6066', desc: '根据参考文档批量生成 Notion 风格松弛感手绘信息图组图，当用户需要阅读文档并生成一组可视化信息图时使用。', author: '@lexburner (dao...', downloads: 11535 },
    { title: '宝玉幻灯片制作', reco: false, color: '#fdf3e2', fg: '#d98a1f', desc: '根据内容生成专业幻灯片，先创建包含样式说明的大纲，再逐页渲染幻灯片图片。', author: '@TuYv', downloads: 10209 },
    { title: '图像增强器', reco: false, color: '#fdf3e2', fg: '#d98a1f', desc: '通过增强分辨率、清晰度和清晰度来提高图像质量，尤其是屏幕截图的质量。', author: '@image-tool', downloads: 9877 },
    { title: '文案写作', reco: false, color: '#fdeaf1', fg: '#e05299', desc: '在撰写标题、着陆页文案、号召性用语、电子邮件主题行或说明性内容时使用此技能。', author: '@copywriter', downloads: 9120 },
    { title: '创建计划', reco: false, color: '#e2f5f4', fg: '#159e94', desc: '将需求转换为可执行的故事，其中包含任务、依赖关系和针对编码执行的针对性的技术指导。', author: '@planner', downloads: 8543 },
    { title: '文档', reco: false, color: '#eef0f2', fg: '#5c6066', desc: '读取、写入、转换和分析文档 — 通过 PDF、DOCX、XLSX、PPTX 子技能的路径，用于创建和处理文档。', author: '@docs-kit', downloads: 7866 },
    { title: 'Excel 分析', reco: false, color: '#e2f5f4', fg: '#159e94', desc: '分析 Excel 电子表格、创建数据透视表、生成图表并执行数据分析。', author: '@excel-pro', downloads: 6987 }
  ];

  const state = { currentCategory: '全部分类' };

  function renderCategories() {
    const wrap = document.getElementById('cap-cats');
    wrap.innerHTML = '';
    categories.forEach((category) => {
      const button = document.createElement('button');
      button.className = `cap-cat${category.name === state.currentCategory ? ' active' : ''}`;
      button.innerHTML = `<span>${escapeHtml(category.name)}</span><span class="cat-count">${category.count.toLocaleString()}</span>`;
      button.addEventListener('click', () => {
        state.currentCategory = category.name;
        renderCategories();
      });
      wrap.appendChild(button);
    });
  }

  function renderSkills() {
    const grid = document.getElementById('skill-grid');
    const empty = document.getElementById('skill-empty');
    const isMine = document.querySelector('#cap-tabs .tab.active')?.dataset.tab === 'mine';
    const source = isMine ? [] : skills;
    const currentCategory = categories.find((item) => item.name === state.currentCategory);

    document.getElementById('cap-current-cat').textContent = isMine ? '我的技能' : state.currentCategory;
    document.getElementById('cap-skill-count').textContent = `${isMine ? 0 : currentCategory.count.toLocaleString()} 个 Skill`;

    grid.innerHTML = '';
    empty.classList.toggle('hidden', isMine ? false : source.length === 0);
    if (isMine) {
      empty.querySelector('.empty-title').textContent = '暂无已安装的技能';
      empty.querySelector('.empty-desc').textContent = '前往技能市场探索并安装 Skill。';
      return;
    }

    source.forEach((skill) => {
      const card = document.createElement('div');
      card.className = 'skill-card';
      card.innerHTML = `
        <div class="skill-head">
          <span class="skill-icon" style="background:${skill.color};color:${skill.fg}">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>
          </span>
          <span class="skill-title">${escapeHtml(skill.title)}</span>
          ${skill.reco ? '<span class="reco-badge">推荐</span>' : ''}
        </div>
        <div class="skill-desc">${escapeHtml(skill.desc)}</div>
        <div class="skill-foot">
          <span class="skill-author">作者 ${escapeHtml(skill.author)}</span>
          <span class="skill-down">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            ${skill.downloads.toLocaleString()}
          </span>
        </div>`;
      card.addEventListener('click', () => VW.toast.show(`「${skill.title}」安装功能即将上线`));
      grid.appendChild(card);
    });
  }

  function init() {
    document.querySelectorAll('#cap-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#cap-tabs .tab').forEach((item) => item.classList.toggle('active', item === tab));
        renderSkills();
      });
    });
    renderCategories();
    renderSkills();
  }

  return { init, renderSkills };
})();