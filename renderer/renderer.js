/**
 * VirtWorker 渲染进程逻辑
 * 当前阶段：整体功能框架 —— 页面路由、标签页切换、新建 Worker 交互流程、
 * 技能市场模拟数据渲染。具体业务功能（任务执行、IM 接入等）后续迭代实现。
 */

// ==================== 工具函数 ====================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let toastTimer = null;
function showToast(msg) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2200);
}

// ==================== 应用状态 ====================

const state = {
  /** 已创建的数字员工（内存态，后续接入持久化） */
  workers: [],
  /** 侧边栏 Worker/Group 标签 */
  sidebarTab: 'worker',
  /** Worker 管理页 分段 */
  manageSeg: 'worker',
  /** 能力与资源页 当前分类 */
  currentCategory: '全部分类'
};

// ==================== 页面路由 ====================

const pageEmptyText = {
  action: { title: '暂无需要操作的任务', desc: '需要你确认、回答或补充信息的任务会显示在这里。' },
  result: { title: '暂无可查收的结果', desc: 'Worker 完成任务后，结果会显示在这里供你查收。' }
};

function switchPage(name) {
  $$('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.page === name);
  });
  $$('.page').forEach((page) => {
    page.classList.toggle('active', page.id === `page-${name}`);
  });
}

$$('.nav-item').forEach((item) => {
  item.addEventListener('click', () => switchPage(item.dataset.page));
});

// ==================== 侧边栏 ====================

$('#collapse-btn').addEventListener('click', () => {
  $('#sidebar').classList.toggle('collapsed');
});

$$('#sidebar-worker-tabs .worker-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.sidebarTab = tab.dataset.wtab;
    $$('#sidebar-worker-tabs .worker-tab').forEach((t) =>
      t.classList.toggle('active', t === tab)
    );
  });
});

// ==================== 通用标签页 ====================

// 任务看板：需要操作 / 查收结果
$$('#dashboard-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('#dashboard-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    const text = pageEmptyText[tab.dataset.tab];
    const empty = $('#dashboard-tab-empty');
    empty.querySelector('.empty-title').textContent = text.title;
    empty.querySelector('.empty-desc').textContent = text.desc;
  });
});

// 能力与资源：技能市场 / 我的技能
$$('#cap-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('#cap-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderSkills();
  });
});

// Worker 管理页：Worker / Group 分段
$$('#manage-segmented .segment').forEach((seg) => {
  seg.addEventListener('click', () => {
    state.manageSeg = seg.dataset.seg;
    $$('#manage-segmented .segment').forEach((s) => s.classList.toggle('active', s === seg));
    renderManagePage();
  });
});

