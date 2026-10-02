# VirtWorker

> 自定义创建数字员工 Agent 并驱动其协同工作的 Windows 桌面应用。

VirtWorker 让你像管理一支真实团队一样管理数字员工：创建 Worker（或将其编组为 Group），通过**任务看板**、**IM 会话 @Worker**、**自主工作自动化**三条入口派发任务，任务统一进入同一个运行时执行，并在看板上呈现进度、需要人工介入的节点与最终产出。

- 当前版本：0.1.0-Alpha（执行器已内置真实 LLM 实现——OpenAI 兼容接口，Mock 保留用于演示与测试；IM 已支持通用 Webhook 桥接，飞书 / 钉钉等专属适配器按同一契约接入）。已完成一轮可靠性 / 安全加固批次：终态任务保留通道、退出快照收口、快照恢复失败回滚、执行器挂起超时兜底、出站地址校验、Webhook 通知签名等
- 技术栈：Electron 33 · 原生 DOM 渲染层（esbuild 打包）· Vitest
- 许可证：GPL-3.0-only

## 功能总览

| 模块 | 说明 |
| --- | --- |
| 任务看板 | 任务统计卡片、需要操作 / 查收结果页签、列表与看板双视图、多维筛选与搜索、任务详情时间线 |
| Worker 管理 | Worker 的创建、编辑、删除、搜索筛选；Group 建组与编组（可设组长，派发时组长执行、协作成员记入任务时间线）；Worker 导入导出与分享 |
| @Worker | IM 连接管理（内置模拟与通用 Webhook 接入）、聊天接入申请审批、聊天绑定；聊天中 @ Worker 即解析为任务进入看板 |
| 自主工作 | 定时 / 事件 / API 三类触发的自动任务（事件 / API 触发自带最小间隔限流，防任务风暴），调度器常驻补跑错过的定时任务，运行历史可下钻到任务；任务终态可配置 Webhook 出站通知外部系统（失败自动重试） |
| 能力与资源 | Skills 技能市场（挂载的技能作为执行上下文注入 LLM 执行器提示词）、连接器授权、知识库索引、WorkerFlow 编排、公开项目分享 |
| 设置 | 浅色 / 深色 / 跟随系统主题、任务保留期、本地触发端口（修改后重启失败自动回滚） |

三条入口最终收敛为同一种实体 `Task`：会话与自动化只是任务的不同触发来源与输入装配方式，Worker / Group 是执行者，Skills / 知识库 / WorkerFlow 是执行时可调用的能力。

## 核心概念

### 任务状态机

```
                ┌──────────┐
创建/触发 ─────▶ │  queued  │  已创建待派发
                └────┬─────┘
                     │ dispatch（执行者在线）
                     ▼
                ┌──────────┐  request_action   ┌──────────────┐
                │ running  │ ────────────────▶ │ need_action  │
                │          │ ◀──────────────── └──────────────┘
                └────┬─────┘            answer（提交操作）
                     │
      ┌──────────────┼──────────────┐
      │ 成功          │ 失败          │ 用户取消
      ▼              ▼               ▼
 ┌───────────┐  ┌────────┐   ┌──────────┐
 │ succeeded │  │ failed │   │ canceled │
 └─────┬─────┘  └────────┘   └──────────┘
       │ ack（查收，仅置 resultAckedAt，状态不变）
       ▼
    从「查收结果」移出，仍计入「已结束任务」
```

- 执行者离线时任务保持 `queued`，恢复在线后自动派发，不丢失；离线重试按指数退避、上限 10 次（约 1 小时），超限任务落为失败，不产生「永远排队」的僵尸任务；
- 失败 / 取消的任务同样有退出通道：按完成时间走统一的「30 天归档 → 保留期清理」窗口，失败风暴与级联取消不会无限堆积活跃任务（成功任务仍以查收为准，未查收的结果不会消失）；
- `need_action` 是暂停态而非终态：任务执行到需要人工确认 / 回答 / 补充信息时挂起，提交后从当前步骤恢复，并带超时看门狗（fail / continue / remind 三种策略）；
- 单步执行带超时与指数退避重试，失败的任务可从失败步骤断点重跑；创建任务时可选 `timeoutMinutes` 设定总耗时上限，超限自动失败；
- 任务全程产生 `TaskEvent` 时间线，在详情中完整呈现（Group 派发的组长与协作成员也记录在此）。

### 触发来源

