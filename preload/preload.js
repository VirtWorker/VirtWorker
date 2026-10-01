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
    queue: (query) => invoke('task:queue', query),
    export: (query) => invoke('task:export', query),
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
    runtime: () => invoke('automation:runtime'),
    regenToken: (id) => invoke('automation:regen-token', { id }),
    copyInvocation: (id) => invoke('automation:copy-invocation', { id })
  },

  /** 执行器模式（设置中心）：Mock / 真实执行器切换 */
  executor: {
    list: () => invoke('executor:list'),
    activate: (name) => invoke('executor:activate', { name })
  },

  /** 能力与资源：技能 / 连接器 / 知识库 / 挂载 */
  capability: {
    list: (query) => invoke('capability:list', query),
    stats: () => invoke('capability:stats'),
    skillMarket: (query) => invoke('capability:skill-market', query),
    installSkill: (skillId) => invoke('capability:install-skill', { skillId }),
    remove: (id) => invoke('capability:remove', { id }),
    connectorCatalog: () => invoke('capability:connector-catalog'),
    authorize: (key, secret) => invoke('capability:authorize', { key, secret }),
    revoke: (id) => invoke('capability:revoke', { id }),
    pickDirectory: () => invoke('capability:pick-directory'),
    createKnowledge: (payload) => invoke('capability:create-knowledge', payload),
    reindex: (id) => invoke('capability:reindex', { id }),
    search: (id, keyword) => invoke('capability:search', { id, keyword }),
    mount: (id, capabilityIds) => invoke('worker:mount', { id, capabilityIds })
  },

  /** WorkerFlow 编排 */
  flow: {
    list: (query) => invoke('flow:list', query),
    create: (payload) => invoke('flow:create', payload),
    update: (id, patch) => invoke('flow:update', { id, patch }),
    remove: (id) => invoke('flow:remove', { id }),
    detail: (id) => invoke('flow:detail', { id })
  },

  /** 应用级：设置、数据维护、文件对话框 */
  app: {
    dataStats: () => invoke('app:data-stats'),
    openDataDir: () => invoke('app:open-data-dir'),
    relaunch: () => invoke('app:relaunch'),
    purgePreview: () => invoke('app:purge-preview'),
    purgeTasks: () => invoke('app:purge-tasks'),
    backupNow: () => invoke('app:backup-now'),
    backupList: () => invoke('app:backup-list'),
    openBackupsDir: () => invoke('app:open-backups-dir'),
    restoreBackup: (name) => invoke('app:restore-backup', { name }),
    saveFile: (payload) => invoke('app:save-file', payload),
    openFile: () => invoke('app:open-file'),
    copyText: (text) => invoke('app:copy-text', { text })
  },

  /** 分享与公开项目（资源包导出/导入、分享码） */
  share: {
    list: () => invoke('share:list'),
    stats: () => invoke('share:stats'),
    create: (payload) => invoke('share:create', payload),
    setVisibility: (id, visibility) => invoke('share:visibility', { id, visibility }),
    remove: (id) => invoke('share:remove', { id }),
    preview: (code) => invoke('share:preview', { code }),
    importByCode: (code) => invoke('share:import', { code }),
    exportPayload: (resourceType, resourceId) => invoke('share:export', { resourceType, resourceId }),
    importPayload: (payload) => invoke('share:import-payload', payload)
  },

  /** @Worker（会话接入）：IM 连接 / 接入申请 / 聊天绑定 / 模拟入站消息 */
  chat: {
    platforms: () => invoke('chat:platforms'),
    stats: () => invoke('chat:stats'),
    listConnections: () => invoke('chat:connection-list'),
    createConnection: (payload) => invoke('chat:connection-create', payload),
    updateConnection: (id, patch) => invoke('chat:connection-update', { id, patch }),
    removeConnection: (id) => invoke('chat:connection-remove', { id }),
    listChats: (connectionId) => invoke('chat:chats', { connectionId }),
    listRequests: (query) => invoke('chat:request-list', query),
    approveRequest: (id, payload) => invoke('chat:request-approve', { id, ...payload }),
    rejectRequest: (id) => invoke('chat:request-reject', { id }),
    listBindings: (query) => invoke('chat:binding-list', query),
    createBinding: (payload) => invoke('chat:binding-create', payload),
    updateBinding: (id, patch) => invoke('chat:binding-update', { id, patch }),
    toggleBinding: (id, enabled) => invoke('chat:binding-toggle', { id, enabled }),
    removeBinding: (id) => invoke('chat:binding-remove', { id }),
    simulateInbound: (payload) => invoke('chat:simulate-inbound', payload)
  },

  /** 订阅主进程事件；返回取消订阅函数 */
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:event', listener);
    return () => ipcRenderer.off('app:event', listener);
  }
});