# Artoo 全栈持续优化与演进机会分析报告 (Opportunities)

> - **报告更新日期**：2026-11-13
> - **分析基线**：`main` 分支 @ `49c514d`（含 `T0`–`T9` 近期优化提交）
> - **项目定位**：Open-Source Agent Team Operating System（连接多台计算节点 Computer、多类 Agent Runtime、Agent-Native IM 协作、Scrum/Goal 任务编排、Skill 治理与可审计证据链的统一控制平面）
> - **关联文档**：[design.md](./design.md) · [AGENTS.md](./AGENTS.md) · [docs/agent-team-development.md](./docs/agent-team-development.md) · [docs/optimization-backlog-2026-11-13.zh-CN.md](./docs/optimization-backlog-2026-11-13.zh-CN.md)

---

## 目录

1. [项目全景与量化基线](#1-项目全景与量化基线)
2. [近期已落地优化回顾 (T0–T9)](#2-近期已落地优化回顾-t0t9)
3. [功能与产品完备度优化机会 (Feature & Product)](#3-功能与产品完备度优化机会-feature--product)
4. [UI 与视觉一致性优化机会 (UI & Visual System)](#4-ui-与视觉一致性优化机会-ui--visual-system)
5. [交互逻辑与用户体验优化机会 (UX & Interaction Logic)](#5-交互逻辑与用户体验优化机会-ux--interaction-logic)
6. [性能与可扩展性优化机会 (Performance & Scalability)](#6-性能与可扩展性优化机会-performance--scalability)
7. [代码整洁度与架构解耦机会 (Code Cleanliness & Architecture)](#7-代码整洁度与架构解耦机会-code-cleanliness--architecture)
8. [工程效率、开发者体验与 CI/CD 优化机会 (DX & CI/CD)](#8-工程效率开发者体验与-cicd-优化机会-dx--cicd)
9. [分阶段持续优化路线图与 ROI 矩阵](#9-分阶段持续优化路线图与-roi-矩阵)
10. [附录：v0.1 产品定位与开源生态调研基线 (2026-06-11)](#10-附录v01-产品定位与开源生态调研基线-2026-06-11)

---

## 1. 项目全景与量化基线

Artoo 采用 TypeScript Monorepo 架构（Node.js `>=24.0.0`，npm workspaces），结合原生 SwiftUI iOS 客户端与 Electron 桌面端，已具备非常扎实的契约驱动（Zod + Drizzle）、权限隔离、Fail-Closed 节点验证与端到端可审计基础。

### 1.1 代码库规模统计

全仓共追踪 **1,984 个文件**，核心源码与测试代码（`.ts` / `.tsx` / `.mjs` / `.swift` / `.css`）共计 **257,901 行 (LOC)**，包含 **709 个测试文件**、**60 个有序追加的 SQL 迁移文件**、**113 篇设计/运维文档** 与 **9 条 GitHub Actions 工作流**：

| 模块 / 目录 | 文件数 | 代码行数 (LOC) | 职责定位 |
| --- | ---: | ---: | --- |
| `apps/artood` | 545 | 104,354 | 本地执行守护进程（Runtime 适配器、受保护验证 Profile、Git Worktree 隔离、本地/静态发布执行器、Windows 进程守卫） |
| `apps/server` | 325 | 57,742 | Fastify 控制平面服务端（认证授权、GoalRunner、DAG 调度、ContextPack 组装、节点绑定、WS Hub、审计导出） |
| `apps/web` | 197 | 20,414 | React + Vite + TanStack Query 共享 Web / 桌面渲染层控制面 |
| `apps/ios` | 81 | 18,991 | SwiftUI 原生 iOS/iPadOS 客户端及 XCTest UI 自动化套件 |
| `packages/domain` | 145 | 15,811 | 版本化领域模型、状态机、Zod 契约、DAG 与预算纯函数 |
| `apps/desktop` | 40 | 6,922 | Electron 桌面外壳与内置本地守护进程桥接 |
| `validation/managed-workspaces` | 33 | 5,084 | 受管工作区验证夹具与快照 |
| `packages/db` | 39 | 4,537 | Drizzle ORM Schema（60+ 张表）与只追加 SQL 迁移（PGlite / Postgres 双兼容） |
| `scripts/*` | 136 | 14,500+ | 预览门禁、iOS/Mac/Windows E2E 编排、npm daemon 打包与发布脚本 |
| `packages/protocol` | 42 | 2,308 | Server ↔ Node 双工传输信封与命令确认协议 |
| `packages/storage` | 22 | 1,773 | 数据库连接池、事务包装与内容寻址 Blob 存储 |
| `packages/node-supervisor` & `client` | 14 | 1,365 | 节点进程监管与轻量 API 客户端 |

### 1.2 核心架构优势（演进中必须保持的不变量）

根据 `AGENTS.md` 与代码实现，以下核心设计是项目的护城河，任何优化均**不得削弱**：

1. **验证结果由节点独占 (`run.verification`)**：模型输出、制品元数据或 CLI 退出码不能单独触发自动评审通过；验证命令必须源自节点受保护的本地 Profile，严禁从任务文本或远程参数直接拼接命令。
2. **授权与系统决策归因分离**：GoalRunner 的系统级调度决策与发起用户的显式授权（如 AI 数据共享授权、跨机器传输授权、高危操作审批）严格解耦。
3. **Fail-Closed 安全边界**：不支持的平台、工作区策略、缺失的验证 Profile 或断连超时未知的进程状态一律按失败/阻断处理。
4. **演进兼容性**：数据库坚持只追加（Append-Only）有序 SQL 迁移；协议与 ContextPack 扩展坚持新增可选的版本化字段，不静默重解释历史载荷。

---

## 2. 近期已落地优化回顾 (T0–T9)

在本次深度分析基线上，`main` 分支已完成第一批高 ROI 止血式优化（详见 `docs/optimization-backlog-2026-11-13.zh-CN.md`）：

- **路由级代码分割 (`3c790f2`)**：`apps/web/src/app/AppRoutes.tsx` 将低频路由（`AgentsPage`、`ComputersPage`、`SkillsPage`、`AgentHistoryPage`、`MemoryPage`、`RunsAuditPage`、`SettingsPage`、`ReleasePage`）改为 `React.lazy` 按需加载。
- **WebSocket 在线感知的退避轮询 (`57a974b`, `a832f89`)**：引入 `usePollMs(baseMs, connectedFactor = 6)`，在实时 WS 连接正常时将大部分轮询间隔拉长 6 倍。
- **路由错误边界隔离 (`41e326b`)**：新增 `RouteErrorBoundary`，防止单页面渲染异常导致整个 Web 壳白屏。
- **共享 Daemons 查询 Hook (`060d394`)**：抽取 `useDaemons` 统一 `DaemonBadge`、`InventoryPages` 与 `ConnectNodeDialog` 的查询配置。
- **核心列表项 Memo 化与长列表折叠 (`e516fac`, `6546006`)**：对 `MessageCard`、`TaskList`、`RunTimeline` 增加 `React.memo` 与分页/展开控制。
- **核心列表接口可选 `limit` 与复合索引补齐 (`3b8c239`, `626ebba`)**：为 `tasks`、`goals`、`approvals`、`memories` 补齐可选 `limit` 参数及对应排序索引。
- **局部页面 CSS 收敛 (`f611f9e`)**：将部分散落在 `styles.css` 中的页面样式迁入模块化 `ui/*.css`。
- **首轮大文件拆分与 i18n 脚手架 (`ca224f0`, `8102ee2`, `49c514d`)**：从 `node-client.ts` 拆出 `node-client-records.ts`，并在 `apps/web/src/app/i18n.ts` 建立轻量多语言脚手架（覆盖 `LoginPage` 与 `RouteErrorBoundary`）。

在此基础上，我们对全栈源码进行了穿透式扫描，识别出以下 **6 大维度、28 项具有明确代码证据的下一阶段持续优化机会**。

---

## 3. 功能与产品完备度优化机会 (Feature & Product)

### F1. 补齐 DAG 依赖中的证据门控 (`artifact_required` / `contract_required`) 闭环
- **代码证据**：
  - `packages/domain/src/dag.ts:51-98` 已定义了纯函数 `requiredEvidenceKind`、`gatingNeedsEvidence` 与 `hasRequiredEvidence`，并在第 89 行留有明确注释：`Phase A gates on prerequisite-done only — see gatingNeedsEvidence for the artifact/contract/review TODO`。
  - `apps/server/src/services/dag-service.ts` 在计算任务解锁与自动就绪时，目前仅调用了 `isTaskUnlocked`（仅判断前置任务 `status === "done"`），未调用 `hasRequiredEvidence` 校验前置任务是否实际产出了 `artifact` 或 `contract` 类型制品。
- **影响**：当用户在任务依赖或计划中选择 `artifact_required` 或 `contract_required` 边类型时，其实际运行语义退化成了普通的 `blocks` 边。
- **优化建议**：
  1. 先核对 `AGENTS.md` 中的自动评审与制品边界，在 `dag-service.ts` 的解锁评估中查询前置任务已落库的 `artifacts.type` 集合并构造 `evidenceByPrereq`。
  2. 将 `isTaskUnlocked(incoming, statusById) && hasRequiredEvidence(incoming, evidenceByPrereq)` 组合作为完整的自动解锁条件，并补充对应的集成测试。
- **优先级 / 规模**：P1 · S

### F2. 打通 Goal 成本预算 (`max_cost_usd`) 自动累计与熔断闭环
- **代码证据**：
  - `packages/db/src/schema.ts` 的 `goals` 表已包含 `elapsed_cost_usd` 列，`apps/server/src/services/budget-service.ts:32-35, 68` 已读取 `cost_usd: goal.elapsedCostUsd`，但 `PAUSE_BUDGETS` 集合（第 32 行）仅包含 `"max_elapsed_ms"` 和 `"max_retries"`，未包含 `"max_cost_usd"`。
  - `apps/web/src/components/GoalsPage.tsx:94` 表单提示：`Cost budgets are unavailable until runtimes report reliable usage costs`。
  - 与此同时，服务端已有 `GET /api/v1/runs/:id/usage` (`run-service.ts:getRunUsage`) 与前端 `RunUsageSummary.tsx` 展示单次 Run 的 Token 及成本消耗。
- **影响**：长时间运行的 Autonomous / Agent Team 目标缺乏成本上限熔断保护，当 Runtime 出现循环重试或高消耗调用时无法按美元预算自动暂停。
- **优化建议**：
  1. 在 `run-service.ts` 消费 `run.usage` / `run.completed` 事件时，将已确认的增量成本原子累加至所属 Goal 的 `elapsed_cost_usd`。
  2. 将 `"max_cost_usd"` 纳入 `budget-service.ts` 的 `PAUSE_BUDGETS` 集合，并在 `GoalsPage.tsx` 的高级设置中开放可选的成本预算输入框（注明仅对上报 Usage 的 Runtime 生效）。
- **优先级 / 规模**：P1 · M

### F3. 弥合 iOS 客户端与 Web 控制面的核心业务视图差距
- **代码证据**：
  - Web 端顶部主导航 (`apps/web/src/components/ProductHeader.tsx:8-13`) 围绕四大核心研发流构建：`01 Thread (/channels)`、`02 Plan (/goals)`、`03 Board (/board)`、`04 Release (/release)`，外加 `/agents/:agentId/history` 执行历史浏览器。
  - iOS 端主入口 (`apps/ios/Sources/App/ArtooApp.swift:232-250`) 的 `RootTab` 仅为 `channels`、`inbox`、`tasks`、`team`、`more` 五个 Tab，缺少独立的 **Goals (Plan) 视图**（查看/暂停/恢复 Goal、审阅接受 Plan、查看 Checkpoint）与 **Release 视图**（查看发布健康状态、停止本地应用发布），也无法按 Agent 维度浏览完整工具调用历史 (`AgentHistory`)。
- **影响**：移动端用户在离席使用 iOS 客户端时，只能处理单任务审批和聊天，无法对高层级的 Goal 计划进行审批（Accept/Reject Plan）、暂停/恢复 Goal 或紧急停止正在运行的本地发布应用。
- **优化建议**：
  1. 在 iOS `TasksView` 顶部或 `More` 中率先增补轻量级 **Goals & Plans 管控面板**（支持查看 Goal 进度、Accept/Reject 提议的 Plan、Pause/Resume Goal）。
  2. 增补 **Release 状态卡片与紧急停止按钮**（复用 `GET /api/v1/goals/:id/release` 与 `POST /api/v1/goals/:id/application-publication/stop`）。
- **优先级 / 规模**：P2 · L

### F4. 完善服务端全局检索与消息搜索能力
- **代码证据**：
  - 目前 Web 端的所有搜索框——包括 `BoardView.tsx:93`、`TaskList.tsx`、`GoalsPage.tsx:44`、`InventoryPages.tsx:61,132`、`RunsAuditPage.tsx:67`、`MemoryPage.tsx`——全部是在前端内存对当前拉取的单批次数组执行 `.toLowerCase().includes(...)` 子串匹配。
  - 随着 T5 为服务端接口引入 `limit` 分页，前端内存过滤将无法命中未加载页的数据；且 `RoomConversation.tsx`（频道与任务房间消息流）目前**没有任何消息搜索功能**。
- **影响**：当项目历史任务、记忆或房间消息超过数百条后，用户无法检索早期讨论内容、决策上下文或未加载页的任务。
- **优化建议**：
  1. 为 `GET /api/v1/rooms/:id/messages`、`GET /api/v1/tasks`、`GET /api/v1/memories` 增加可选的服务端 `q` 查询参数。
  2. 通过新的追加式 SQL 迁移为 `messages.body`、`tasks(title, description)`、`memories.text` 建立 Postgres `GIN (to_tsvector(...))` 或 `pg_trgm` 索引（兼顾 PGlite 兼容性），并在 `RoomConversation` 头部提供消息搜索入口。
- **优先级 / 规模**：P2 · M

### F5. 审计证据包数字签名 (`AuditBundleExport.signature`) 落地
- **代码证据**：
  - `apps/server/src/services/audit-service.ts:150-154` 与 `243-247` 在导出任务与 Goal 审计包时，固定返回：
    ```ts
    signature: null,
    signing: { status: "deferred", reason: "v1 does not manage signing keys yet" }
    ```
- **影响**：导出的 `.json` 审计包虽有 `bundle_sha256` 摘要，但缺乏服务端非对称密钥签名（Ed25519），第三方或合规审计时无法独立验证该证据包确实由特定 Artoo Server 实例签发且未被篡改。
- **优化建议**：支持通过环境变量（如 `ARTOO_AUDIT_SIGNING_PRIVATE_KEY`）可选注入 Ed25519 私钥，使用 Node.js 内置 `node:crypto` (`sign(null, Buffer.from(bundleSha256), privateKey)`) 生成签名并提供公钥验证端点 `/.well-known/artoo-audit-keys.json`；未配置密钥时保持现有 `deferred` 行为不变。
- **优先级 / 规模**：P3 · S

---

## 4. UI 与视觉一致性优化机会 (UI & Visual System)

### U1. 彻底消除 `styles.css` 与模块化 `ui/*.css` 的双轨制冲突
- **代码证据**：
  - `apps/web/src/styles.css` 仍有 **1,233 行**，顶部注释（第 1–6 行）明确写着：`This file keeps the app-shell / surface styling over the existing markup until #69-#78 migrate each surface onto the ui/ component primitives`。
  - `styles.css:11-86` 中仍保留了全局标签选择器（如裸 `button`、`label`、`select:not(.ui-input)`、`textarea:not(.ui-input)`）以及硬编码颜色值（如 `styles.css:1249` 的 `.connection-status[data-offline="true"] { background: var(--warning-bg, #fff4db); color: #79530a; }`，在暗色模式下对比度异常，且与 `ui/product-shell.css:89` 的 `.app-content > .connection-status[data-offline="true"]` 重复定义）。
- **影响**：全局元素选择器（尤其是裸 `button` 和 `label`）容易污染新增组件样式，导致必须不断提高选择器特异性才能覆盖；两套 CSS 并存也增加了样式体积与维护心智负担。
- **优化建议**：
  1. 按组件域分批（每次一个 commit）将 `styles.css` 中剩余的 Workspace 三栏、LeftRail、TaskDetail、Approval、Artifact、Memory 等样式迁入对应的 `ui/*.css`。
  2. 将残留在业务组件中的原生 `<button>` / `<input>` / `<select>` 全部替换为 `ui/` 原语（`<Button>`、`<Input>`、`<Select>`），最终移除 `styles.css` 顶部的全局标签样式规则。
- **优先级 / 规模**：P1 · M

### U2. 启用已建成但闲置的 UI 反馈原语 (`ToastProvider` / `OfflineBanner` / `Tooltip` / `SkeletonText`)
- **代码证据**：
  - `apps/web/src/ui/feedback.tsx` 完整实现并导出了 `ToastProvider`、`useToast`、`OfflineBanner`、`Tooltip`、`SkeletonText`，且拥有完备的单元测试 (`feedback.test.tsx`)。
  - 全仓检索 (`git grep "useToast\|ToastProvider\|OfflineBanner\|Tooltip\|SkeletonText" -- apps/web/src`) 显示：**这 5 个核心反馈组件在业务页面中的实际调用次数为 0**，`App.tsx` 甚至未挂载 `<ToastProvider>`。
  - 目前各页面的操作成功反馈要么没有（如接受计划、导出审计包、启停实例），要么在表单底部塞入一行 `<p role="status">Project saved.</p>` (`SettingsPage.tsx:81`)。
- **影响**：用户执行关键写操作（保存设置、创建任务、生成/复制配对码、导出证据、审批通过）时缺少统一、非阻塞的视觉确认；图标按钮缺少统一的 `<Tooltip>` 辅助说明。
- **优化建议**：
  1. 在 `apps/web/src/app/App.tsx` 顶层挂载 `<ToastProvider>`。
  2. 在项目保存、配对码复制、任务创建、审批提交、审计包导出成功等场景接入 `useToast().push({ tone: "success", message: ... })`（同时保留现有的 `role="status"` DOM 文本或让 Toast 承载无障碍播报，确保现有测试断言完全兼容）。
- **优先级 / 规模**：P1 · S

### U3. 优化顶部常驻 `ConnectionStatus` 横幅，消除正常态下的空间浪费与视觉噪音
- **代码证据**：
  - `apps/web/src/app/AppRoutes.tsx:59` 在 `<ProductHeader>` 下方无条件渲染 `<ConnectionStatus />`。
  - `apps/web/src/components/ConnectionStatus.tsx:33-36` 与 `apps/web/src/ui/product-shell.css:87` 使该组件即使在网络完全正常、无待发队列（显示 `"Live updates connected"`）时，也永久占据整个主内容区顶部一整行（高度 25px + 底部边框）。
- **影响**：纵向屏幕空间被常驻横幅压缩，且用户视线在顶部 Header、ConnectionStatus 横幅、页面 Header 三层水平条之间产生割裂感。
- **优化建议**：
  1. 当 `online === true && status === "connected" && pending === 0 && !preparedPolling`（完全健康状态）时，将连接状态收拢为 `ProductHeader` 右侧的一个紧凑绿点指示器（悬停显示 `"Live updates connected"`）。
  2. 仅当离线 (`!online`)、重连中 (`status !== "connected"`)、处于 `preparedPolling` 模式或存在待重放离线队列 (`pending > 0`) 时，才展开顶部横幅告警（保持 `role="status"` 与 `aria-label="Connection status"` 可访问性契约不变）。
- **优先级 / 规模**：P1 · S

### U4. 统一全站骨架屏 (Skeleton)，消除低频/核心页面加载时的布局抖动 (CLS)
- **代码证据**：
  - `WorkspaceLayout.tsx`、`BoardView.tsx`、`InventoryPages.tsx`、`RoomConversation.tsx`、`TaskDetailPanel.tsx` 已实现贴合最终布局的 `<Skeleton>` 占位。
  - 但核心页面 `GoalsPage.tsx:48,135,146`、`ReleasePage.tsx:19,52`、`AgentHistoryPage.tsx:73,81`、`SettingsPage.tsx:48,60` 以及 `AppRoutes.tsx:62` 的 `<Suspense fallback={<div ...>Loading…</div>}>` 仍仅渲染纯文本 `"Loading…"`。
- **影响**：从顶部 Tab 切换到 `Plan (/goals)` 或 `Release (/release)` 时，页面先渲染单行文字再突然撑开两栏布局，产生明显的视觉跳动。
- **优化建议**：为 `GoalsPage`（左列表 + 右详情）、`ReleasePage`（左目标列表 + 右检查卡片）和 `AgentHistoryPage` 补充与 `BoardSkeleton` / `InventoryLoading` 风格一致的 `<Skeleton>` 组件，并在 `AppRoutes.tsx` 的 `Suspense fallback` 中使用通用页面骨架。
- **优先级 / 规模**：P2 · S

---

## 5. 交互逻辑与用户体验优化机会 (UX & Interaction Logic)

### X1. 理顺主导航信息架构：消除 `/` (三栏工作台) 与 `/board` 的 Tab 高亮歧义
- **代码证据**：
  - `apps/web/src/components/ProductHeader.tsx:30-31`：
    - 当路由为 `/` (`WorkspaceLayout`，三栏任务工作台) 时，面包屑显示 `Workspace > Task detail`；
    - 但顶部导航 Tab 栏中，`03 Board` 的激活条件被硬编码为 `isActive || (tab.to === "/board" && pathname === "/")`。
  - 同时，左侧导航栏 `Nav.tsx:24,28` 中点击 `ARTOO` 品牌 Logo 或切换项目时，均强制跳转至 `/channels`（而非 `/`）。
- **影响**：
  1. 用户在 `/`（三栏工作台）时看到顶部 `03 Board` Tab 处于高亮选中状态，但当前画面并不是看板；点击已高亮的 `03 Board` 反而会发生页面跳转进入看板视图。
  2. 一旦用户切换到 `/channels`、`/goals` 或 `/release`，整个顶部 Tab 栏和左侧导航栏中**没有任何直接返回 `/`（三栏任务工作台）的一级入口**，只能先进 `/board` 再点右上角不起眼的 `"Task list"` 链接 (`BoardView.tsx:106`)。
- **优化建议**：
  1. 在 `Board` 与 `/`（List/Workspace）之间建立清晰的视图切换器（Segmented Control：`Board | Workspace`），或在顶部 Tab 中明确区分 `Workspace` 与 `Board`。
  2. 移除 `tab.to === "/board" && pathname === "/"` 的借壳高亮逻辑，使每个顶层路由在导航栏中都有唯一、诚实的激活态与直达入口。
- **优先级 / 规模**：P1 · S

### X2. 修正左栏待审批徽标 (`LeftRail`) 的项目作用域并提供点击筛选交互
- **代码证据**：
  - `apps/web/src/components/LeftRail.tsx:29-45` 查询了 `api.listApprovals("pending")` 与 `api.listApprovals("needs_more_info")`，并将两者之和渲染在当前项目名称 `<h1>{projectName}</h1>` 右侧的红色 `<Badge tone="danger">{unresolvedCount}</Badge>` 中。
  - 然而服务端 `GET /api/v1/approvals` (`apps/server/src/app.ts:967-970`) 返回的是**整个组织 (Organization)** 下所有项目的审批单，并未按当前 `projectId` 过滤；且该红色徽标只是一个静态 `<span>`，没有任何点击事件。
- **影响**：
  1. 多项目场景下，项目 A 的左栏标题旁显示了“3 个待审批”，但用户在项目 A 的任务列表里找不到任何待审批任务（因为它们属于项目 B）。
  2. 用户看到红色告警徽标后本能地点击它，却没有任何反应。
- **优化建议**：
  1. 将左栏审批计数与当前项目的任务列表关联（或为 `/api/v1/approvals` 增加可选 `project_id` 过滤参数）。
  2. 将该 `<Badge>` 改造为可交互按钮：点击后自动在左栏任务列表中筛选出 `awaiting_approval` / `blocked` 状态的任务并选中第一个待审批任务。
- **优先级 / 规模**：P1 · S

### X3. 增强手动计划编辑器 (`PlanForm`) 的编辑体验与草稿持久化
- **代码证据**：
  - `apps/web/src/components/GoalsPage.tsx:259-277` 的 `PlanForm` 组件：
    - 第 274 行：`{index === tasks.length - 1 && tasks.length > 1 && <Button size="sm" onClick={() => setTasks(tasks.slice(0, -1))}>Remove last task</Button>}` —— 仅允许删除**最后一个**任务，如果用户在编写 6 个任务的计划时想删除第 2 个任务，只能把后面 5 个全部删掉重写。
    - 第 273 行：任务间依赖关系使用数组下标字符串 `String(previousIndex)` 关联，不支持任务上下移动调整顺序。
    - 整个 `PlanForm` 状态仅保存在组件内存 `useState` 中（而聊天输入框 `RoomConversation.tsx` 已实现了 `localStorage` 草稿持久化 `roomDrafts.ts`）。
- **影响**：编写复杂多任务 DAG 计划时容错率低、操作繁琐，误触关闭或刷新页面会导致精心编写的计划草稿全部丢失。
- **优化建议**：
  1. 为每个编辑中的 Task 分配稳定的客户端临时 ID，支持任意位置任务的删除与上移/下移（删除或移动时自动重映射 `dependencies.ref`）。
  2. 参照 `roomDrafts.ts`，按 `goalId` 将未提交的 `PlanForm` 草稿自动同步至 `localStorage`，提交成功后清除。
- **优先级 / 规模**：P2 · M

### X4. 升级聊天输入框的 `@mention` 交互为内联自动补全
- **代码证据**：
  - `apps/web/src/components/RoomConversation.tsx:314` 中，`MessageComposer` 的通知他人功能采用底部折叠面板：`<details className="conversation-composer__mentions"><summary>Notify people</summary><fieldset className="mention-picker">...checkboxes...</fieldset></details>`。
- **影响**：用户在正文输入 `@` 时不会弹出成员候选列表，必须在下方折叠菜单中手动勾选复选框；且勾选的 `mentionIds` 仅作为元数据数组发送，不会与正文中的 `@名字` 同步联动，不符合主流协作工具（Slack / Linear / GitHub）的输入直觉。
- **优化建议**：保留现有 `<details>` 复选框作为无障碍与兜底方式的同时，监听 `<Textarea>` 中的 `@` 触发词，弹出轻量级键盘可导航的成员建议浮层，选中后自动插入 `@display_name` 并同步勾选对应 `mentionIds`。
- **优先级 / 规模**：P2 · M

### X5. 引入全局命令面板 (`Cmd/Ctrl + K`) 与键盘快捷键导航
- **代码证据**：
  - 全仓扫描 `addEventListener("keydown")` 仅出现在 `AppRoutes.tsx:48`（移动端抽屉焦点陷阱）和 `feedback.tsx:221`（Modal 焦点陷阱），缺少全局快捷键体系。
- **影响**：Artoo 包含 Projects、Channels、Goals、Board、Workspace、Machines、Agents、Skills、Memory、Runs 等十余个高频切换视图，重度研发用户与管理员完全依赖鼠标点击跨层级跳转。
- **优化建议**：基于现有的 `<Modal>` 与 `queryKeys.bootstrap` / `queryKeys.tasks` 缓存数据，构建零外部依赖的轻量级 Command Palette（`Cmd/Ctrl + K` 唤起），支持一键切换项目、搜索并跳转到指定 Task / Goal / Channel / Agent、以及触发“新建任务 / 新建目标 / 连接本地节点”等快捷动作。
- **优先级 / 规模**：P3 · M

---

## 6. 性能与可扩展性优化机会 (Performance & Scalability)

### P1. 消除 `presence-service.ts` 中的 N+1 查询风暴与 `runs` 表全量历史扫描（高优！）
- **代码证据**：
  - `apps/server/src/services/presence-service.ts:375-394` 的 `listAgentInstancePresence` 先查出组织内所有 `agentInstances`，随后在 `for (const inst of insts)` 循环中串行调用 `instanceFacts(ctx, inst, isLive)`（第 309–352 行）。
  - 每次 `instanceFacts` 内部执行 **4 次独立数据库查询**：查 `agentRuntimes`、查 `computers`、查 `devices`、调用 `activeRunsForInstance`。当组织有 $N$ 个 Agent 实例时，单次请求触发 **$1 + 4N$ 次 SQL 查询**。
  - 更严重的是，第 297–307 行的 `activeRunsForInstance` 与第 409–415 行的 `computerFacts` 在查询 `runs` 表时**未在 SQL `WHERE` 子句中过滤运行状态**，而是把该实例/机器自创建以来的**所有历史 Run 记录**全量拉回 Node.js 内存，再执行 `rows.filter((r) => isActiveRunStatus(r.runStatus))`！
  - 同理，`listComputerPresence`（第 447–459 行）对每台机器循环调用 `computerFacts`（每次 3 条 SQL 且全表拉取该机器所有历史 `runs`）。
- **影响**：随着系统持续运行，`runs` 表累积数千至数万条已完成的历史记录后，每次调用 `/api/v1/agent-instances/presence` 或 `/api/v1/computers/presence` 都会反复把整张 `runs` 表的数据拉入内存并产生数十次串行 DB 往返，成为服务端最大的延迟与内存瓶颈。
- **优化建议**：
  1. 在 SQL 层使用 `inArray(runs.status, ["queued", "starting", "running", "awaiting_approval"])` 直接过滤活跃状态，彻底杜绝将已完成/已取消的历史 `runs` 拉入内存。
  2. 将 `listAgentInstancePresence` 与 `listComputerPresence` 重构为按 `organizationId` 批量查询一次 `computers`、`devices`、`agentRuntimes` 和活跃 `runs`，在内存中按 `computerId` / `agentInstanceId` 建立 `Map` 进行 $O(1)$ 组装，将 $1 + 4N$ 次查询降至固定 **4–5 次查询**。
- **优先级 / 规模**：P0 · S

### P2. 补齐数据库高频查询路径缺失的索引 (`messages.task_id` 与活跃 `runs` 索引)
- **代码证据**：
  - 对照 `packages/db/src/schema.ts` 与各 Service 的 SQL 查询条件：
    1. **`messages` 表缺少 `task_id` 索引**：`apps/server/src/services/audit-service.ts:72-76` 在生成任务审计包时执行 `WHERE organization_id = ? AND task_id = ? ORDER BY created_at ASC, id ASC`，但 `schema.ts:340-369` 中 `messages` 表仅有 `messages_room_position_idx` 和 `messages_thread_position_idx`，**完全没有 `task_id` 上的索引**，导致每次打开或导出任务审计包都会触发 `messages` 全表扫描。
    2. **`runs` 表缺少按任务的最新运行排序索引**：`apps/server/src/services/context-pack-service.ts:107-108, 153-155` 在组装 ContextPack 时频繁执行 `WHERE organization_id = ? AND task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`，而 `runs` 表目前仅有 `runs_task_status_idx (task_id, status)` 和 `runs_agent_history_idx (organization_id, agent_instance_id, created_at DESC, id DESC)`。
    3. **`runs` 表缺少按机器/实例过滤活跃状态的索引**：`presence-service.ts` 与 `daemon-service.ts` 按 `(organization_id, computer_id, status)` 及 `(organization_id, agent_instance_id, status)` 查询活跃运行，缺少对应复合索引。
- **影响**：在消息量和运行记录增长后，ContextPack 构建、任务审计包查看及在线状态合成的数据库 CPU 开销随表大小线性恶化。
- **优化建议**：新增一个有序 SQL 迁移文件（如 `0061_*.sql`）并同步更新 `packages/db/src/schema.ts`：
  - `messages_org_task_created_idx ON messages (organization_id, task_id, created_at, id)`
  - `runs_org_task_created_idx ON runs (organization_id, task_id, created_at DESC, id DESC)`
  - `runs_org_computer_status_idx ON runs (organization_id, computer_id, status)`
- **优先级 / 规模**：P0 · S

### P3. 优化 `audit-service.ts` 与 `context-pack-service.ts` 中的串行查询与 N+1 循环
- **代码证据**：
  - `apps/server/src/services/audit-service.ts:63-124` 的 `getTaskAuditBundle` 在校验完 `taskRow` 后，依次**串行 `await`** 了 10 条完全独立的 `SELECT` 查询（`rooms`、`messages`、`runs`、`artifacts`、`approvals`、`schedulerDecisions`、`eventLog`、`decisionRecords`、`handoffs`、`blockers`）。
  - 紧接着在 `getGoalAuditBundle`（第 206–209 行）中，又对 Goal 下的每个子任务执行 `for (const child of childTaskRows) { childBundles.push(await getTaskAuditBundle(ctx, child.id)); }`。一个包含 15 个子任务的 Goal 导出证据包时，会串行发起 **$5 + 15 \times 11 = 170$ 次数据库查询**！
  - `apps/server/src/services/context-pack-service.ts:150-169` 在遍历任务的 `edges`（最多 100 条依赖边）时，在 `for` 循环内对每条边串行查询 `runs` 和 `artifacts`（最多 200 次查询）。
- **影响**：复杂 Goal 的审计包导出及多依赖任务的 ContextPack 构建耗时显著增加，在高延迟远程 Postgres（如云端托管库）环境下尤为明显。
- **优化建议**：
  1. 在 `getTaskAuditBundle` 中使用 `Promise.all` 并行执行 10 条无相互依赖的子表读取（保持各自的 `ORDER BY` 确定性排序完全不变）。
  2. 在 `context-pack-service.ts:150` 中，先收集所有 `done` 状态前置任务的 ID，通过 `inArray` 批量查询其最新 completed run 与关联 artifacts，消除循环内单条查询。
- **优先级 / 规模**：P1 · S

### P4. 收敛 Web 端遗漏的固定 5s 轮询与散落的内联 QueryKey
- **代码证据**：
  - 尽管 `T0-2` 和 `T1` 已将大部分轮询迁入 `usePollMs`，但扫描发现仍有 5 处服务端查询硬编码了 `refetchInterval: 5000`：
    - `apps/web/src/components/GoalsPage.tsx:107` (`["goal-automation", goal.id]`)
    - `apps/web/src/components/GoalsPage.tsx:156` (`["goal-release", goal.id]`)
    - `apps/web/src/components/GoalsPage.tsx:197` (`["goal-application-publication", goalId]`)
    - `apps/web/src/components/ReleasePage.tsx:37` (`["goal-automation", goal.id]`)
    - `apps/web/src/components/ReleasePage.tsx:38` (`["goal-release", goal.id]`)
  - 同时，全仓有 **18 处业务查询**直接使用内联字符串数组作为 `queryKey`（如 `["goals", projectId]`、`["plans", goal.id]`、`["checkpoints", goal.id]`、`["discussions", goal.id]`、`["channels", projectId]`、`["devices"]`、`["leases", ...]`、`["dependencies", task.id]`、`["moderation", ...]`），未纳入 `apps/web/src/app/queryKeys.ts` 统一管理；且 `invalidation.ts:43-45` 在收到 `goal.*` 事件时仅失效了 `["goals"]`、`["plans"]`、`["checkpoints"]`，**漏掉了 `["goal-automation"]`、`["goal-release"]` 与 `["goal-application-publication"]`**。
- **影响**：用户在打开 `/goals` 或 `/release` 页面且 WebSocket 正常连接时，仍会产生高频 5s 轮询；而当 WS 推送 `goal.*` 状态变更时，`goal-automation` 与 `goal-release` 缓存却不会立即失效刷新。
- **优化建议**：
  1. 将上述所有散落的 QueryKey 统一收口到 `apps/web/src/app/queryKeys.ts`。
  2. 在 `invalidation.ts` 中将 `goal-automation`、`goal-release`、`goal-application-publication`、`discussions` 纳入对应事件的前缀失效列表。
  3. 对 `goal-automation` 和 `goal-release` 改用 `usePollMs(5000)`（注：`ApplicationPublicationProgress` 因依赖 `health_freshness_ms` 本地倒计时窗口校验，需评估后再决定是否放大轮询间隔）。
- **优先级 / 规模**：P1 · S

### P5. 优化 `RoomConversation` 轮询时的重复快照拉取与可见性串行校验
- **代码证据**：
  - `apps/web/src/components/RoomConversation.tsx:58-65`：
    ```ts
    if (cached?.next_after && onOpenThread && !threadRootId) {
      const latest = await api.listMessages(roomId, { limit: 50 });
      received = mergeMessages(received, latest.messages);
    }
    const trackedIds = [...new Set([...(cached?.messages ?? []).map((message) => message.id), ...])];
    for (let start = 0; start < trackedIds.length; start += 100) {
      await api.messageVisibility(roomId, trackedIds.slice(start, start + 100));
    }
    ```
  - 每次增量轮询或 WS 触发 `messages` 失效重取时，不仅先拉取 `after: cached.next_after`，还会**额外再拉取一次最新 50 条消息**（为了同步 `reply_count`），紧接着对缓存中的所有消息 ID（若用户向上翻阅了 5 页共 250 条消息）每 100 条分批执行 `api.messageVisibility` 校验。
- **影响**：当房间处于活跃讨论或用户加载了较多历史消息时，单次消息刷新会触发 $2 + \lceil M/100 \rceil$ 次 HTTP 请求。
- **优化建议**：
  1. `RealtimeContext.tsx:57-62` 已经在 WS 事件包含 `thread_root_id` 与 `root_reply_count` 时直接在缓存中更新了 `reply_count`；因此第 58–61 行的全量 50 条重拉仅需在 **WebSocket 未连接 (`client?.getStatus() !== "connected"`)** 时作为降级兜底执行。
  2. 对 `messageVisibility` 的分批请求使用 `Promise.all` 并行化，或仅在收到审核相关事件/降级轮询时全量校验已缓存消息。
- **优先级 / 规模**：P1 · S

### P6. 降低 `budget-service.ts` 空闲状态下的每秒数据库扫描频率
- **代码证据**：
  - `apps/server/src/app.ts:138` 默认以 `intervalMs: 1000`（每秒 1 次）启动 `startGoalBudgetMonitor`。
  - `apps/server/src/services/budget-service.ts:146-158` 每秒执行 `SELECT id, organization_id FROM goals WHERE status = 'running'`，并对每个运行中的 Goal 开启事务执行 `SELECT ... FOR UPDATE`、查询 `tasks` 与活跃 `runs`。
- **影响**：即使系统中没有任何 `running` 状态的 Goal，服务端也会以 86,400 次/天的频率持续查询 `goals` 表；在使用远程 Serverless Postgres（如 Neon / Supabase）时，每秒一次的查询会阻止数据库进入自动休眠 (Scale-to-Zero)。
- **优化建议**：
  1. 在 `goals` 表上确保 `(status)` 索引覆盖（或复用 `goals_project_status_idx`），并在 `enforceGoalBudget` 前先在内存检查该 Goal 是否配置了非空的 `max_elapsed_ms` / `max_retries` / `max_cost_usd`（未配置任何预算的 Goal 无需开启 `FOR UPDATE` 事务）。
  2. 支持自适应轮询：当连续多次扫描发现 `running.length === 0` 时，将轮询间隔退避至 `5000ms`（或在 `goal.started` / `goal.resumed` 时立即唤醒 1s 扫描）。
- **优先级 / 规模**：P2 · S

### P7. 消除 iOS 客户端通知计数的双重 JSON 编解码
- **代码证据**：
  - `apps/ios/Sources/App/ArtooApp.swift:191-193`：
    ```swift
    let value = try await live.resource(path: "/api/v1/notifications?limit=1")
    let page = try ArtooJSON.decoder().decode(NativeNotificationPage.self, from: JSONEncoder().encode(value))
    ```
  - `live.resource(path:)` 已经将 HTTP 响应解码为模型对象 `value`，随后代码又用 `JSONEncoder().encode(value)` 将其序列化回 `Data`，再用 `ArtooJSON.decoder().decode(...)` 二次反序列化。
- **影响**：无意义的 CPU 与内存分配开销，且若中间模型的字段映射与 `NativeNotificationPage` 存在细微差异会导致解码失败。
- **优化建议**：在 `ApiClientProtocol` 中直接提供类型化的通知分页或未读计数读取方法，一次解码直达目标类型。
- **优先级 / 规模**：P2 · S

---

## 7. 代码整洁度与架构解耦机会 (Code Cleanliness & Architecture)

### C1. 机械式拆分职责过载的千行级超大模块（延续并深化 T7）
- **代码证据**：全仓非测试源码中超过 900 行的文件共有 15 个，其中前 8 名均超过 1,100 行：
  1. `apps/artood/src/product-source-runtime.ts` (**2,435 行**)：混杂了产品源码运行时配置校验、工作区边界断言、研究修订声明、发布工作区预留、导出捕获 V1/V2 等多阶段逻辑。
  2. `apps/artood/src/node-client.ts` (**2,181 行**)：同时承担普通 Run 启停、Worktree 准备、受管 Journal 交互、验证执行、产品发布、本地应用发布、H4–H7 跨机操作客户端挂载等全部职责。
  3. `packages/db/src/schema.ts` (**1,979 行**)：将身份、任务/DAG、房间/消息、运行/事件、记忆/技能、自治研发、跨节点源码交接、恢复与清洁验证等 **60+ 张表**全部堆叠在单文件中（注意第 2 行其实已经拆分出了 `source-clean-restart-schema.js`，证明按领域拆分 Schema 完全可行）。
  4. `apps/artood/src/product-release.ts` (**1,629 行**)
  5. `apps/artood/src/verification.ts` (**1,618 行**)
  6. `apps/artood/src/process-adapter.ts` (**1,520 行**)
  7. `apps/server/src/node-binding.ts` (**1,438 行**)
  8. `apps/server/src/app.ts` (**1,232 行**)
- **影响**：单文件体积过大导致 IDE 类型推导变慢、上下文理解成本高、多人或多 Agent 并行修改极易产生 Git 合并冲突。
- **优化建议**（严格遵循 `AGENTS.md` 安全边界与 `T7` 机械式拆分原则）：
  - **纯移动 + 原地 `re-export`**：每次仅拆分一个模块并独立提交，保持所有公开导出符号与类型签名 100% 不变。
  - **`packages/db/src/schema.ts`**：按领域拆分为 `schema/identity.ts`、`schema/work.ts`、`schema/messaging.ts`、`schema/execution.ts`、`schema/autonomous-handoff.ts`，在 `schema.ts` 中统一 `export *`。
  - **`apps/server/src/app.ts`**：
    1. 将第 146–274 行约 130 行的 `ctx.on*Queued` 节点派发绑定逻辑提取至 `apps/server/src/node-dispatch-wiring.ts`；
    2. 将仍内联在 `app.ts` 中的 Devices (lines 408–480, 769–780)、Collaboration Decisions/Handoffs/Blockers (lines 527–626)、Goals & Plans & Checkpoints (lines 632–764)、Tasks & DAG (lines 782–884)、Skills (lines 922–952)、Approvals & Leases (lines 967–1018)、Memories (lines 1020–1108) 提取为独立的 `*-routes.ts`（与已拆出的 `project-routes.ts`、`channel-routes.ts`、`discussion-routes.ts` 保持一致），使 `app.ts` 收敛至 300 行以内的纯粹装配层。
- **优先级 / 规模**：P1 · L（分多个独立小 commit 推进）

### C2. 抽象 H4–H7 跨节点阶段派发与回执处理的通用泛型底座
- **代码证据**：
  - 在 `apps/server/src/services/` 下，存在 **12 个结构高度同构的服务文件**（合计超过 **3,800 行代码**）：
    - `imported-product-review-service.ts` (344 行)
    - `imported-design-continuation-service.ts` (370 行)
    - `imported-design-review-service.ts` (345 行)
    - `imported-execution-service.ts` (424 行)
    - `imported-execution-review-service.ts` (~310 行)
    - `imported-execution-repair-service.ts` (~310 行)
    - `imported-validation-service.ts` (318 行)
    - `imported-validation-review-service.ts` (~310 行)
    - `source-recovery-service.ts` (317 行)
    - `recovery-validation-service.ts` (~310 行)
    - `recovery-validation-review-service.ts` (~300 行)
    - `clean-validation-service.ts` / `clean-validation-review-service.ts` (~400 行)
  - 在 `apps/server/src/node-binding.ts:198-250` 中，为每个阶段重复定义了 `pendingDesignStops`、`pendingExecutionStops`、`pendingRepairStops`、`pendingValidationStops`、`pendingRecoveryValidationStops`、`pendingCleanValidationStops` 等几乎一模一样的 Map 与超时清理逻辑。
  - 在 `apps/server/src/app.ts:187-266` 中，12 个 `ctx.on*Queued` 回调也是完全相同的“按 `(id, organizationId)` 查表 → `nodeRegistry.get(row.computerId)` → 判空抛 `409 Conflict` → 调用 `binding.dispatch*(id, control)`”模板。
- **影响**：每新增一个自治研发或跨机验证子阶段，就需要在 `schema.ts`、`domain`、`protocol`、`server/services`、`node-binding.ts`、`app.ts`、`artood` 同步复制粘贴上千行样板代码，极易在某个分支漏掉 `stop` 超时清理或会话世代校验。
- **优化建议**：
  1. 先从最无风险的 `app.ts` 入手，提炼通用辅助函数 `bindNodeQueueDispatcher(ctx, nodeRegistry, table, errorMsg, pickMethod)`，将 `app.ts:187-266` 的 80 行重复代码压缩为 15 行配置表。
  2. 在 `node-binding.ts` 中提炼通用的 `createPendingStopRegistry<TId>(timeoutMs)` 统一管理各阶段的 `pending*Stops` 生命周期与 `close()` 清理。
- **优先级 / 规模**：P2 · M

### C3. 清理散乱的 Import 语句（含文件末尾 Import 与重复模块导入）
- **代码证据**：
  - `apps/server/src/app.ts`：
    - 文件最底部第 **1232 行** 竟然有一条 `import { goalSourceRecoveries, goalRecoveryValidations, goalRecoveryValidationReviews } from "@artoo/db";`！
    - 文件顶部第 4、10、45、46 行另有 4 处分开写的 `import { ... } from "@artoo/db"`，以及第 40 行和第 48 行分两次 `import { eq } from "drizzle-orm"` / `import { and } from "drizzle-orm"`。
  - `apps/server/src/node-binding.ts:1-56`：对 `@artoo/db` 分了 8 次 `import`，对 `@artoo/domain` 分了 13 次 `import`。
  - `apps/server/src/services/context-pack-service.ts:1-22`：对 `@artoo/db` 和 `@artoo/domain` 同样存在多次重复导入。
- **影响**：高频追加特性时在文件首尾直接插入 `import` 导致头部与尾部杂乱，降低了模块依赖关系的清晰度。
- **优化建议**：合并同一模块的重复 `import` 语句，将 `app.ts:1232` 的尾部导入移回文件顶部，并按“内置模块 → 外部依赖 → `@artoo/*` 工作区包 → 相对路径”统一排序。
- **优先级 / 规模**：P1 · S

### C4. 引入轻量级代码格式化与静态检查工具链 (Biome 或 ESLint + Prettier)
- **代码证据**：
  - 检查根目录配置文件发现，仓库目前**没有任何 `.eslintrc`、`eslint.config.*`、`biome.json` 或 `.prettierrc`**，根 `package.json` 也无 `lint` 或 `format` 脚本。
  - 由于缺少单行长度与格式化约束，代码库中出现了大量单行 500–950 字符的“压缩式”JSX/TS 代码（例如 `apps/web/src/components/GoalsPage.tsx:146` 单行 950+ 字符、`InventoryPages.tsx:132` 单行 580+ 字符、`RoomConversation.tsx:111` 单行 620+ 字符）。
- **影响**：超长单行代码在 Code Review 和 Git Diff 时极难定位具体修改点，任何一处微小的属性调整都会造成整行 800 字符的 diff 冲突。
- **优化建议**：
  1. 引入极速、零配置依赖负担的 **Biome**（或 Prettier + ESLint），配置 `lineWidth: 120`。
  2. 先对新增/修改文件启用 `npx biome check --changed`（避免一次性格式化全仓造成巨型 diff 冲击 blame 历史），并在拆解组件时逐步格式化存量超长行。
- **优先级 / 规模**：P2 · S

### C5. 治理 `scripts/` 与 `docs/` 目录平铺膨胀
- **代码证据**：
  - `scripts/` 目录下共有 **136 个文件**，其中 `scripts/` 根层级直接平铺了 **61 个 `.mjs` 脚本**（大量 `ios-ui-*`、`preview-*`、`recovery-*`、`v1-*` 混杂在一起）。
  - `docs/` 目录下共有 **113 篇文档**（含 `docs/superpowers/` 下 27 篇阶段性过程文档及多篇按日期命名的快照文档）。
- **影响**：新加入的开发者或 Agent 难以快速分辨哪些脚本是当前 CI 门禁的主入口、哪些文档是现行有效规范 vs 历史归档记录。
- **优化建议**：
  1. 在 `docs/` 根目录建立 `docs/INDEX.md`（文档地图），按“现行架构与契约”、“运维与发布 Runbook”、“客户端指南”、“历史里程碑归档”分类索引。
  2. 在不破坏 `package.json` 与 `.github/workflows/*.yml` 引用路径的前提下，为 `scripts/` 建立清晰的 README 索引，后续新增脚本按 `scripts/ios/`、`scripts/gates/`、`scripts/fixtures/` 归类存放。
- **优先级 / 规模**：P3 · S

---

## 8. 工程效率、开发者体验与 CI/CD 优化机会 (DX & CI/CD)

### E1. 移除 CI `shared-vitest` 分片中冗余的 Playwright Chromium 安装步骤
- **代码证据**：
  - `.github/workflows/preview.yml:50-80` 定义了 `shared-vitest` 矩阵任务（`shard: [1, 2]`，运行在 `windows-latest` 上）。
  - 第 66–67 行在两个分片中均执行了：
    ```yaml
    - run: npx playwright install chromium
      working-directory: apps/web
    ```
  - 然而 `shared-vitest` 仅运行 `vitest`（扫描 `{apps,packages}/**/*.test.{ts,tsx}`），所有的 Playwright E2E 测试（`test:e2e` 与 `e2e:auth`）实际上只在 `shared-checks` 任务（第 107–130 行）中执行！
- **影响**：每次 Push 和 PR 都在两台 Windows Runner 上白白下载并解压数百 MB 的 Chromium 浏览器，浪费 CI 耗时与网络带宽。
- **优化建议**：删除 `.github/workflows/preview.yml` 中 `shared-vitest` 任务的 `npx playwright install chromium` 步骤（保留 `shared-checks`、`ios`、`mac-desktop`、`windows-desktop` 中实际需要浏览器证据的步骤）。
- **优先级 / 规模**：P0 · S

### E2. 优化本地与 CI 的 iOS 验证构建链路，减少重复 `build:preview`
- **代码证据**：
  - `package.json:15-19` 中，`verify:ios:core`、`verify:ios:assistant`、`verify:ios:mentions`、`verify:ios:correction`、`verify:ios:retention` 五条命令均硬编码了前置 `npm run build:preview && ...`。
  - `.github/workflows/preview.yml:131-195` 的 `ios` 任务在单台 `macos-15` Runner 上串行运行全部检查与 5 个原生 UI 套件，超时阈值高达 **180 分钟**。
- **影响**：本地调试多个 iOS UI 子套件时会反复触发全量 TypeScript + Vite 打包；CI 上单机串行执行使 PR 反馈周期拉长至 1.5–2 小时以上。
- **优化建议**：
  1. 在 `scripts/ios-ui-suites-e2e.mjs` 中支持传入逗号分隔的多个 suite（如 `--suite=core,mentions`），实现一次 `build:preview` + 一次 `xcodegen` 连续跑完指定子集。
  2. 中期可将 `.github/workflows/preview.yml` 中的 `ios` 任务仿照 `shared-vitest` 拆分为 `ios-build` + 按 suite 并行的矩阵任务（需注意遵守源码指纹一致性校验契约 `verifyUISuiteResults`）。
- **优先级 / 规模**：P2 · M

### E3. 优化 Vitest 本地开发反馈速度（区分纯单元测试与 PGlite 重型集成测试）
- **代码证据**：
  - `vitest.config.ts:25-35` 将所有 `{apps,packages}/**/*.test.{ts,tsx}` 放在同一个默认池中运行，因 PGlite (WASM Postgres) 初始化开销较大，全局设置了 `testTimeout: 30000` 并要求 `--maxWorkers=2`。
- **影响**：开发者在修改纯函数模块（如 `packages/domain`、`packages/protocol` 或 `apps/web` 组件）时，运行 `npm test` 仍需等待数百个 PGlite 数据库实例启停。
- **优化建议**：在根 `package.json` 中补充快捷脚本（如 `test:unit` 指向 `packages/domain`、`packages/protocol`、`apps/web` 等无 DB 测试，`test:server` 指向服务端测试），保留 `npm test` 的全量语义不变，提升日常 TDD 循环速度。
- **优先级 / 规模**：P3 · S

---

## 9. 分阶段持续优化路线图与 ROI 矩阵

为便于团队与 Coding Agent 按 **“一个任务 = 一个独立可验证 Commit”** 的节奏持续推进，以下将全部优化机会按 **ROI（投入产出比）与紧迫度** 划分为四个阶段：

### 9.1 汇总优先级矩阵

| 编号 | 类别 | 优化事项 | 核心文件定位 | 收益 (Impact) | 规模 | 风险 | 优先级 |
| --- | --- | --- | --- | --- | :---: | :---: | :---: |
| **P1** | 性能 (Server) | 消除 `presence-service.ts` 的 N+1 查询与 `runs` 全表内存过滤 | `apps/server/src/services/presence-service.ts:297-459` | 极高（消除随历史运行增长的 O(N) 全表扫描） | S | 低 | **P0** |
| **P2** | 性能 (DB) | 为 `messages.task_id` 与 `runs` 高频过滤排序路径补齐复合索引 | `packages/db/src/schema.ts`, `packages/db/migrations/` | 极高（消除审计包与 ContextPack 全表扫描） | S | 低 | **P0** |
| **E1** | CI/CD | 移除 `preview.yml` 中 `shared-vitest` 分片冗余的 Playwright 安装 | `.github/workflows/preview.yml:66-67` | 高（每次 CI 节省双分片浏览器下载耗时） | S | 极低 | **P0** |
| **P3** | 性能 (Server) | 并行化 `getTaskAuditBundle` 内部查询并批量化 `context-pack` 依赖查询 | `apps/server/src/services/audit-service.ts`, `context-pack-service.ts` | 高（大幅降低复杂 Goal 审计导出与任务启动延迟） | S | 低 | **P1** |
| **P4** | 性能 (Web) | 将 `GoalsPage` / `ReleasePage` 剩余 5s 轮询接入 `usePollMs` 并收口 `queryKeys` | `apps/web/src/components/GoalsPage.tsx`, `ReleasePage.tsx`, `app/queryKeys.ts`, `app/invalidation.ts` | 高（减少后台冗余请求，修复 WS 事件下缓存不失效） | S | 低 | **P1** |
| **P5** | 性能 (Web) | 优化 `RoomConversation` 轮询时的重复快照请求与可见性校验 | `apps/web/src/components/RoomConversation.tsx:58-65` | 中高（减少活跃房间请求放大） | S | 低 | **P1** |
| **X1** | 交互 (UX) | 消除 `/` (三栏工作台) 与 `/board` 在 `ProductHeader` 中的 Tab 高亮歧义 | `apps/web/src/components/ProductHeader.tsx:31`, `Nav.tsx` | 高（理顺核心导航心智模型，提供直达工作台入口） | S | 低 | **P1** |
| **X2** | 交互 (UX) | 修正 `LeftRail` 待审批徽标的项目作用域并支持点击筛选待审批任务 | `apps/web/src/components/LeftRail.tsx:29-45` | 中高（消除多项目误导，打通告警到处理的动作闭环） | S | 低 | **P1** |
| **U2** | UI 系统 | 挂载 `ToastProvider` 并在关键写操作中启用闲置的 `Toast` / `Tooltip` 原语 | `apps/web/src/app/App.tsx`, `ui/feedback.tsx` | 中高（统一全站操作成功/失败反馈体验） | S | 低 | **P1** |
| **U3** | UI 系统 | 优化顶部 `ConnectionStatus` 横幅：正常态收起为状态指示点，异常态展开 | `apps/web/src/components/ConnectionStatus.tsx`, `ui/product-shell.css` | 中高（释放纵向空间，降低正常态视觉噪音） | S | 低 | **P1** |
| **C3** | 代码整洁 | 清理 `app.ts`（含第 1232 行底部 import）与 `node-binding.ts` 的散乱重复导入 | `apps/server/src/app.ts`, `node-binding.ts`, `context-pack-service.ts` | 中（零风险提升代码整洁度） | S | 极低 | **P1** |
| **F1** | 功能 (Domain) | 打通 DAG `artifact_required` / `contract_required` 边的证据门控闭环 | `packages/domain/src/dag.ts:89`, `apps/server/src/services/dag-service.ts` | 中高（兑现设计文档中的强类型依赖证据契约） | S | 中 | **P1** |
| **C1** | 架构解耦 | 机械式拆分超大模块（`app.ts`、`schema.ts`、`node-client.ts` 等，延续 T7） | `apps/server/src/app.ts`, `packages/db/src/schema.ts`, `apps/artood/src/*` | 高（显著提升可维护性与多 Agent 并行开发效率） | L | 中 | **P1** |
| **U1** | UI 系统 | 持续迁移 `styles.css` 剩余 1,233 行规则至模块化 `ui/*.css`（延续 T6） | `apps/web/src/styles.css`, `apps/web/src/ui/*.css` | 中（消除全局标签选择器污染与双轨制） | M | 低 | **P1** |
| **F2** | 功能 (Budget) | 打通 Run Usage 成本汇总至 `goals.elapsed_cost_usd` 与 `max_cost_usd` 熔断 | `apps/server/src/services/run-service.ts`, `budget-service.ts`, `GoalsPage.tsx` | 中高（补齐自治研发的成本安全护栏） | M | 低 | **P2** |
| **U4** | UI 系统 | 为 `GoalsPage`、`ReleasePage`、`AgentHistoryPage` 补齐 `<Skeleton>` 占位 | `apps/web/src/components/GoalsPage.tsx`, `ReleasePage.tsx`, `AgentHistoryPage.tsx` | 中（消除页面切换布局抖动 CLS） | S | 极低 | **P2** |
| **X3** | 交互 (UX) | 增强 `PlanForm`：支持任意位置任务删除/重排与 `localStorage` 草稿持久化 | `apps/web/src/components/GoalsPage.tsx:259-277` | 中（大幅改善手动编写多任务计划的体验） | M | 低 | **P2** |
| **X4** | 交互 (UX) | 为 `MessageComposer` 增加输入 `@` 时的内联成员自动补全浮层 | `apps/web/src/components/RoomConversation.tsx:301-320` | 中（对齐现代 IM 的 `@mention` 交互直觉） | M | 低 | **P2** |
| **P6** | 性能 (Server) | 优化 `budget-service` 空闲时的每秒 DB 轮询，支持自适应退避 | `apps/server/src/services/budget-service.ts:140-160` | 中（降低空闲 DB 负载，友好支持 Serverless PG） | S | 低 | **P2** |
| **P7** | 性能 (iOS) | 消除 `ArtooApp.swift` 中通知计数的双重 JSON 编解码 | `apps/ios/Sources/App/ArtooApp.swift:191-193` | 中低（提升代码整洁度与解码效率） | S | 极低 | **P2** |
| **C2** | 架构解耦 | 提炼 H4–H7 跨机阶段派发与 `pending*Stops` 的通用泛型辅助函数 | `apps/server/src/app.ts:187-266`, `node-binding.ts`, `services/imported-*` | 中高（消减数千行同构样板代码） | M | 中 | **P2** |
| **C4** | 工程工具 | 引入 Biome / Prettier + ESLint 并逐步治理 500+ 字符的超长单行代码 | `package.json`, `apps/web/src/components/*` | 中（大幅提升 Git Diff 可读性与代码规范性） | S | 低 | **P2** |
| **E2** | CI/CD | 支持 `ios-ui-suites-e2e.mjs` 多 suite 批量组合执行并评估 CI 矩阵并行化 | `scripts/ios-ui-suites-e2e.mjs`, `.github/workflows/preview.yml` | 中高（缩短 Apple 客户端 E2E 验证等待时间） | M | 中 | **P2** |
| **F3** | 功能 (iOS) | 在 iOS 客户端增补轻量级 Goals/Plans 管控与 Release 状态/紧急停止面板 | `apps/ios/Sources/Views/*`, `ArtooApp.swift` | 中高（补齐移动端对自治目标与发布的管控闭环） | L | 低 | **P2** |
| **F4** | 功能 (Search) | 为 Messages / Tasks / Memories 增加服务端全文检索接口与索引 | `apps/server/src/services/*`, `packages/db/src/schema.ts` | 中（突破前端单页内存过滤限制） | M | 低 | **P2** |
| **X5** | 交互 (UX) | 引入全局命令面板 (`Cmd/Ctrl + K`) 支持跨项目/任务/频道快速跳转 | `apps/web/src/components/*` | 中（提升高频用户与管理员操作效率） | M | 低 | **P3** |
| **F5** | 功能 (Security) | 实现审计证据包 `AuditBundleExport` 的可选 Ed25519 数字签名 | `apps/server/src/services/audit-service.ts:150,243` | 中低（增强导出证据的防篡改可信度） | S | 低 | **P3** |
| **C5** | 仓库整洁 | 建立 `docs/INDEX.md` 文档地图与 `scripts/` 分类索引 | `docs/`, `scripts/` | 中低（降低新成员与 Agent 的上下文检索成本） | S | 极低 | **P3** |

### 9.2 推荐执行路径

1. **第一波（立竿见影 · 性能与 CI 止血，预计 3–5 个独立 Commit）**：
   - 执行 **E1**（移除 `preview.yml` 冗余 Playwright 安装）；
   - 执行 **P1 + P2**（修复 `presence-service.ts` N+1 与 `runs` 全量加载，新增 `messages.task_id` 与 `runs` 复合索引迁移）；
   - 执行 **P3 + P4**（并行化 `getTaskAuditBundle` 查询，收敛 Web 端剩余 5s 轮询与 `queryKeys`）。
2. **第二波（体验跃升 · UI/UX 与整洁度快赢，预计 5–8 个独立 Commit）**：
   - 执行 **C3**（清理 `app.ts` 尾部及重复 import）；
   - 执行 **X1 + X2**（修复 `ProductHeader` Tab 高亮歧义与 `LeftRail` 待审批徽标交互）；
   - 执行 **U2 + U3 + U4**（启用 `ToastProvider`、收起正常态 `ConnectionStatus`、补齐 `GoalsPage` / `ReleasePage` 骨架屏）。
3. **第三波（深度解耦与核心功能闭环，按模块稳步推进）**：
   - 执行 **F1 + F2**（DAG 证据门控与成本预算闭环）；
   - 执行 **C1 + C2 + U1**（分批拆解 `app.ts`、`schema.ts`、`artood` 大文件，收敛 `styles.css`）；
   - 执行 **X3 + X4 + F3 + F4**（升级计划编辑器、内联 `@mention`、服务端搜索与 iOS 端 Goal/Release 管控）。

---

## 10. 附录：v0.1 产品定位与开源生态调研基线 (2026-06-11)

> *注：本节保留自项目初期 `opportunities.md`（2026-06-11），以维持 [design.md](./design.md) 的输入引用完整性。*

### 10.1 核心产品定位

Artoo 的定位不是“又一个单机 AI coding agent”或“又一个通用 IM”，而是一个 **Open-Source Agent Team Operating System**：

- **Computer Control Plane**：统一连接多台 Computer（本机、工作站、云主机、CI runner、沙箱、macOS/Windows 桌面），发现每台机器上的 Agent Runtime、资源、权限和健康状态，并将任务调度到最合适的机器与实例。
- **Agent-Native IM**：把人类用户和 Agent 都建模为对等的 Actor，支持频道、任务房间、线程回复、状态、@mention、审批、Handoff 和可审计消息流。
- **Scrum / Goal Dashboard**：把 Goal、Plan、Task DAG、Artifact、Approval 和 Agent Run 串联起来，使 Web / Desktop / iOS 客户端既能对话协作，也能创建、分发、暂停、验收任务与发布产物。
- **Skill Governance**：用统一的 `v1alpha1` Skill Manifest 管理技能、权限声明、兼容 Runtime、输入输出 Schema 与启停策略。
- **Auditable Collaboration Protocol**：Agent 之间的拆解、执行、独立评审 (Independent Review)、交接 (Handoff)、阻塞 (Blocker) 和决策 (Decision Record) 全部沉淀为结构化、可重放、可导出的持久化记录，而非黑箱调用。

### 10.2 八大核心领域抽象

1. **Actor**：User、Agent 或 System。
2. **Computer**：可配对连接、可调度、可观测的计算节点（由 `artood` 守护进程驱动）。
3. **Agent Runtime**：某类 Agent 的适配器与运行环境（如 `codex`、`claude-code`、`mock`）。
4. **Agent Instance**：在特定 Computer 与 Workspace 上配置并运行的具名 Agent 实例。
5. **Goal & Plan**：持久化的业务目标及其可物化为 Task DAG 的版本化执行计划。
6. **Task**：进入看板与 DAG 流程、支持文件租约 (`file_leases`) 与依赖门控的工作单元。
7. **Room**：围绕频道、Task 或 Goal 建立的 IM 协作与结构化记录空间。
8. **Run & Verification Evidence**：单次执行过程，包含命令回执、流式日志、工具调用活动、资源消耗、审批点、制品以及**节点独占确认的验证/发布证据**。

### 10.3 开源生态对标结论

| 领域 | 代表性开源项目 | 生态现状与空白 | Artoo 的差异化切入点 |
| --- | --- | --- | --- |
| Coding Agent / Runtime | OpenHands, SWE-agent, Codex CLI, Claude Code, Cline, Roo Code, Aider | 单任务代码生成与本地终端/IDE 执行能力强，但缺乏跨机器团队控制平面 | 将各类 CLI/Agent 封装为标准 `RuntimeAdapter`，复用其执行能力而不重复造底层编码轮子 |
| Computer-Use / Sandbox | browser-use, Agent-S, Cua, Bytebot, Daytona, E2B | 聚焦“让单个 Agent 操作一个环境” | 聚焦“让多个 Agent 在多台受控 Computer 上被统一发现、授权、隔离调度与验收” |
| Multi-Agent Framework | AutoGen, LangGraph, CrewAI, CAMEL, Agno, Mastra | 面向开发者的 SDK/图编排框架，缺乏面向终端团队的 IM + 看板 + 审批产品界面与物理节点管理 | 提供开箱即用的 Web/iOS/Desktop 控制面与持久化协作记录（Decisions / Handoffs / Blockers） |
| 通用 IM & 项目管理 | Mattermost, Zulip, Matrix / Plane, OpenProject, AppFlowy | 为纯人类协作设计，Agent 只能作为二等公民 Webhook Bot 挂载，消息与任务执行证据割裂 | 原生融合 Room 对话、Goal/Plan 拆解、DAG 看板与节点级验证/发布证据链 |
