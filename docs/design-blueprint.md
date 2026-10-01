# VirtWorker 功能逻辑补全设计蓝图

- 版本：v1.0（2026-09-17）
- 适用范围：对界面**已展示但尚未实现**的功能模块做业务逻辑补全设计，并给出与现有 Electron 框架的集成方案
- 首批落地范围：**任务体系 + 任务看板**（本地持久化 + 模拟执行），其余模块在本蓝图中给出设计并排入后续阶段
- 阅读顺序建议：第 1–2 章（共识）→ 第 3 章（数据契约）→ 第 5–6 章（集成规范）→ 第 4 章 4.1（首批实现）→ 第 7 章（排期）

---

## 1. 产品定位与设计主轴

VirtWorker 是「自定义创建数字员工 Agent 并驱动其协同工作」的 Windows 桌面应用。当前界面已完整呈现三条业务主轴与两条资源轴：

| 轴 | 页面 | 用户心智 |
| --- | --- | --- |
| 事 | 任务看板 | 从「事」出发：Worker 做了什么、要我做什么、结果如何 |
| 会话 | @Worker | 从「会话」出发：聊天里 @ 一下就变成任务并推进 |
| 自动 | 自主工作 | 从「自动」出发：定时 / 事件 / API 自动开工 |
| 主体 | Worker 管理 | 谁在干活（Worker / Group） |
| 能力 | 能力与资源 | 干活需要什么（Skills / 连接器 / 知识库 / WorkerFlow / 公开项目） |

**核心结论（贯穿本蓝图）：三条主轴必须收敛到同一个内核。**
无论任务来自手工创建、IM 会话还是定时器，最终都产生同一种实体 `Task`，由同一个运行时执行，并汇聚到任务看板呈现。

- 会话与自动化模块本质上只是 **Task 的不同来源（trigger）与输入装配方式**；
- Worker / Group 是 Task 的 **执行者（assignee）**；
- Skill / 连接器 / 知识库 / WorkerFlow 是 Task 执行时可调用的 **能力（capability）**。

因此实施顺序上先补全「任务体系」：它是其余所有模块的公共底座，且看板是本产品最核心的价值呈现面。

### 1.1 已展示未实现功能清单（本次补全对象）

| 模块 | 界面已展示入口 | 逻辑缺口 |
| --- | --- | --- |
| 任务看板 | 统计卡片、需要操作/查收结果、全部任务、视图切换、4 个筛选器 | 无任务实体、无状态流转、筛选/视图/统计全部硬编码 |
| Worker 管理 | 开始任务、设置、分享记录、导入 Worker、搜索与筛选、Group 分段 | 无任务派发、无设置页、无导入导出、筛选无效、Group 仅空态 |
| @Worker | 开通 @Worker、IM 连接管理、待处理接入申请、聊天绑定表格 | 无 IM 通道、无申请审批、无会话→任务解析 |
| 自主工作 | 新建自动任务、4 类统计、筛选 | 无触发器、无调度器、无运行历史 |
| 能力与资源 | Skills / 连接器 / 知识库 / WorkerFlow / 公开项目、技能安装 | 仅 Toast 提示，无安装、授权、索引、编排 |
| 侧边栏 | Group 标签、搜索 Worker、历史记录、设置、在线列表 | 无分组数据、无搜索、无历史、无设置 |
| 基础设施 | — | 无持久化、无 IPC 业务通道（仅 `app:ping`）、无主进程业务层 |

---

## 2. 系统架构设计

### 2.1 现状

- `main/main.js`：单窗口、单实例锁、安全默认值（`contextIsolation` + `sandbox` + 无 nodeIntegration）、外部链接拦截
- `preload/preload.js`：仅暴露 `virtworker.appInfo` 与 `ping`
- `renderer/`：纯 DOM 手写页面，`index.html` 五个 `.page` 区块 + `renderer.js` 承担路由、渲染与交互
- 已有真实能力：页面路由、侧边栏折叠、Worker 内存态创建、技能市场假数据渲染、统一自定义下拉组件、Toast
- 缺口：**没有领域层（数据与服务）与运行时层（调度与执行）**

