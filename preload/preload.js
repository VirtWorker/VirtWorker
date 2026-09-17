const { contextBridge, ipcRenderer } = require('electron');

/**
 * 预加载脚本：在渲染进程与主进程之间建立受控的安全桥接。
 * 仅暴露明确需要的 API，不泄漏 Node/Electron 原生能力。
 */

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
  ping: (message) => ipcRenderer.invoke('app:ping', message)
});