| 类型 | 入口 | 说明 |
| --- | --- | --- |
| `manual` | 看板 / Worker 卡片 | 手动创建 |
| `schedule` | 自主工作 | 定时触发（按间隔 / 每小时 / 每天 / 每周 / 仅一次），启动时补跑错过的排程 |
| `event` | 自主工作 | 事件条件触发（与 API 触发同为每自动任务最小 60 秒间隔限流，防失败风暴扇出） |
| `api` | 本地 HTTP 端点 | 脚本或外部工具带 Token 调用（间隔内重复触发返回 429） |
| `chat` | @Worker | IM 聊天中 @ Worker 建任务 |

### 可替换的执行器与 IM 适配器

任务执行器（`main/runtime/executor.js`）与 IM 平台适配器（`main/runtime/im-adapter.js`）均为**注册中心**设计：

- **执行器**：内置 `mock`（可演示、可控）与 `llm` 两个实现——`llm` 调用 OpenAI 兼容 `/chat/completions`（在设置中心配置 API 地址 / 模型 / 密钥，密钥经 `safeStorage` 加密落库；API 地址在保存与请求两处校验，仅 http/https 且拒绝 userinfo），挂载的 Skills 与知识库片段会注入提示词；支持在设置中一键切换，任务执行中途切换不影响进行中的任务；
- **IM 适配器**：内置 `mock`（演示用）与 `webhook`（通用 Webhook 桥接，见下方「IM 入站推送」）；接入飞书 / 钉钉 / Slack 等平台时实现同一接口契约后 `register()` 即可，无需改动运行时与服务层。

## 系统架构

```
┌────────────────────────────────────────────────┐
│ renderer  视图层：只读 state + 订阅事件重渲染      │
│           （原生 DOM，window.VW 命名空间，        │
│             esbuild 打包为单一 bundle）           │
├────────────────────────────────────────────────┤
│ preload   桥接层：contextBridge 白名单 API        │
├────────────────────────────────────────────────┤
│ services  领域层：worker / task / automation /   │
│                   chat / capability / flow /    │
│                   share 服务                     │
├────────────────────────────────────────────────┤
│ runtime   运行时层：task-runtime / scheduler /   │
│           executor(mock→LLM) / im-adapter /     │
│           http-server / event-bus               │
├────────────────────────────────────────────────┤
│ store     持久化层：userData/data/*.json         │
│           原子写 + 双 .bak + 快照 + id 索引        │
│           + schema 版本迁移                       │
└────────────────────────────────────────────────┘
```

设计要点：

- **单一数据源在主进程**：渲染层不落盘、不持有跨会话状态，启动时通过 `app:bootstrap` 一次性拉取；
- **单向数据流**：渲染层发命令（`ipcRenderer.invoke`），主进程校验、写库后经事件总线广播 `app:event`，渲染层增量重渲染；
- **服务与运行时分离**：服务负责校验与持久化，运行时负责调度与执行，均不感知 Electron，可脱离 Electron 单测；
- **安全默认值**：`contextIsolation` + `sandbox` + 禁用 `nodeIntegration`、单实例锁、外链经系统浏览器打开、渲染层入参全部在主进程校验、敏感凭据经 `safeStorage` 加密落盘且不回传渲染层、本地触发端点仅绑定 `127.0.0.1`，自动化 Token 与 IM 入站凭据均经哈希归一的定长比较校验（长期有效，可手动轮换）；出站地址（LLM API / Webhook 通知 / IM 桥接）统一校验仅 http/https 且拒绝 userinfo，认证失败按目标分桶冷却，日志对凭据形态做值级掩码。

## 快速开始

### 环境要求

- Windows 10/11（应用针对 Windows 桌面场景设计）
- Node.js ≥ 20.19（开发工具链要求）
- npm

### 安装与启动

```bash
# 安装依赖
npm install

# 构建 renderer bundle 并启动应用
npm start

# 开发模式（--dev，配合 renderer 监听构建可实时生效）
npm run watch:renderer   # 终端 1：监听 renderer 变更增量构建
npm run dev              # 终端 2：启动应用；追加 --devtools 可自动打开开发者工具
```

### 打包发行