### 2.2 目标分层

```
┌──────────────────────────────────────────────┐
│ renderer  视图层：只读 state + 订阅事件重渲染  │
├──────────────────────────────────────────────┤
│ preload   桥接层：白名单 API，invoke / on      │
├──────────────────────────────────────────────┤
│ services  领域层：WorkerService TaskService    │
│                   AutomationService ChatService│
│                   CapabilityService            │
├──────────────────────────────────────────────┤
│ runtime   运行时层：TaskRuntime / Scheduler /  │
│                    Executor(Mock→LLM→真实通道) │
├──────────────────────────────────────────────┤
│ store     持久化层：userData/data/*.json       │
│                   + 原子写 + schema 版本迁移   │
└──────────────────────────────────────────────┘
```

### 2.3 核心设计原则

1. **单一数据源在主进程。** 渲染层不落盘、不持有跨会话状态；刷新/重启后状态由主进程重新下发。
2. **单向数据流。** 渲染层只发「命令」（command），主进程完成校验与事务后写库并广播「事件」（event），渲染层据此重渲染对应区域。
3. **运行时与服务分离。** 服务负责校验与持久化，运行时负责调度与执行；执行器可替换（Mock → 真实 LLM → 真实 IM），替换不影响上层。
4. **状态机集中定义。** 任务状态、迁移条件、派生统计口径只在主进程定义一处，渲染层不做状态推断。
5. **界面结构零破坏。** 不重构现有 HTML 骨架与 CSS 命名，功能补全以「填充既有容器 + 新增弹窗」为主，保证样式基线一致。

### 2.4 目录结构（新增部分）

```
main/
  main.js                # 仅窗口与生命周期（保持精简）
  ipc/index.js           # IPC 注册中心（通道 → 服务方法）
  store/
    db.js                # JSON 集合读写、原子写、备份
    schema.js            # schemaVersion 与迁移
  services/
    worker-service.js
    task-service.js      # 首批实现
    automation-service.js
    chat-service.js
    capability-service.js
  runtime/
    task-runtime.js      # 首批实现：执行循环、need_action 暂停/恢复
    executor-mock.js     # 首批实现
    scheduler.js         # 后续：定时/事件/API
    event-bus.js         # 事件广播
  util/
    id.js  time.js  validate.js
renderer/
  renderer.js            # 入口：初始化与事件绑定（保持文件名不变）
  js/
    store.js             # 渲染层轻量状态 + 订阅
    api.js               # window.virtworker 的 Promise 封装
    views/               # dashboard.js / workers.js / atworker.js / autonomous.js / capabilities.js
    components/          # modal.js / dropdown.js（抽出既有 enhanceSelect）/ toast.js
```

> 拆分方式采用**经典 `<script>` 按序引入**（见 6.1），不引入打包器与 ES Module。

---

## 3. 领域模型（数据契约）

### 3.1 实体清单

| 实体 | 归属模块 | 首批 |
| --- | --- | --- |
| `Worker` | Worker 管理 | ✅ |
| `Group` | Worker 管理 | ✅（建组 + 编组） |
| `Task` | 任务看板 | ✅ |
| `TaskEvent` | 任务看板 | ✅ |
| `ActionRequest` | 任务看板（需要操作） | ✅ |
| `Automation` | 自主工作 | 后续 |
| `IMConnection` / `ChatBinding` / `ChatAccessRequest` | @Worker | 后续 |
| `Capability`（Skill/Connector/KB/Flow） | 能力与资源 | 后续 |

### 3.2 关键实体字段

**Worker**