// 视图切换按钮（仅切换激活态，视图实现在后续迭代）
$$('#task-view-toggle .view-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('#task-view-toggle .view-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

// ==================== Worker 数据与渲染 ====================

const workerAvatarColors = [
  'linear-gradient(135deg,#6ee7a0,#10a54a)',
  'linear-gradient(135deg,#8fc2ff,#3d7fe0)',
  'linear-gradient(135deg,#ffd28a,#f5a623)',
  'linear-gradient(135deg,#f0a6d8,#d95fb0)',
  'linear-gradient(135deg,#9ae0e8,#22aab5)'
];

function updateWorkerCounts() {
  $('#sidebar-worker-count').textContent = String(state.workers.length);
  $('#sidebar-group-count').textContent = '0';
  $('#worker-count-label').textContent = `${state.workers.length} 个 Worker`;
}

function renderSidebarWorkers() {
  const list = $('#sidebar-worker-list');
  list.innerHTML = '';
  const online = state.workers.filter((w) => w.status === 'online');
  online.forEach((w) => {
    const item = document.createElement('div');
    item.className = 'sidebar-worker-item';
    item.innerHTML = `
      <span class="avatar" style="background:${w.color}">${escapeHtml(w.name.slice(0, 1))}</span>
      <span class="w-name">${escapeHtml(w.name)}</span>
      <span class="status-dot" title="在线"></span>`;
    item.addEventListener('click', () => switchPage('workers'));
    list.appendChild(item);
  });
  $('#quick-new-worker').classList.toggle('btn-outline', online.length === 0);
}

function renderManagePage() {
  const grid = $('#worker-grid');
  const empty = $('#worker-empty');
  grid.innerHTML = '';

  if (state.manageSeg === 'group') {
    empty.classList.remove('hidden');
    empty.querySelector('.empty-title').textContent = '暂无 Group';
    empty.querySelector('.empty-desc').textContent = '创建 Group 后，可以将多个 Worker 编组协同工作。';
    updateWorkerCounts();
    return;
  }

  if (state.workers.length === 0) {
    empty.classList.remove('hidden');
    empty.querySelector('.empty-title').textContent = '暂无 Worker';
    empty.querySelector('.empty-desc').textContent = '创建Worker后，可以在这里集中管理Worker。';
    updateWorkerCounts();
    return;
  }

  empty.classList.add('hidden');
  state.workers.forEach((w) => {
    const card = document.createElement('div');
    card.className = 'worker-card';
    card.innerHTML = `
      <div class="worker-card-head">
        <span class="avatar" style="background:${w.color}">${escapeHtml(w.name.slice(0, 1))}</span>
        <div>
          <div class="worker-card-name">${escapeHtml(w.name)}</div>
          <div class="worker-card-role">${escapeHtml(w.role)} · ${escapeHtml(w.env)}</div>
        </div>
      </div>
      <div class="worker-card-desc">${w.desc ? escapeHtml(w.desc) : '暂无描述'}</div>
      <div class="worker-card-foot">
        <span class="badge"><span class="status-dot"></span>在线</span>
        <div class="worker-card-actions">
          <button class="mini-btn" data-act="start">开始任务</button>
          <button class="mini-btn" data-act="setting">设置</button>
        </div>
      </div>`;
    card.querySelector('[data-act="start"]').addEventListener('click', () =>
      showToast(`「${w.name}」的任务功能即将上线`)
    );
    card.querySelector('[data-act="setting"]').addEventListener('click', () =>
      showToast(`「${w.name}」设置功能即将上线`)
    );
    grid.appendChild(card);
  });
  updateWorkerCounts();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==================== 新建 Worker 弹窗 ====================

const workerModal = $('#worker-modal');

function openWorkerModal() {
  workerModal.classList.remove('hidden');
  $('#worker-form').reset();
  $('#worker-name-input').focus();
}

function closeWorkerModal() {
  workerModal.classList.add('hidden');
}

$('#new-worker-btn').addEventListener('click', openWorkerModal);
$('#quick-new-worker').addEventListener('click', openWorkerModal);
$('#worker-modal-close').addEventListener('click', closeWorkerModal);
$('#worker-modal-cancel').addEventListener('click', closeWorkerModal);
workerModal.addEventListener('click', (e) => {
  if (e.target === workerModal) closeWorkerModal();
});
document.addEventListener('keydown', (e) => {
  // Esc 关闭弹窗：若焦点在下拉菜单内则交由下拉组件优先处理
  if (e.key === 'Escape' && !workerModal.classList.contains('hidden') && !openDropdown) {
    closeWorkerModal();
  }
});
$$('.empty-action').forEach((btn) => btn.addEventListener('click', openWorkerModal));

$('#worker-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const name = form.name.value.trim();
  if (!name) return;
  const color = workerAvatarColors[state.workers.length % workerAvatarColors.length];
  state.workers.push({
    id: Date.now(),
    name,
    role: form.role.value,
    env: form.env.value,
    desc: form.desc.value.trim(),
    status: 'online',
    color
  });
  renderSidebarWorkers();
  renderManagePage();
  closeWorkerModal();
  showToast(`数字员工「${name}」创建成功`);
});

// ==================== 能力与资源：技能市场 ====================

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

function renderCategories() {
  const wrap = $('#cap-cats');
  wrap.innerHTML = '';
  categories.forEach((cat) => {
    const btn = document.createElement('button');
    btn.className = `cap-cat${cat.name === state.currentCategory ? ' active' : ''}`;
    btn.innerHTML = `<span>${escapeHtml(cat.name)}</span><span class="cat-count">${cat.count.toLocaleString()}</span>`;
    btn.addEventListener('click', () => {
      state.currentCategory = cat.name;
      renderCategories();
    });
    wrap.appendChild(btn);
  });
}

function renderSkills() {
  const grid = $('#skill-grid');
  const empty = $('#skill-empty');
  const isMine = $('#cap-tabs .tab.active')?.dataset.tab === 'mine';
  const source = isMine ? [] : skills;
  const currentCat = categories.find((c) => c.name === state.currentCategory);

  $('#cap-current-cat').textContent = isMine ? '我的技能' : state.currentCategory;
  $('#cap-skill-count').textContent = `${isMine ? 0 : currentCat.count.toLocaleString()} 个 Skill`;

  grid.innerHTML = '';
  empty.classList.toggle('hidden', !isMine ? source.length > 0 : false);
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
    card.addEventListener('click', () => showToast(`「${skill.title}」安装功能即将上线`));
    grid.appendChild(card);
  });
}

