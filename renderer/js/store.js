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
    /** 周期内的任务队列（需要操作 / 查收结果），不受「全部任务」筛选栏影响 */
    queue: { action: [], result: [] },
    stats: { total: 0, running: 0, needAction: 0, finished: 0, workingWorkers: 0 },
    settings: { taskView: 'list', period: 'month', mockRandomAction: true, notify: true },
    filters: {
      task: { keyword: '', assigneeId: '', triggerType: '', status: '', period: 'month' },
      statsPeriod: 'month',
      worker: { keyword: '', status: '在线', role: '', env: '', sort: '' }
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

  /** 顶层字段替换 */
  function set(patch) {
    const keys = Object.keys(patch);
    Object.assign(state, patch);
    notify(keys);
  }

  /** 嵌套切片合并（filters / ui） */
  function merge(section, values) {
    Object.assign(state[section], values);
    notify([section]);
  }

  return { state, on, set, merge };
})();