```jsonc
{
  "id": "wk_8f3a1c",              // 前缀 + 短随机，替代现有 Date.now()
  "name": "调研员小张",
  "role": "数据分析",
  "env": "local",                 // 仅本地（云端模式已下线；旧数据 cloud 在更新时自动改写）
  "desc": "负责竞品调研",
  "status": "online",             // online | offline
  "avatarColor": "linear-gradient(...)",
  "capabilityIds": [],            // 已安装 Skill / 已授权连接器的挂载点（后续）
  "groupIds": [],
  "stats": { "taskTotal": 0, "taskRunning": 0 },   // 派生缓存，由 task-service 维护
  "createdAt": "2026-09-17T10:00:00+08:00",
  "updatedAt": "2026-09-17T10:00:00+08:00"
}
```

**Group**

```jsonc
{
  "id": "gp_2b7d90",
  "name": "竞品调研组",
  "desc": "负责行业与竞品信息采集",
  "memberIds": ["wk_8f3a1c"],
  "leadWorkerId": "wk_8f3a1c",     // 组长，负责汇总，可空
  "createdAt": "...", "updatedAt": "..."
}
```

**Task（核心实体）**

```jsonc
{
  "id": "tk_5d21e7",
  "title": "整理本周客户反馈并给出优先级",
  "goal": "从本周 200 条反馈中聚类出 Top5 问题，输出优先级与建议",
  "status": "need_action",        // 见 3.3 状态机
  "priority": "normal",           // low | normal | high | urgent
  "trigger": {
    "type": "manual",             // manual | schedule | event | api | chat
    "refId": null,                // automationId / chatBindingId / apiToken
    "label": "手动创建"            // 看板「触发方式」筛选与展示用
  },
  "assignee": { "type": "worker", "id": "wk_8f3a1c", "name": "调研员小张" },  // worker | group | flow
  "workspace": { "cwd": "D:\\Work\\feedback", "env": "local" },
  "input": { "payload": {}, "attachments": [] },        // 触发时注入的原始输入
  "plan":   [ { "step": 1, "title": "汇总反馈原文", "status": "done" } ],   // 步骤与执行轨迹
  "steps":  [ { "step": 1, "title": "...", "status": "running", "startedAt": "...", "log": "" } ],
  "progress": 45,                 // 0-100，由步骤完成度推导
  "actionRequest": null,          // 见 ActionRequest，status=need_action 时非空
  "result": null,                 // { summary, artifacts[], text, deliveredAt }
  "resultAckedAt": null,          // 非空表示已「查收」
  "error": null,                  // { code, message, at }
  "tags": ["客户反馈"],
  "createdAt": "...", "startedAt": "...", "updatedAt": "...", "finishedAt": null
}
```

**ActionRequest（需要操作的统一抽象）**

```jsonc
{
  "id": "ar_1c9f02",
  "taskId": "tk_5d21e7",
  "type": "confirm",             // confirm 确认 | question 回答 | input 补充信息 | selection 选择
  "title": "是否按销售额口径统计？",
  "detail": "两条数据源的口径不一致，需要你确认。",
  "options": [ { "value": "sales", "label": "按销售额" }, { "value": "count", "label": "按反馈条数" } ],
  "form": null,                  // type=input 时的字段定义 [{ name, label, required, type }]
  "defaultValue": "sales",
  "deadline": null,
  "answer": null,                // 用户提交后写入，随后任务恢复执行
  "createdAt": "...", "answeredAt": null
}
```

**TaskEvent（时间线）**

```jsonc
{ "id": "ev_...", "taskId": "tk_5d21e7", "type": "status_changed",
  "from": "queued", "to": "running", "message": "已派发给 调研员小张", "at": "..." }
```

事件类型：`created` / `status_changed` / `step_updated` / `action_requested` / `action_answered` / `result_ready` / `acked` / `failed` / `log`。

### 3.3 任务状态机

```
                ┌──────────┐
创建/触发 ─────▶ │  queued  │  已创建待派发
                └────┬─────┘
                     │ dispatch（执行者在线）
                     ▼
                ──────────┐  request_action   ┌──────────────┐
                │ running  │ ────────────────▶ │ need_action  │
                ────┬───── ◀──────────────── ──────────────┘
                     │            answer（提交操作）
      ┌─────────────────────────────┐
      │ 成功         │ 失败          │ 用户取消
      ▼              ▼               ▼
 ┌───────────┐  ┌────────┐   ┌──────────┐
 │ succeeded │  │ failed │   │ canceled │
 ─────┬─────┘  └────────┘   └──────────┘
       │ ack（查收）
       ▼
 resultAckedAt 置位（状态不变，仅从「查收结果」列表移出）
```