// ==================== 能力入口卡片（建设中提示） ====================

$$('.cap-card').forEach((card) => {
  card.addEventListener('click', () => {
    const title = card.querySelector('.cap-title').textContent;
    showToast(`${title} 模块即将上线`);
  });
});

// ==================== 自定义下拉菜单组件 ====================

let openDropdown = null;

const CHEVRON_SVG =
  '<svg class="dropdown-chevron" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
const CHECK_SVG =
  '<svg class="check" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function closeOpenDropdown() {
  if (openDropdown) {
    openDropdown.classList.remove('open');
    openDropdown.querySelector('.dropdown-trigger')?.setAttribute('aria-expanded', 'false');
    openDropdown = null;
  }
}

/**
 * 将原生 <select> 增强为统一风格的自定义下拉组件。
 * 原生 select 保留在 DOM 中（隐藏）以同步表单值，保证 form.xxx.value 等用法不受影响。
 */
function enhanceSelect(select) {
  if (select.classList.contains('dropdown-native')) return;
  select.classList.add('dropdown-native');

  const isBlock = select.classList.contains('modal-select');
  const wrap = document.createElement('span');
  wrap.className = 'dropdown' + (isBlock ? ' dropdown-block' : '');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dropdown-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = `<span class="dropdown-value"></span>${CHEVRON_SVG}`;

  const menu = document.createElement('span');
  menu.className = 'dropdown-menu';
  menu.setAttribute('role', 'listbox');

  const valueEl = trigger.querySelector('.dropdown-value');

  function renderValue() {
    const opt = select.options[select.selectedIndex];
    valueEl.textContent = opt ? opt.textContent : '';
    menu.querySelectorAll('.dropdown-option').forEach((item, i) => {
      item.classList.toggle('selected', i === select.selectedIndex);
      item.setAttribute('aria-selected', i === select.selectedIndex ? 'true' : 'false');
    });
  }

  function buildMenu() {
    menu.innerHTML = '';
    Array.from(select.options).forEach((opt, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dropdown-option';
      item.setAttribute('role', 'option');
      item.tabIndex = -1;
      item.innerHTML = `<span>${escapeHtml(opt.textContent)}</span>${CHECK_SVG}`;
      item.addEventListener('click', () => {
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        renderValue();
        closeOpenDropdown();
        trigger.focus();
      });
      menu.appendChild(item);
    });
    renderValue();
  }

  function open() {
    if (openDropdown === wrap) { closeOpenDropdown(); return; }
    closeOpenDropdown();
    // 若面板展开后超出视口右缘，则改为右对齐
    menu.classList.remove('align-right');
    const rect = wrap.getBoundingClientRect();
    if (rect.left + menu.offsetWidth > window.innerWidth - 12) {
      menu.classList.add('align-right');
    }
    wrap.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    openDropdown = wrap;
    const focused = menu.querySelector('.dropdown-option.selected');
    (focused || menu.querySelector('.dropdown-option'))?.focus({ preventScroll: true });
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    open();
  });

  // 点击容器标签文字区域（label）同样可展开下拉
  const container = select.closest('label');
  if (container) {
    container.addEventListener('click', (e) => {
      if (e.target.closest('.dropdown-menu') || e.target.closest('.dropdown-trigger')) return;
      e.preventDefault();
      open();
    });
  }

  // 键盘交互：上下移动焦点，Enter 选中，Esc 关闭
  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll('.dropdown-option'));
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[Math.min(idx + 1, items.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[Math.max(idx - 1, 0)]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      document.activeElement?.click();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeOpenDropdown();
      trigger.focus();
    }
  });

  select.addEventListener('change', renderValue);

  buildMenu(); // 初始化选项与当前值显示

  select.parentElement.insertBefore(wrap, select);
  wrap.append(trigger, menu, select); // 隐藏的原 select 一并移入组件内
}

function enhanceSelects() {
  document.querySelectorAll('select').forEach(enhanceSelect);

  // 点击组件外部时收起展开的下拉
  document.addEventListener('click', (e) => {
    if (openDropdown && !openDropdown.contains(e.target)) closeOpenDropdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOpenDropdown();
  });
}

// ==================== 初始化 ====================

enhanceSelects();
renderCategories();
renderSkills();
renderManagePage();
updateWorkerCounts();
