/**
 * 测试辅助：为每个测试文件准备独立的临时数据目录，初始化主进程的 JSON 存储（db）。
 *
 * 重要：被测的生产模块（db/bus/service/scheduler 等）之间用 CJS require 互相引用并共享
 * Node 的 require.cache 单例。若测试用 ESM import 加载它们，vite 会生成独立的 ESM 包装，
 * 导致 db 等单例分裂成两个实例（测试读写一份、服务读写另一份）。因此这里统一用
 * createRequire 加载生产模块，确保与运行时命中同一份 require.cache。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 创建临时目录并初始化 db；返回 dir 供测试结束后清理 */
export function initTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtworker-test-'));
  const db = require('../main/store/db');
  db.init(path.join(dir, 'data'));
  return dir;
}

export function cleanupTempDb(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    /* 忽略清理失败 */
  }
}

// 以 CJS 单例形式导出生产模块，供测试直接引用（与 service 内部 require 同源）
export const db = require('../main/store/db');
export const bus = require('../main/runtime/event-bus');
export const scheduler = require('../main/runtime/scheduler');
export const executor = require('../main/runtime/executor');
export const runtime = require('../main/runtime/task-runtime');
export const workerService = require('../main/services/worker-service');
export const automationService = require('../main/services/automation-service');
export const flowService = require('../main/services/flow-service');
export const taskService = require('../main/services/task-service');
export const shareService = require('../main/services/share-service');
export const chatService = require('../main/services/chat-service');
export const { nowIso } = require('../main/util/time');
