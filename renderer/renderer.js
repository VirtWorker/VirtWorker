/**
 * 渲染进程脚本：仅通过 preload 暴露的 window.vivictus API 与主进程通信。
 */

function initEnvInfo() {
  const list = document.getElementById('env-list');
  if (!list) return;

  const info = window.vivictus?.appInfo;
  if (!info) {
    list.innerHTML = '<li>未检测到预加载 API，请检查 preload 配置</li>';
    return;
  }

  const items = [
    `应用名称：${info.name}`,
    `Electron：${info.versions.electron}`,
    `Chromium：${info.versions.chrome}`,
    `Node：${info.versions.node}`
  ];
  list.innerHTML = items.map((t) => `<li>${t}</li>`).join('');
}

function initPingDemo() {
  const input = document.getElementById('ping-input');
  const btn = document.getElementById('ping-btn');
  const result = document.getElementById('ping-result');
  if (!input || !btn || !result) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const reply = await window.vivictus.ping(input.value || 'hello');
      result.textContent = reply;
    } catch (err) {
      result.textContent = `调用失败：${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initEnvInfo();
  initPingDemo();
});
