import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 渲染层视图/组件测试跑 happy-dom；主进程测试保持 node（操作 fs / CJS 单例）
    environmentMatchGlobs: [['tests/renderer*.test.js', 'happy-dom']],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['main/**/*.js'],
      // 低于阈值即测试失败，防止覆盖率无声回退。
      // 基线为 2026-10 实测（stmts 73.6 / branch 64.6 / funcs 68.9 / lines 78.5）留出少量余量
      thresholds: { lines: 70, statements: 70, functions: 60, branches: 60 }
    }
  }
});
