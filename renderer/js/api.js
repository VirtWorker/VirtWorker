/**
 * 主进程 API 封装
 * 统一解包 { ok, data, error }，失败时抛出带 code 的错误，由调用方决定提示文案。
 */
window.VW = window.VW || {};

VW.api = (() => {
  const bridge = window.virtworker;

  async function call(invoker, ...args) {
    if (!bridge || typeof invoker !== 'function') {
      const error = new Error('主进程服务不可用，请重启应用');
      error.code = 'INTERNAL';
      throw error;
    }
    const response = await invoker(...args);
    if (response && response.ok) return response.data;
    const error = new Error(response?.error?.message || '操作失败');
    error.code = response?.error?.code || 'INTERNAL';
    error.details = response?.error?.details || null;
    throw error;
  }

  return {
    bootstrap: () => call(bridge?.bootstrap),

    /** 复制文本到系统剪贴板 */
    copyText: (text) => call(bridge?.app?.copyText, text),

    app: {
      dataStats: () => call(bridge?.app?.dataStats),
      openDataDir: () => call(bridge?.app?.openDataDir),
      relaunch: () => call(bridge?.app?.relaunch),
      purgePreview: () => call(bridge?.app?.purgePreview),
      purgeTasks: () => call(bridge?.app?.purgeTasks),
      saveFile: (payload) => call(bridge?.app?.saveFile, payload),
      openFile: () => call(bridge?.app?.openFile)
    },

    share: {
      list: () => call(bridge?.share?.list),
      stats: () => call(bridge?.share?.stats),
      create: (payload) => call(bridge?.share?.create, payload),
      setVisibility: (id, visibility) => call(bridge?.share?.setVisibility, id, visibility),
      remove: (id) => call(bridge?.share?.remove, id),
      preview: (code) => call(bridge?.share?.preview, code),
      importByCode: (code) => call(bridge?.share?.importByCode, code),
      exportPayload: (resourceType, resourceId) => call(bridge?.share?.exportPayload, resourceType, resourceId),
      importPayload: (payload) => call(bridge?.share?.importPayload, payload)
    },

    settings: {
      get: () => call(bridge?.settings?.get),
      update: (patch) => call(bridge?.settings?.update, patch)
    },

    worker: {
      list: (query) => call(bridge?.worker?.list, query),
      create: (payload) => call(bridge?.worker?.create, payload),
      update: (id, patch) => call(bridge?.worker?.update, id, patch),
      remove: (id) => call(bridge?.worker?.remove, id)
    },

    group: {
      list: () => call(bridge?.group?.list),
      create: (payload) => call(bridge?.group?.create, payload),
      update: (id, patch) => call(bridge?.group?.update, id, patch),
      remove: (id) => call(bridge?.group?.remove, id)
    },

    task: {
      list: (query) => call(bridge?.task?.list, query),
      stats: (query) => call(bridge?.task?.stats, query),
      create: (payload) => call(bridge?.task?.create, payload),
      detail: (id) => call(bridge?.task?.detail, id),
      cancel: (id, reason) => call(bridge?.task?.cancel, id, reason),
      ack: (id) => call(bridge?.task?.ack, id),
      answer: (payload) => call(bridge?.task?.answer, payload)
    },

    automation: {
      list: (query) => call(bridge?.automation?.list, query),
      stats: () => call(bridge?.automation?.stats),
      create: (payload) => call(bridge?.automation?.create, payload),
      update: (id, patch) => call(bridge?.automation?.update, id, patch),
      toggle: (id, enabled) => call(bridge?.automation?.toggle, id, enabled),
      remove: (id) => call(bridge?.automation?.remove, id),
      detail: (id) => call(bridge?.automation?.detail, id),
      runtime: () => call(bridge?.automation?.runtime),
      regenToken: (id) => call(bridge?.automation?.regenToken, id),
      copyInvocation: (id) => call(bridge?.automation?.copyInvocation, id)
    },

    /** 执行器模式（设置中心）：Mock / 真实执行器切换 */
    executor: {
      list: () => call(bridge?.executor?.list),
      activate: (name) => call(bridge?.executor?.activate, name)
    },

    capability: {
      list: (query) => call(bridge?.capability?.list, query),
      stats: () => call(bridge?.capability?.stats),
      skillMarket: (query) => call(bridge?.capability?.skillMarket, query),
      installSkill: (skillId) => call(bridge?.capability?.installSkill, skillId),
      remove: (id) => call(bridge?.capability?.remove, id),
      connectorCatalog: () => call(bridge?.capability?.connectorCatalog),
      authorize: (key, secret) => call(bridge?.capability?.authorize, key, secret),
      revoke: (id) => call(bridge?.capability?.revoke, id),
      pickDirectory: () => call(bridge?.capability?.pickDirectory),
      createKnowledge: (payload) => call(bridge?.capability?.createKnowledge, payload),
      reindex: (id) => call(bridge?.capability?.reindex, id),
      search: (id, keyword) => call(bridge?.capability?.search, id, keyword),
      mount: (id, capabilityIds) => call(bridge?.capability?.mount, id, capabilityIds)
    },

    flow: {
      list: (query) => call(bridge?.flow?.list, query),
      create: (payload) => call(bridge?.flow?.create, payload),
      update: (id, patch) => call(bridge?.flow?.update, id, patch),
      remove: (id) => call(bridge?.flow?.remove, id),
      detail: (id) => call(bridge?.flow?.detail, id)
    },

    /** @Worker（会话接入） */
    chat: {
      platforms: () => call(bridge?.chat?.platforms),
      stats: () => call(bridge?.chat?.stats),
      listConnections: () => call(bridge?.chat?.listConnections),
      createConnection: (payload) => call(bridge?.chat?.createConnection, payload),
      updateConnection: (id, patch) => call(bridge?.chat?.updateConnection, id, patch),
      removeConnection: (id) => call(bridge?.chat?.removeConnection, id),
      listChats: (connectionId) => call(bridge?.chat?.listChats, connectionId),
      listRequests: (query) => call(bridge?.chat?.listRequests, query),
      approveRequest: (id, payload) => call(bridge?.chat?.approveRequest, id, payload),
      rejectRequest: (id) => call(bridge?.chat?.rejectRequest, id),
      listBindings: (query) => call(bridge?.chat?.listBindings, query),
      createBinding: (payload) => call(bridge?.chat?.createBinding, payload),
      updateBinding: (id, patch) => call(bridge?.chat?.updateBinding, id, patch),
      toggleBinding: (id, enabled) => call(bridge?.chat?.toggleBinding, id, enabled),
      removeBinding: (id) => call(bridge?.chat?.removeBinding, id),
      simulateInbound: (payload) => call(bridge?.chat?.simulateInbound, payload)
    },

    /** 订阅主进程事件，返回取消订阅函数 */
    onEvent: (handler) => (bridge?.onEvent ? bridge.onEvent(handler) : () => {})
  };
})();