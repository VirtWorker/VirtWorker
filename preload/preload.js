/**
 * 预加载脚本：在渲染进程与主进程之间建立受控的安全桥接。
 * 仅暴露明确需要的 API，不泄漏 Node/Electron 原生能力；
 * 统一返回主进程的原始响应包 { ok, data, error }，由渲染层 api.js 解包。
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('virtworker', {
  /** 应用基础信息 */
  appInfo: {
    name: 'VirtWorker',
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  },

  /** 示例：调用主进程能力（按需扩展） */
  ping: (message) => ipcRenderer.invoke('app:ping', message),

  /** 应用启动数据一次性拉取 */
  bootstrap: () => invoke('app:bootstrap'),

  /** 复制文本到系统剪贴板（由主进程执行，避免渲染层权限限制） */
  copyText: (text) => invoke('app:copy-text', { text }),

  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch)
  },

  worker: {
    list: (query) => invoke('worker:list', query),
    create: (payload) => invoke('worker:create', payload),
    update: (id, patch) => invoke('worker:update', { id, patch }),
    remove: (id) => invoke('worker:remove', { id })
  },

  group: {
    list: () => invoke('group:list'),
    create: (payload) => invoke('group:create', payload),
    update: (id, patch) => invoke('group:update', { id, patch }),
    remove: (id) => invoke('group:remove', { id })
  },

  task: {
    list: (query) => invoke('task:list', query),
    stats: (query) => invoke('task:stats', query),
    create: (payload) => invoke('task:create', payload),
    detail: (id) => invoke('task:detail', { id }),
    cancel: (id, reason) => invoke('task:cancel', { id, reason }),
    ack: (id) => invoke('task:ack', { id }),
    answer: (payload) => invoke('task:answer', payload)
  },

  /** 自主工作：自动任务 */
  automation: {
    list: (query) => invoke('automation:list', query),
    stats: () => invoke('automation:stats'),
    create: (payload) => invoke('automation:create', payload),
    update: (id, patch) => invoke('automation:update', { id, patch }),
    toggle: (id, enabled) => invoke('automation:toggle', { id, enabled }),
    remove: (id) => invoke('automation:remove', { id }),
    detail: (id) => invoke('automation:detail', { id }),
    runtime: () => invoke('automation:runtime')
  },

  /** 订阅主进程事件；返回取消订阅函数 */
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:event', listener);
    return () => ipcRenderer.off('app:event', listener);
  }
});