约束：

- 执行者离线时任务保持 `queued`，并写入 TaskEvent（不报错、不丢失）；
- `need_action` 是**暂停态而非终态**，必须可恢复；超过 `deadline` 仍可提交，仅记录超时事件；
- `ack` 不改变任务状态，只置 `resultAckedAt`，保证「已结束」与「已查收」两个口径解耦。

### 3.4 枚举与看板口径映射

| 看板区域 | 口径（主进程统一计算） |
| --- | --- |
| 任务总数 | 数据周期内全部 Task |
| 进行中任务 | `status ∈ {queued, running}` |
| 需要操作 | `status === need_action` |
| 已结束任务 | `status ∈ {succeeded, failed, canceled}` |
| 需要操作 (N) | 同上，N 为待回答的 ActionRequest 数 |
| 查收结果 (N) | `status === succeeded && resultAckedAt == null` |
| 数据周期 | `createdAt` 落在 一周 / 一个月 / 三个月 内（默认一个月） |
| Worker 们正在休息 | 周期内无 `running` 任务时展示，否则展示「N 个 Worker 正在工作」 |

`触发方式` 筛选项与 `trigger.type` 一一对应：手动创建=`manual`、定时触发=`schedule`、事件触发=`event`、API 触发=`api`（会话触发在 @Worker 页内呈现，看板归入 `chat`）。

---

## 4. 模块业务逻辑与流程

### 4.1 任务体系 + 任务看板【首批落地】

**业务需求**：用户需要一个可信的「工作台账」——知道每个数字员工在做什么、卡在哪里、产出了什么，并能就地完成必要操作。

**用户场景**

1. 王工新建 Worker「调研员小张」，点「开始任务」，输入目标，任务立即出现在看板「进行中」；
2. 执行到一半，小张需要确认统计口径 → 任务转为「需要操作」，并在看板红点提示、侧边栏与页签计数同步 +1；
3. 王工在「需要操作」里选择口径并提交 → 任务恢复执行，进度继续推进；
4. 任务完成 → 进入「查收结果」，王工点「已查收」→ 该项移出，但「已结束任务」计数不变；
5. 王工用「任务状态=需要操作 + 数据周期=一周」快速定位遗留事项。

**流程：创建 → 执行 → 需要操作 → 恢复 → 结果 → 查收**

```
[入口] 看板「新建任务」 / Worker 卡片「开始任务」 / 空态按钮
   │  弹窗：执行者(Worker|Group) + 任务目标 + 工作目录 + 优先级 + 触发方式=手动
   ▼
task-service.create()  ── 校验：目标非空、执行者存在 │ 落库 status=queued │ 发事件
   ▼
task-runtime.dispatch() ── 执行者 offline → 保持 queued（写事件）
   │                       执行者 online → status=running，生成 plan
   ▼
executor-mock.run(plan) ── 逐步执行，每步更新 steps/progress，落库 + 发事件
   │        │
   │        └─ 命中「需要操作」规则 ─▶ status=need_action，写 ActionRequest，暂停
   │
   │  （用户在「需要操作」提交 answer）
   │        └─ task-service.answer() ──▶ 写 answer，status=running，运行时从当前步继续
   ▼
status=succeeded + result（summary / artifacts）──▶ 进入「查收结果」
   ▼
task-service.ack() ──▶ resultAckedAt 置位，移出「查收结果」
```

**模拟执行器规则（首批，可演示且可控）**