```bash
npm run build            # NSIS 安装包（x64），输出到 dist/
npm run build:portable   # 便携版单文件
npm run build:dir        # 仅输出目录，不打包
```

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm start` | 构建 renderer 后启动应用 |
| `npm run dev` | 开发模式启动（`--dev`） |
| `npm run build:renderer` | esbuild 构建 renderer bundle（启动 / 打包前自动执行） |
| `npm run watch:renderer` | 监听模式构建 renderer，供开发热更新 |
| `npm test` | 运行全部单元测试（Vitest） |
| `npm run test:watch` | 测试监听模式 |
| `npm run test:coverage` | 测试覆盖率报告 |
| `npm run lint` | ESLint 检查 main / preload / renderer / scripts / tests |
| `npm run rebuild` | electron-rebuild 重建原生依赖 |

测试覆盖服务层（含能力安装 / 挂载校验链、连接器授权、聊天分流与节流、终态任务归档 / 清理）、运行时（need_action 暂停 / 恢复、任务级与步骤级超时、执行器计划 / 操作注入挂起的超时兜底、离线重试上限、并发槽位回收，含假定时器用例）、持久化（原子写、`.bak` 回退、schema 迁移幂等、写入节流与退出 flush、并发快照串行化、快照恢复串行化与失败整体回滚）、IPC 契约（统一响应包、通道白名单镜像、`task:create` 经运行时派发到成功的全链路 smoke）与安全组件（secret-vault 密文版本、dir-grant、Webhook 出站重试与签名、入站鉴权与认证分桶冷却、出站 URL 校验、日志凭据掩码、任务入参收敛等），全部不依赖 Electron 运行。覆盖率阈值由 `vitest.config.js` 约束，低于基线即失败。

## 数据存储与安全

- 数据目录：`%APPDATA%/VirtWorker/data/`，按集合拆分 JSON 文件（workers / groups / tasks / taskevents / automations / chats / capabilities / settings 等）；
- 写入合并节流（100ms）以削峰，进程退出前统一 flush；文件写入为「临时文件 + 原子替换」，每次写入前保留最近一份 `.bak` 备份；文件损坏或版本异常时自动回退备份，不阻塞启动；
- schema 带版本号并内置迁移（当前 v2：任务时间线拆分为独立的 `taskevents` 集合），升级应用后旧数据自动迁移；
- 任务生命周期窗口：已查收的成功任务与已定格的失败 / 取消任务超 30 天移入归档集合、超出保留期（默认 90 天，可在设置中调整）连同时间线清理——失败 / 取消按完成时间计龄，失败风暴不再无限堆积活跃任务；未查收的成功结果与挂起中的任务不会被清理；已处理的聊天接入申请按同一保留策略清理；
- 每日维护（启动 30 秒首跑，此后每 24 小时）：任务归档 → 过期清理 → 孤儿时间线 / 孤儿知识库片段清扫 → 聊天申请清理 → 全目录数据快照（`userData/backups/`，保留最近 7 份；快照与写入屏障串行化，可随时在设置中心手动备份 / 恢复；退出前自动等待在途快照收口再落盘，恢复失败自动整体回滚到恢复前状态）；
- 日志位于 `%APPDATA%/VirtWorker/logs/`，按大小轮转，全局异常统一落盘。

### 本地触发 API

应用启动后在本机回环地址开放触发端点（默认端口 `17891`），用于脚本或外部工具触发 API 型自动任务：

```bash
# 存活探针（免鉴权）
curl http://127.0.0.1:17891/health

# 触发指定自动任务（Token 可在对应自动任务详情中查看/轮换）
curl -X POST http://127.0.0.1:17891/automations/<automationId>/run \
  -H "X-VirtWorker-Token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"goal": "覆盖目标（可选）", "payload": {"key": "value"}}'
```

端点仅绑定 `127.0.0.1`，不对外网暴露。Token 经哈希归一的定长比较校验，认证失败按目标分桶计数：单目标连续错误 10 次进入 30 秒冷却（仅该目标 429，不影响其他目标），全局累计错误达 50 次进入全端点冷却，重启端点（修改端口）后复位；同一自动任务 60 秒内重复触发返回 `429`（防脚本风暴），请据此退避。

### IM 入站推送（通用 Webhook 接入）

创建平台为「通用 Webhook」的 IM 连接后，外部 IM 机器人/桥接可把消息推送到本地端点，统一汇入 @Worker 的绑定分流、接入审批与任务创建链路：

```bash
curl -X POST http://127.0.0.1:17891/chat/<connectionId>/inbound \
  -H "X-VirtWorker-Token: <连接凭据>" \
  -H "Content-Type: application/json" \
  -d '{"chatId": "room-1", "chatType": "direct", "sender": "王工", "text": "请整理本周数据"}'
