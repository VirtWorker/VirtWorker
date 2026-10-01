/**
 * 渲染层状态容器
 * - 单一 state 对象承载主进程下发的数据、筛选条件与界面状态
 * - 按「切片名」订阅：数据变更后只重渲染相关区域，避免整页重绘
 */
window.VW = window.VW || {};

VW.store = (() => {
  const state = {
    ready: false,
    workers: [],
    /** Worker 管理页的筛选结果（下拉、侧边栏、编组等使用全量 workers） */
    workerList: [],
    groups: [],
    tasks: [],
    /** 「全部任务」列表的分页窗口元信息（O8：50/页增量加载） */
    tasksMeta: { page: 1, total: 0, totalPages: 1 },
    /** 周期内的任务队列（需要操作 / 查收结果），不受「全部任务」筛选栏影响 */
    queue: { action: [], result: [] },
    stats: { total: 0, running: 0, needAction: 0, finished: 0, workingWorkers: 0 },
    /** 自动任务（自主工作页） */
    automations: [],
    automationStats: { total: 0, enabled: 0, workerCount: 0, flowCount: 0 },
    /** 本地触发端点状态（API 触发） */
    apiServer: { running: false, port: null, error: null },
    /** WorkerFlow 列表（可作为任务/自动任务的执行者） */
    flows: [],
    /** 分享记录（公开项目） */
    shares: [],
    shareStats: { total: 0, publicCount: 0, importTotal: 0 },
    /** @Worker（会话接入）：IM 连接 / 聊天绑定 / 统计 */
    chatConnections: [],
    /** 全量绑定（模型筛选选项、模拟消息预选用） */
    chatBindings: [],
    /** 当前筛选条件下的绑定（表格渲染） */
    chatBindingList: [],
    chatStats: { connections: 0, bindings: 0, enabled: 0, pendingRequests: 0 },
    /** 能力与资源统计（入口卡片计数） */
    capabilityStats: { skill: 0, connector: 0, authorizedConnector: 0, knowledge: 0, chunkTotal: 0, total: 0, nodeTotal: 0, usable: 0 },
    settings: {
      taskView: 'list',
      period: 'month',
      mockRandomAction: true,
      notify: true,
      catchUpMissed: true,
      apiPort: 17891,
      taskRetentionDays: 90,
      theme: 'system'
    },
    filters: {
      task: { keyword: '', assigneeId: '', triggerType: '', status: '', period: 'month' },
      statsPeriod: 'month',
      // 筛选值一律为存储枚举（O12）：中文展示文案由 <option> 负责
      worker: { keyword: '', status: 'online', role: '', env: '', sort: '' },
      automation: { executorId: '', triggerType: '', status: '', sort: '' },
      atworker: { keyword: '', chatType: '', model: '', status: '' }
    },
    ui: {
      page: 'dashboard',
      dashboardTab: 'action',
      manageSeg: 'worker',
      sidebarTab: 'worker',
      sidebarSearch: ''
    }
  };

  const subscribers = new Map();

  function on(slices, handler) {
    const keys = Array.isArray(slices) ? slices : [slices];
    keys.forEach((key) => {
      if (!subscribers.has(key)) subscribers.set(key, new Set());
      subscribers.get(key).add(handler);
    });
    return () => keys.forEach((key) => subscribers.get(key)?.delete(handler));
  }

  function notify(keys) {
    keys.forEach((key) => {
      subscribers.get(key)?.forEach((handler) => {
        try {
          handler(state);
        } catch (error) {
          console.error(`[store] 渲染「${key}」失败:`, error);
        }
      });
    });
  }

  /**
   * 值相等检查（O9）：跳过「数据未变」的无效渲染通知。
   * 主进程每次都返回克隆数据（新对象引用），浅比较必然不等——事件驱动的重复刷新
   * 会触发侧边栏/统计/列表的全量 innerHTML 重建。规模阈值内用序列化比较识别「内容相同」，
   * 超限或比较失败一律视为已变化（宁可多渲染一次，不做深度比较拖慢热路径）。
   */
  const EQUALITY_CHECK_LIMIT = 500;
  function valuesEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.length <= EQUALITY_CHECK_LIMIT) {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch (error) {
        return false;
      }
    }
    return false;
  }

  /** 顶层字段替换：内容未变的切片不赋值（保持引用稳定）也不通知订阅者 */
  function set(patch) {
    const changed = [];
    Object.entries(patch).forEach(([key, value]) => {
      if (valuesEqual(state[key], value)) return;
      state[key] = value;
      changed.push(key);
    });
    notify(changed);
  }

  /** 嵌套切片合并（filters / ui）：内容未变的字段跳过，全部未变时不通知 */
  function merge(section, values) {
    const changed = [];
    Object.entries(values).forEach(([key, value]) => {
      if (valuesEqual(state[section][key], value)) return;
      state[section][key] = value;
      changed.push(key);
    });
    if (changed.length) notify([section]);
  }

  /**
   * 筛选条件变更的唯一入口（替代对 state.filters 的直接赋值）。
   * - setFilters({ statsPeriod: 'week' })            顶层切片
   * - setFilters('task', { keyword: 'abc' })         嵌套切片（浅合并该切片）
   */
  function setFilters(section, values) {
    if (typeof section === 'object' && section !== null) {
      Object.assign(state.filters, section);
    } else {
      Object.assign(state.filters[section], values);
    }
    notify(['filters']);
  }

  /** 执行者下拉选项：Worker / Group / WorkerFlow（任务派发、自动任务执行者共用） */
  function assigneeOptions() {
    const workers = state.workers.map((worker) => ({ value: worker.id, label: `Worker · ${worker.name}` }));
    const groups = state.groups.map((group) => ({ value: group.id, label: `Group · ${group.name}` }));
    const flows = (state.flows || []).map((flow) => ({ value: flow.id, label: `WorkerFlow · ${flow.name}` }));
    return [...workers, ...groups, ...flows];
  }

  return { state, on, set, merge, setFilters, assigneeOptions };
})();