- 计划生成：按 `assignee.role` 与 `goal` 关键词生成 4–6 步（如 理解目标 → 收集输入 → 分析 → 产出），每步 300–900ms，进度按已完成步数 / 总步数计算；
- 「需要操作」触发条件（保证演示可复现，不做纯随机）：
  1. `goal` 命中确认类关键词（确认/口径/是否/选择/优先级）→ 第 3 步注入 `selection` 或 `confirm`；
  2. 手动创建时勾选「需要我确认后再执行」→ 第 2 步注入 `confirm`；
  3. 兜底：执行到末步前以 15% 概率注入 `input` 类型请求（可通过配置关闭，避免自动化测试不稳定）；
- 产出：`result.summary`（2–3 句）+ `artifacts`（虚拟文件名列表），首批不产生真实文件；
- 任务取消/失败：用户可取消 `queued|running|need_action` 的任务 → `canceled`；执行器异常 → `failed` 并写 `error`。

**界面交互补全（复用现有 DOM 容器，不新造骨架）**

| 现有元素 | 补全后的行为 |
| --- | --- |
| 统计卡片 4 个 | 由 `task:stats` 下发渲染，点击「需要操作」卡片切到对应页签 |
| 需要操作 / 查收结果 页签 | 渲染真实列表；复用 `.empty-block` 作为空态；数字随事件更新 |
| 需要操作列表项 | 展示任务标题 + 执行者 + 请求类型；按 `type` 渲染选项按钮 / 输入框 / 确认按钮 |
| 全部任务 | 列表视图：任务标题、执行者、触发方式、状态徽标、时间、操作（查看/取消/查收）；看板视图：按状态分列 |
| 视图切换 | 真实切换 `.task-list` / `.task-board` 两种渲染，选择结果持久化到设置 |
| 搜索框 | 匹配标题、目标、执行者名（防抖 200ms） |
| 筛选器 4 个 | 下拉选择即触发 `task:list` 查询（组合过滤在主进程执行） |
| 任务详情 | 新增抽屉/弹窗：目标、步骤时间线（TaskEvent）、结果、ActionRequest、取消按钮 |
| Worker 卡片「开始任务」 | 打开建任务弹窗并预选该 Worker |
| 侧边栏 Group 标签 | 列 Group 及成员数，点击跳 Worker 管理并切到 Group 分段 |
| 空态按钮 | 「新建任务」不再只是 Toast，改为打开建任务弹窗 |

### 4.2 Worker 管理

- **Group**：新建/编辑/删除、拖拽或勾选编组、设组长；Group 作为 `assignee` 时运行时按成员依次/并行分派（首批简化为：派发给组长，其余成员记为协作）；
- **导入 / 导出 Worker**：导出 JSON（含能力挂载配置，脱敏凭据）；导入走系统文件对话框 + 校验 + 冲突改名；
- **分享记录**：记录 Worker 配置快照与分享链接（本地生成，可复制的分享码）；
- **筛选 / 搜索 / 排序**：在主进程按名称、角色、环境、状态过滤，排序字段默认/最近创建/名称；
- **设置**：Worker 详情页（基础信息、能力挂载、工作目录、模型、运行环境、日志）。

### 4.3 @Worker（会话入口）

- **IM 连接管理**：新增 `IMConnection`（平台、名称、凭据引用、状态），凭据存主进程安全存储，渲染层仅见掩码；
- **待处理的聊天接入申请**：`ChatAccessRequest` 待审列表 → 同意后生成 `ChatBinding`；
- **开通 @Worker**：向导三步（选连接 → 选/填聊天 → 选参与协作的 Worker 与工作目录、模型），落库后聊天内 @Worker 生效；
- **会话 → 任务**：IM 事件进入主进程 → 解析 @ 消息与上下文 → 调 `task-service.create({trigger:{type:'chat'}})` → 任务进入看板；
- **表格列**（聊天/IM 连接/Worker/工作目录/模型/聊天状态/启用）由 `ChatBinding` 渲染，支持启停与解绑。

### 4.4 自主工作