```

- 连接凭据即入站 Token（哈希归一定长比较校验，认证失败按连接分桶冷却）；
- 凭据为 http(s) 地址（群机器人 Webhook 形态）时，任务回执会同步 POST 推送到该地址（10 秒超时；地址须为合法 http/https 且不含 userinfo）；
- 飞书 / 钉钉等专属适配器实现同一 `im-adapter` 契约后 `register()` 即可接入。

### Webhook 出站通知

自动任务可配置 `notify.webhookUrl`，其触发的任务进入终态（`succeeded` / `failed`）时，应用会向该地址 POST 结构化事件（`event=task.finished`，含任务结果摘要与产出物）：

```json
{
  "event": "task.finished",
  "taskId": "...",
  "title": "任务标题",
  "status": "succeeded",
  "automationId": "...",
  "automationName": "...",
  "finishedAt": "...",
  "result": { "summary": "...", "artifacts": [] },
  "error": null
}
```

- 投递失败（网络异常 / 非 2xx）按指数退避自动重试 2 次（单次 10 秒超时）；结果（含重试次数）写入任务时间线供排查，最终失败不影响任务状态；
- 地址经校验（仅 http/https、拒绝 userinfo）后才入库；仅 API / 定时 / 事件型自动任务可配置，手动与聊天任务不投递；
- 可选配置签名密钥（`webhookSecret`）：投递时附 `X-VirtWorker-Signature: sha256=HMAC-SHA256(密钥, 请求体)` 与 `X-VirtWorker-Timestamp` 时间戳头，接收方可据此验证通知确实来自本应用并做重放窗口判断；密钥经 `safeStorage` 加密落库，界面仅显示掩码。

## 项目结构

```
main/
  main.js                # 窗口与生命周期、服务装配、系统通知、每日维护
  ipc/index.js           # IPC 注册中心（通道 → 服务方法，统一 {ok,data,error} 响应）
  ipc/settings.js        # 设置域逻辑：默认值、入参收敛、执行器配置合并与掩码装饰
  store/                 # JSON 集合读写（原子写 + 备份 + id 索引）与 schema 迁移
  services/              # 领域服务：worker / task（生命周期 task-service + 查询治理 task-query）/
                         # automation / chat / capability / flow / share
  runtime/               # 任务运行时、调度器、执行器（mock + LLM）与 IM 适配器注册中心、
                         # 本地触发端点（API 触发 + IM 入站）、Webhook 出站通知、事件总线
  util/                  # 日志、ID、时间、错误码、凭据安全存储（safeStorage）
preload/preload.js       # contextBridge 白名单 API（virtworker.*）
renderer/
  index.html             # 五大模块页面骨架
  js/                    # 视图（views/）与通用组件（components/）、状态 store、API 封装、共享图标
  renderer.js            # 入口装配
scripts/build-renderer.js # esbuild 渲染层打包脚本
tests/                   # Vitest 单元测试（22 个测试文件）
docs/design-blueprint.md # 功能逻辑设计蓝图（含实现状态注记）
```

## 设计文档

完整的产品设计、领域模型、数据契约（IPC 通道 / 事件 / 错误码）、状态机口径与实施路线详见 [docs/design-blueprint.md](docs/design-blueprint.md)。

## 路线图

- [x] Phase 1 任务体系 + 任务看板（持久化、状态机、运行时、看板口径）
- [x] Phase 2 自主工作（Automation + 调度器 + 本地 API 触发端点 + 运行历史）
- [x] Phase 3 @Worker（IM 连接 / 聊天绑定 / 接入审批 + 会话转任务，含通用 Webhook 桥接）
- [x] Phase 4 能力与资源（技能 / 连接器 / 知识库 / WorkerFlow / 公开项目）
- [ ] Phase 5 真实执行器与真实 IM 平台接入（OpenAI 兼容 LLM 执行器与通用 Webhook 桥接已就绪，剩飞书 / 钉钉 / Slack 等专属适配器）
- [ ] 数据规模增长后按需切换 SQLite（store 接口已屏蔽实现，结构化查询与 id 索引已按可翻译谓词收敛）

## 参与开发

欢迎提交 Issue 与 Pull Request。仓库配有 GitHub Actions（Windows runner：`npm ci` → lint → test → coverage 阈值检查），提交前请确保本地：

```bash
npm run lint   # 无 ESLint 告警
npm test       # 全部测试通过
```

## 许可证

[GPL-3.0-only](LICENSE) © VirtWorker Team
