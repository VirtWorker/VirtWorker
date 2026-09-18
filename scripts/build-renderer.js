/**
 * 渲染层打包脚本（esbuild）
 * 背景：渲染层是 12+ 个「挂 window.VW 的 IIFE 全局脚本」，靠 index.html 顺序加载，脆弱且无压缩。
 * 方案：按固定顺序拼接为单一 bundle（保留 IIFE 副作用语义），用 esbuild 压缩并生成 sourcemap。
 *       生产构建与开发启动统一走该 bundle，加载顺序由本脚本保证。
 *
 * 用法：node scripts/build-renderer.js（--watch 进入监听模式，供开发热更新）
 */

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const OUT = path.join(RENDERER, 'app.bundle.js');

/** 加载顺序即依赖顺序：util → api/store → 组件 → 视图 → 入口 */
const FILES = [
  'js/util.js',
  'js/api.js',
  'js/store.js',
  'js/components/toast.js',
  'js/components/dropdown.js',
  'js/components/modal.js',
  'js/components/assignee-select.js',
  'js/views/capabilities-knowledge.js',
  'js/views/capabilities-flows.js',
  'js/views/capabilities-shares.js',
  'js/views/capabilities.js',
  'js/views/workers.js',
  'js/views/dashboard.js',
  'js/views/automations.js',
  'js/views/shell.js',
  'renderer.js'
];

function concat() {
  return FILES.map((file) => `/* ==== ${file} ==== */\n${fs.readFileSync(path.join(RENDERER, file), 'utf8')}`).join(
    '\n;\n'
  );
}

async function build(watch) {
  const options = {
    minify: !watch,
    sourcemap: true,
    legalComments: 'none',
    target: ['chrome120'],
    format: 'iife',
    loader: { '.js': 'js' }
  };

  if (watch) {
    const ctx = await esbuild.context({
      ...options,
      stdin: { contents: concat(), resolveDir: RENDERER, loader: 'js' },
      outfile: OUT,
      write: true
    });
    // 监听源文件变化：任一文件更新即重新拼接
    const rebuild = async () => {
      try {
        await ctx.rebuild();
        console.log('[build] 渲染层已重新打包');
      } catch (error) {
        console.error('[build] 打包失败:', error.message);
      }
    };
    FILES.forEach((file) => {
      fs.watchFile(path.join(RENDERER, file), { interval: 300 }, rebuild);
    });
    await rebuild();
    console.log('[build] 监听模式已启动');
    return;
  }

  await esbuild.build({
    ...options,
    stdin: { contents: concat(), resolveDir: RENDERER, loader: 'js' },
    outfile: OUT
  });
  const size = fs.statSync(OUT).size;
  console.log(`[build] 渲染层打包完成：app.bundle.js (${(size / 1024).toFixed(1)} KB)`);
}

build(process.argv.includes('--watch')).catch((error) => {
  console.error(error);
  process.exit(1);
});