- **Automation 实体**：`trigger`（定时 cron / 事件条件 / API 端点）、`executor`（Worker 或 WorkerFlow）、`inputTemplate`、`enabled`；
- **Scheduler**：主进程常驻最小堆调度器，触发时装配输入 → `task-service.create({trigger:{type}})`；启动时补跑错过的定时（可配置）；
- **统计卡片**：总数 / 已启用 / Worker 执行 / WorkerFlow 执行，全部派生自 Automation 集合；
- **运行历史**：每次触发产生的 Task 反向链接到 Automation（`trigger.refId`），列表页可下钻。

### 4.5 能力与资源

- **Skills**：市场列表（真实数据源或本地包）→ 安装/卸载 → `Capability` 落库 → 挂载到 Worker（`worker.capabilityIds`）→ 任务执行时作为可调用工具注入执行器；
- **连接器**：OAuth/Token 授权在主进程完成，渲染层只显示授权状态与撤销；
- **知识库**：本地目录/文档导入 → 切分索引 → 挂载到 Worker，任务执行时按需检索；
- **WorkerFlow**：可视化编排入口（节点=Worker/Skill），保存为可复用流程，可被任务与 Automation 引用；
- **公开项目**：共享项目列表与权限开关。

### 4.6 侧边栏与全局

- Group 标签内容；搜索 Worker 展开浮层；历史记录改为「最近任务」列表（读同源 Task 数据）；设置弹窗（数据目录、执行器模式 Mock/真实、通知、外观）；
- **通知与角标**：`need_action`、`result_ready` 事件触发系统通知（可关）与计数角标。

---

## 5. 数据交互规范

### 5.1 通道命名与统一响应

- 命名：`domain:action`，全小写驼峰（`task:list`、`task:create`、`worker:update`）；
- 全部经 `ipcMain.handle` / `ipcRenderer.invoke`，禁止 `send` 单向命令（除窗口级操作）；

```jsonc
// 成功
{ "ok": true,  "data": { /* 载荷 */ }, "apiVersion": 1 }
// 失败
{ "ok": false, "error": { "code": "TASK_NOT_FOUND", "message": "任务不存在", "details": {} }, "apiVersion": 1 }
```

### 5.2 首批通道清单

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `app:bootstrap` | — | `{workers, groups, tasks, stats, settings}`（渲染层启动一次性拉取） |
| `worker:list` | `{keyword?, role?, env?, status?, sort?}` | `Worker[]` |
| `worker:create` | `{name, role, env, desc}` | `Worker` |
| `worker:update` / `worker:remove` | `{id, patch}` / `{id}` | `Worker` / `{id}` |
| `group:list` / `group:create` / `group:update` / `group:remove` | 同上模式 | `Group[]` / `Group` |
| `task:list` | `{keyword?, assigneeId?, triggerType?, status?, period?, page?, pageSize?, sort?}` | `{items, total}` |
| `task:stats` | `{period?}` | `{total, running, needAction, finished, workerWorking}` |
| `task:create` | `{title, goal, assigneeId, workspace?, priority?, confirmFirst?}` | `Task` |
| `task:cancel` | `{id, reason?}` | `Task` |
| `task:ack` | `{id}` | `Task` |
| `task:detail` | `{id}` | `{task, events, actionRequest}` |
| `task:answer` | `{taskId, actionId, answer}` | `Task` |
| `settings:get` / `settings:update` | — / `{patch}` | `Settings` |

### 5.3 事件推送（主进程 → 渲染层）

单通道 `app:event`，载荷 `{ type, payload }`：

| type | payload | 渲染层响应 |
| --- | --- | --- |
| `task:created` | `Task` | 插入列表、刷新统计与计数 |
| `task:updated` | `Task` | 就地更新行/卡片，必要时重排 |
| `task:event` | `TaskEvent` | 详情时间线增量追加 |
| `task:removed` | `{id}` | 移除行 |
| `worker:*` / `group:*` | 实体 | 刷新 Worker 区与侧边栏计数 |
| `app:notice` | `{level, title, body}` | Toast / 系统通知 |

渲染层订阅使用 `virtworker.onEvent(cb)` 返回取消订阅函数，页面切换不重复注册。

### 5.4 错误码

