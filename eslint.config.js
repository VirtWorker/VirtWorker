const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    ignores: ['node_modules/**', 'dist/**', 'docs/**', 'renderer/app.bundle.js'],
    rules: {
      // catch 中不使用 error 变量是本项目的常见惯例（降级处理）
      'no-unused-vars': ['error', { caughtErrors: 'none', args: 'none', ignoreRestSiblings: true }],
      // 既有代码存在少量"先赋默认值再覆盖"的写法，降为警告逐步治理
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn'
    }
  },
  {
    // 主进程与预加载：Node 环境
    files: ['main/**/*.js', 'preload/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    // 渲染层：浏览器环境 + 挂载在 window 上的 VW 命名空间
    files: ['renderer/**/*.js'],
    languageOptions: { globals: { ...globals.browser, VW: 'readonly' } }
  },
  {
    // 测试代码：vitest 全局 API
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.node } }
  }
];