`VALIDATION_FAILED`（入参校验）· `NOT_FOUND`（实体不存在）· `CONFLICT`（重名等）· `INVALID_STATE`（如对已结束任务提交操作）· `EXECUTOR_OFFLINE` · `STORAGE_ERROR` · `INTERNAL`。渲染层只按 `code` 决定提示文案，不解析 message。

### 5.5 持久化规范

- 位置：`app.getPath('userData')/data/`，文件按集合拆分：`workers.json`、`groups.json`、`tasks.json`、`settings.json`（后续 `automations.json`、`chats.json`、`capabilities.json`）；
- 结构统一为 `{ "schemaVersion": 1, "updatedAt": "...", "items": [...] }`；
- 写入：先写 `*.tmp` 再 `fs.rename`（原子替换），每次写入前保留 `*.bak`（保留最近 1 份）；
- 读取：解析失败或版本高于当前 → 回退 `.bak`，再失败则以空集合启动并记录 `STORAGE_ERROR` 日志，不阻塞启动；
- 迁移：`schema.js` 内按版本号顺序执行迁移函数，启动时一次性完成；
- 任务保留策略：已结束且已查收的任务默认保留 90 天（可配置），清理仅删任务与事件，不影响统计历史快照。

---

## 6. 与现有框架的集成方案

### 6.1 渲染层

- **不引入打包器与 ES Module**：当前页面通过 `file://` 加载且 CSP 为 `script-src 'self'`，`<script type="module">` 在 file 协议下会因 CORS 失败。改造方式为多个经典脚本按依赖顺序引入：

```html
<script src="js/util.js"></script>
<script src="js/api.js"></script>
<script src="js/store.js"></script>
<script src="js/components/toast.js"></script>
<script src="js/components/dropdown.js"></script>
<script src="js/views/dashboard.js"></script>
<script src="js/views/workers.js"></script>
<script src="renderer.js"></script>
```

- 各文件挂在统一命名空间 `window.VW` 下（如 `VW.views.dashboard`），`renderer.js` 只做装配与启动，避免全局变量污染；
- **既有 DOM id 全部保留**（`#dashboard-tabs`、`#worker-grid`、`#skill-grid`…），新逻辑通过 `VW.store.subscribe(selector, fn)` 定向重渲染，不做整页重绘；
- 现有 `enhanceSelect`、`showToast` 原地抽到 `components/`，行为不变；新增筛选器只要写 `<select>` 即自动获得统一样式；
- 首批新增样式沿用现有变量（`--accent`、`--border-light`、`--radius`）与既有类名（`.empty-block`、`.stat-card`、`.badge`、`.mini-btn`、`.data-table`），仅补充任务状态徽标与看板列容器等少量新类。

### 6.2 预加载层

`preload.js` 按域扩展，保持「能力白名单 + 无 Node 泄漏 + 无任意通道转发」：

```js
contextBridge.exposeInMainWorld('virtworker', {
  appInfo: { /* 保持现状 */ },
  ping: (m) => ipcRenderer.invoke('app:ping', m),
  bootstrap: () => invoke('app:bootstrap'),
  worker: { list: (q) => invoke('worker:list', q), create: (p) => invoke('worker:create', p), /* ... */ },
  task:   { list: (q) => invoke('task:list', q), create: (p) => invoke('task:create', p), /* ... */ },
  onEvent: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('app:event', h);
                     return () => ipcRenderer.off('app:event', h); }
});
```

> `invoke` 内部统一解包 `{ok,data,error}`，失败时 reject 一个带 `code` 的错误对象，渲染层集中捕获提示（5.4）。

### 6.3 主进程层

- `main.js` 只保留窗口与生命周期；新增 `ipc/index.js` 在 `app.whenReady()` 后注册全部通道；
- 服务层不感知 Electron（只依赖 `store`），便于单测与服务端复用；
- 运行时通过 `event-bus` 广播，`ipc/index.js` 订阅后转发到所有窗口（`BrowserWindow.getAllWindows()`）；
- 主进程统一兜底：所有 handler 包一层 try/catch → `INTERNAL`，已有 `uncaughtException` 兜底保留。

### 6.4 安全与 CSP

- 保持 `contextIsolation`、`sandbox`、禁用 `nodeIntegration`、`webviewTag`；
- CSP 不改动（不引入 CDN、不引入内联脚本；样式已有 `'unsafe-inline'`，仅用于既有内联 `style` 属性）；
- 所有入参在主进程校验（长度、枚举、外键存在性），渲染层校验只作体验优化；
- 未来接入凭据（IM Token / LLM Key）通过 `safeStorage` 加密后落盘，永不回传渲染层。

### 6.5 兼容与迁移

- 首批上线时当前内存态 Worker 数据会被清空（无历史数据），无需数据迁移；`schemaVersion` 从 1 起；
- 渲染层保留降级路径：`bootstrap` 失败时页面仍可打开并显示空态，不白屏；
- 开发模式开关：`--dev` 下追加 `--devtools` 行为保持不变，新增 `--mock` 显式启用模拟执行器（默认即 Mock）。

---

## 7. 实施路线

### Phase 1：任务体系 + 任务看板（首批）

| 子阶段 | 交付 | 验收标准 |
| --- | --- | --- |
| 1.1 基础设施 | store（原子写 + 备份）、schema、event-bus、ipc 注册中心、preload 按域扩展、渲染层 api/store 拆分 | 重启应用后 Worker 数据不丢失；`bootstrap` 返回结构正确；页面无回归 |
| 1.2 Worker 持久化 + 建任务 | worker/group 服务与通道、建任务弹窗、任务 CRUD 与列表/详情 | 新建任务后立即出现在「全部任务」，状态徽标正确 |
| 1.3 执行运行时 | task-runtime + executor-mock、状态机、TaskEvent、need_action 注入与恢复 | 任务能跑完；命中规则时进入「需要操作」；提交后恢复并完成 |
| 1.4 看板完善 | 统计口径、需要操作/查收结果列表、搜索与 4 个筛选、列表/看板视图、Group 分段与侧边栏计数、通知角标 | 统计与筛选结果和主进程数据一致；查收后计数正确；侧边栏 Group 有数据 |

### 后续阶段（本蓝图已定义设计，待排期）

- Phase 2 自主工作：Automation + Scheduler + 运行历史（复用 Phase 1 运行时）
- Phase 3 @Worker：IMConnection / ChatBinding / ChatAccessRequest + 会话转任务
- Phase 4 能力与资源：Capability 安装与挂载、连接器授权、知识库索引、WorkerFlow 编排
- Phase 5 全局：设置中心、历史记录、导入导出、分享记录、真实 LLM 执行器替换 Mock

### 测试要点

- 服务层可脱离 Electron 单测（建任务、状态迁移非法路径、filter 组合）；
- 运行时用假定时器验证 need_action 暂停/恢复与并发任务互不干扰；
- 持久化验证：断电式写入（tmp 残留）、`.bak` 回退、schema 迁移幂等。

---

## 8. 风险与取舍

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 状态机与界面口径不一致 | 统计与列表互相矛盾 | 口径只在主进程实现，渲染层只渲染；`task:stats` 与 `task:list` 共用同一 filter 函数 |
| 模拟执行器过于随机 | 演示/测试不稳定 | 「需要操作」按规则注入，概率兜底可通过设置关闭 |
| 渲染层无框架、DOM 手写 | 事件绑定重复注册、内存泄漏 | 统一 `subscribe` 返回取消函数；页面切换不重复绑定；事件驱动增量更新而非整页重绘 |
| 单文件 JSON 体量与并发写 | 任务量大后写入变慢、写冲突 | 原子写 + 主进程串行化写入队列；后续超阈值切换到 SQLite（store 接口不暴露实现） |
| file 协议下的模块方案限制 | 破坏现有加载方式 | 明确使用经典脚本 + 命名空间，避免 ES Module |
| 真实凭据安全 | 密钥泄漏 | `safeStorage` 加密 + 主进程独占，渲染层只见掩码 |