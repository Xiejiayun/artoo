# Artoo 全栈持续优化与演进机会分析报告 (Opportunities)

> - **报告更新日期**：2026-11-13
> - **分析基线**：`main` 分支 @ `49c514d`（含 `T0`–`T9` 近期优化提交）
> - **复核范围**：对照当前源码、契约、测试与 CI 入口做静态复核；DAG 与预算相关 4 个测试文件、30 项测试通过。未运行 UI 实测、性能基准、完整 CI 或真实 Provider 验收；收益、规模与风险为待验证估计。
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

按 `git ls-files` 统计，全仓追踪 **1,988 个文件**。其中 `.ts` / `.tsx` / `.mjs` / `.swift` / `.css` 共 **1,629 个文件、270,183 个物理行**（包含空行、注释和已追踪的 vendor/fixture）；按 `.test` / `.spec` 的 TS/TSX/MJS 文件及 iOS `Tests` / `UITests` 下 Swift 文件计，共 **759 个测试文件**。另有 **61 个 SQL 迁移文件**（包含 `0000`）、`docs/` 下 **93 篇 Markdown** 与 **9 条 GitHub Actions 工作流**。这些是规模统计，不代表有效测试用例数或覆盖率：

| 模块 / 目录 | 上述扩展名文件数 | 物理行数 (LOC) | 职责定位 |
| --- | ---: | ---: | --- |
| `apps/artood` | 546 | 107,567 | 本地执行守护进程（Runtime 适配器、受保护验证 Profile、Git Worktree 隔离、本地/静态发布执行器、Windows 进程守卫） |
| `apps/server` | 325 | 61,033 | Fastify 控制平面服务端（认证授权、GoalRunner、DAG 调度、ContextPack 组装、节点绑定、WS Hub、审计导出） |
| `apps/web` | 199 | 21,897 | React + Vite + TanStack Query 共享 Web / 桌面渲染层控制面 |
| `apps/ios` | 81 | 20,203 | SwiftUI 原生 iOS/iPadOS 客户端及 XCTest UI 自动化套件 |
| `packages/domain` | 145 | 16,817 | 版本化领域模型、状态机、Zod 契约、DAG 与预算纯函数 |
| `apps/desktop` | 40 | 7,231 | Electron 桌面外壳与内置本地守护进程桥接 |
| `validation/managed-workspaces` | 33 | 5,243 | 受管工作区验证夹具与快照 |
| `packages/db` | 39 | 4,782 | Drizzle ORM Schema（60+ 张表）与只追加 SQL 迁移（PGlite / Postgres 双兼容） |
| `scripts/` | 129 | 18,924 | 预览门禁、iOS/Mac/Windows E2E 编排、npm daemon 打包与发布脚本 |
| `packages/protocol` | 42 | 2,533 | Server ↔ Node 双工传输信封与命令确认协议 |
| `packages/storage` | 22 | 1,950 | 数据库连接池、事务包装与内容寻址 Blob 存储 |
| `packages/node-supervisor` & `client` | 14 | 1,516 | 节点进程监管与轻量 API 客户端 |

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
- **首轮大文件拆分与 i18n 脚手架 (`ca224f0`, `8102ee2`)**：从 `node-client.ts` 拆出 `node-client-records.ts`，并在 `apps/web/src/app/i18n.ts` 建立轻量多语言脚手架（覆盖 `LoginPage` 与 `RouteErrorBoundary`）。
- **DAG 证据门控注释更正 (`49c514d`)**：移除已过时的 Phase A TODO；服务端证据门控早已接入，此提交没有新增门控行为，见 F1 的复核结论。

以下按 **6 大维度**列出候选机会，区分已实现能力、可确认的问题与待测量假设。F1 保留编号用于记录更正，不再列入待办；E4 补充产品验收缺口。本文是候选清单，实施时仍需核对最新代码并遵循 `AGENTS.md` 的验证要求，不能将静态推断当作性能或产品验收结果。

---

## 3. 功能与产品完备度优化机会 (Feature & Product)

### F1. DAG 证据门控已实现（更正，不再列入待办）

- **代码证据**：`apps/server/src/services/dag-service.ts` 的 `loadEvidenceMap` 查询组织内前置任务的制品，`isDependentSatisfied` 先调用 `isTaskUnlocked`，再调用 `hasRequiredEvidence`。`unlockDownstream` 和 `lifecycle-service.ts` 的手动就绪路径均使用完整门控。
- **测试证据**：`apps/server/src/dag-evidence.test.ts` 覆盖缺少 artifact、普通 artifact 不满足 contract 要求、review 语义及自动解锁；本次与 `dag-unlock.test.ts`、`goal-budget-gates.test.ts`、`services/budget-service.test.ts` 一并运行，4 个文件、30 项测试全部通过。
- **结论**：原报告根据过时注释推断“仅判断 done、尚未接入证据校验”不成立；`49c514d` 已更正该注释。保持现有行为，不重复实施。

### F2. 先定义可信计费契约，再实现 Goal 成本预算 (`max_cost_usd`)
- **代码证据**：
  - `packages/db/src/schema.ts` 的 `goals` 表已包含 `elapsed_cost_usd` 列，`apps/server/src/services/budget-service.ts:32-35, 68` 已读取 `cost_usd: goal.elapsedCostUsd`，但 `PAUSE_BUDGETS` 集合（第 32 行）仅包含 `"max_elapsed_ms"` 和 `"max_retries"`，未包含 `"max_cost_usd"`。
  - `apps/web/src/components/GoalsPage.tsx:94` 表单提示：`Cost budgets are unavailable until runtimes report reliable usage costs`。
  - 与此同时，服务端已有 `GET /api/v1/runs/:id/usage` (`run-service.ts:getRunUsage`) 与前端 `RunUsageSummary.tsx` 展示单次 Run 的 Token 及成本消耗。
  - `apps/server/src/services/budget-policy.ts:supportedGoalPolicy` 明确拒绝非空 `max_cost_usd`；`goal-budget-gates.test.ts` 覆盖 API 创建与恢复旧数据后的执行拒绝。`run-service.ts` 对 Usage 使用 upsert 更新当前快照，不能假定每条事件都是可直接累加的增量。
- **影响**：当前不提供美元成本预算保障，并通过拒绝不支持的配置避免虚假承诺。已有单次 Usage 展示不代表所有 Runtime 都能持续提供完整、可靠的费用数据。
- **优化建议**：
  1. 先定义按 Run / Provider Session 绑定的累计或增量语义、币种、重复/乱序事件、费用修正、缺失上报、重启恢复与未知费用策略；按兼容约定扩展契约，不能把未知费用计为 0。
  2. 在事务中处理幂等计量与 Goal 汇总，并验证重放、并发上报和进程重启不会重复记账或漏记。
  3. 明确“暂停后续调度”与“硬性支出上限”的区别：现有预算暂停允许在途 Run 继续完成，上报延迟也可能造成超额。可信计量和相应执行策略就绪后，才调整 `supportedGoalPolicy`、预算评估、调度准入及 UI；不支持的 Runtime 继续拒绝成本保障配置。
- **优先级 / 规模**：P2 · L（计费契约与运行时能力为前置条件，风险中高）

### F3. 补齐 iOS 的 Release 管控与 Agent History，改善现有 Goals 入口发现性
- **代码证据**：
  - Web 端顶部主导航 (`apps/web/src/components/ProductHeader.tsx:8-13`) 围绕四大核心研发流构建：`01 Thread (/channels)`、`02 Plan (/goals)`、`03 Board (/board)`、`04 Release (/release)`，外加 `/agents/:agentId/history` 执行历史浏览器。
  - iOS 的 `RootTab` 没有独立 Goals Tab，但 `ArtooApp.swift:WorkspaceSettingsView` 已有 **More → Goals** 入口；`Views/WorkspaceViews.swift:GoalDetailView` 已支持 Goal 暂停/恢复/取消、计划接受/拒绝、Checkpoint 查看与审计导出，`AgentDiscussionView` 也能进入计划审阅。
  - 尚未发现与 Web Release 页对应的发布健康/停止面板，以及按 Agent 聚合工具调用的完整 Agent History 视图；现有 Run history 不能直接等同于该聚合视图。
- **影响**：移动端具备 Goal/Plan 基础管理能力，剩余差距主要是发布管控和 Agent 维度历史。Goals 入口是否需要提升到一级导航，应结合使用路径评估，不能仅凭缺少独立 Tab 判断功能缺失。
- **优化建议**：
  1. 复用现有 GoalDetailView，评估从 Tasks 或频道增加上下文入口，避免重做 Goals/Plans 管理功能。
  2. 分别补充静态站点发布与本地应用发布的状态/健康展示，核对各自的授权和停止语义；本地应用停止可复用 `POST /api/v1/goals/:id/application-publication/stop`，不能将它用作所有发布类型的统一停止接口。
  3. 为 Agent History 增加按需加载和分页，验证鉴权、断线、停止失败及窄屏交互；原生 UI 验证需在 macOS/iOS 环境完成。
- **优先级 / 规模**：P2 · L（分发布管控、历史浏览与入口优化实施）

### F4. 完善服务端全局检索与消息搜索能力
- **代码证据**：
  - 目前 Web 端的所有搜索框——包括 `BoardView.tsx:93`、`TaskList.tsx`、`GoalsPage.tsx:44`、`InventoryPages.tsx:61,132`、`RunsAuditPage.tsx:67`、`MemoryPage.tsx`——全部是在前端内存对当前拉取的单批次数组执行 `.toLowerCase().includes(...)` 子串匹配。
  - T5 为若干列表增加的是**可选 `limit` 上限**，不等于已完成游标分页。Web 的 `api.listTasks(projectId)` 和 `api.listGoals(projectId)` 当前未传 `limit`，不能据此认定任务/目标搜索已经漏掉后续页。房间消息本身已分页，但 `RoomConversation.tsx` 尚无消息搜索入口。
- **影响**：已有任务列表仍需全量拉取后过滤，随规模增长有成本；消息历史检索缺少入口。以后引入有界列表或分页时，需要同步设计全量范围的服务端搜索。
- **优化建议**：
  1. 为 `GET /api/v1/rooms/:id/messages`、`GET /api/v1/tasks`、`GET /api/v1/memories` 增加可选的服务端 `q` 查询参数。
  2. 先定义查询范围、排序、分页和搜索语言，再基于查询计划选择全文索引或 `pg_trgm`；验证 PGlite / Postgres 的实际支持，并使用新迁移。搜索必须复用组织、项目和房间授权，过滤已移除消息及不可见内容，不能通过摘要或命中计数泄露它们。
- **优先级 / 规模**：P2 · M

### F5. 审计证据包数字签名 (`AuditBundleExport.signature`) 落地
- **代码证据**：
  - `apps/server/src/services/audit-service.ts:150-154` 与 `243-247` 在导出任务与 Goal 审计包时，固定返回：
    ```ts
    signature: null,
    signing: { status: "deferred", reason: "v1 does not manage signing keys yet" }
    ```
- **影响**：导出的 `.json` 审计包虽有 `bundle_sha256` 摘要，但缺乏服务端非对称密钥签名（Ed25519），第三方或合规审计时无法独立验证该证据包确实由特定 Artoo Server 实例签发且未被篡改。
- **契约约束**：`packages/domain/src/schemas.ts:AuditBundleExportSchema` 与 `goal.ts:GoalAuditBundleExportSchema` 目前均固定 `signature: null` 和 `signing.status: deferred`，不能只在服务端填入字符串签名。
- **优化建议**：先设计兼容的版本化签名元数据、确定性签名字节、算法与 key ID，再接入受保护的 Ed25519 密钥配置、公钥分发、轮换/撤销与离线验签。明确签名覆盖哪些包/导出字段；实例身份须由可信公钥锚定，不能仅凭同一服务端暴露的公钥自证。未配置密钥时保持原有 `deferred` 输出，并覆盖跨版本及篡改拒绝测试。
- **优先级 / 规模**：P3 · M（涉及契约与密钥生命周期，风险中）

---

## 4. UI 与视觉一致性优化机会 (UI & Visual System)

### U1. 分批收敛遗留 CSS 与全局选择器
- **代码证据**：
  - `apps/web/src/styles.css` 仍有 **1,263 行**，顶部注释说明仍在逐步迁移到 `ui/` 原语。
  - 文件仍有裸 `button`、`label` 等全局选择器与硬编码颜色。连接横幅规则在 `ui/product-shell.css` 中也有定义，但后者选择器更具体且由 `main.tsx` 后加载，因此不能仅凭旧色值认定当前页面的暗色对比度异常；需检查实际计算样式。
- **影响**：全局元素选择器（尤其是裸 `button` 和 `label`）容易污染新增组件样式，导致必须不断提高选择器特异性才能覆盖；两套 CSS 并存也增加了样式体积与维护心智负担。
- **优化建议**：
  1. 按组件域迁移规则，先保持加载顺序和特异性不变，再逐步缩小全局选择器作用域；单纯移动文件不能自动消除级联冲突。
  2. 在适用场景复用 `<Button>`、`<Input>`、`<Select>`，保留必要的原生控件语义。删除旧规则前检查全部调用方，并验证亮/暗主题、窄屏、键盘与焦点状态。
- **优先级 / 规模**：P2 · M

### U2. 启用已建成但闲置的 UI 反馈原语 (`ToastProvider` / `OfflineBanner` / `Tooltip` / `SkeletonText`)
- **代码证据**：
  - `apps/web/src/ui/feedback.tsx` 完整实现并导出了 `ToastProvider`、`useToast`、`OfflineBanner`、`Tooltip`、`SkeletonText`，且拥有完备的单元测试 (`feedback.test.tsx`)。
  - 全仓检索 (`git grep "useToast\|ToastProvider\|OfflineBanner\|Tooltip\|SkeletonText" -- apps/web/src`) 显示：**这 5 个核心反馈组件在业务页面中的实际调用次数为 0**，`App.tsx` 甚至未挂载 `<ToastProvider>`。
  - 目前各页面的操作成功反馈要么没有（如接受计划、导出审计包、启停实例），要么在表单底部塞入一行 `<p role="status">Project saved.</p>` (`SettingsPage.tsx:81`)。
- **影响**：用户执行关键写操作（保存设置、创建任务、生成/复制配对码、导出证据、审批通过）时缺少统一、非阻塞的视觉确认；图标按钮缺少统一的 `<Tooltip>` 辅助说明。
- **优化建议**：
  1. 在 `apps/web/src/app/App.tsx` 顶层挂载 `<ToastProvider>`。
  2. 在项目保存、配对码复制、任务创建、审批提交、审计包导出成功等场景接入 `useToast().push({ tone: "success", message: ... })`（同时保留现有的 `role="status"` DOM 文本或让 Toast 承载无障碍播报，确保现有测试断言完全兼容）。
  3. 按实际反馈缺口选择原语，避免重复播报。现有 `ConnectionStatus` 已承担连接状态、待发命令和重试提示，不能为启用闲置 `OfflineBanner` 而丢掉这些行为；Tooltip 也不能替代按钮可访问名称。
- **优先级 / 规模**：P2 · S

### U3. 优化顶部常驻 `ConnectionStatus` 横幅，消除正常态下的空间浪费与视觉噪音
- **代码证据**：
  - `apps/web/src/app/AppRoutes.tsx:59` 在 `<ProductHeader>` 下方无条件渲染 `<ConnectionStatus />`。
  - `apps/web/src/components/ConnectionStatus.tsx:33-36` 与 `apps/web/src/ui/product-shell.css:87` 使该组件即使在网络完全正常、无待发队列（显示 `"Live updates connected"`）时，也永久占据整个主内容区顶部一整行（高度 25px + 底部边框）。
- **影响**：纵向屏幕空间被常驻横幅压缩，且用户视线在顶部 Header、ConnectionStatus 横幅、页面 Header 三层水平条之间产生割裂感。
- **优化建议**：
  1. 当 `online === true && status === "connected" && pending === 0 && !preparedPolling`（完全健康状态）时，将连接状态收拢为 `ProductHeader` 右侧的一个紧凑绿点指示器（悬停显示 `"Live updates connected"`）。
  2. 仅当离线 (`!online`)、重连中 (`status !== "connected"`)、处于 `preparedPolling` 模式或存在待重放离线队列 (`pending > 0`) 时，才展开顶部横幅告警（保持 `role="status"` 与 `aria-label="Connection status"` 可访问性契约不变）。
- **优先级 / 规模**：P2 · S

### U4. 统一加载占位，减少页面切换时的布局跳动
- **代码证据**：
  - `WorkspaceLayout.tsx`、`BoardView.tsx`、`InventoryPages.tsx`、`RoomConversation.tsx`、`TaskDetailPanel.tsx` 已实现贴合最终布局的 `<Skeleton>` 占位。
  - 但核心页面 `GoalsPage.tsx:48,135,146`、`ReleasePage.tsx:19,52`、`AgentHistoryPage.tsx:73,81`、`SettingsPage.tsx:48,60` 以及 `AppRoutes.tsx:62` 的 `<Suspense fallback={<div ...>Loading…</div>}>` 仍仅渲染纯文本 `"Loading…"`。
- **影响**：文本占位与最终布局差距较大，存在页面切换时视觉跳动的可能；实际体验及 CLS 指标需在运行中的界面测量。
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
  2. 将该 `<Badge>` 改造为可交互按钮，依据审批单的 `task_id` 筛选并跳转。不能只筛 `awaiting_approval` / `blocked`：`approval-service.ts:requestExecutionApproval` 允许 `ready` 任务在执行前等待审批。
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

### P1. 批量读取 Presence 数据，并在 SQL 层过滤历史 Run
- **代码证据**：
  - `apps/server/src/services/presence-service.ts:375-394` 的 `listAgentInstancePresence` 先查出组织内所有 `agentInstances`，随后在 `for (const inst of insts)` 循环中串行调用 `instanceFacts(ctx, inst, isLive)`（第 309–352 行）。
  - 每次 `instanceFacts` 内部执行 **4 次独立数据库查询**：查 `agentRuntimes`、查 `computers`、查 `devices`、调用 `activeRunsForInstance`。当组织有 $N$ 个 Agent 实例时，单次请求触发 **$1 + 4N$ 次 SQL 查询**。
  - 更严重的是，第 297–307 行的 `activeRunsForInstance` 与第 409–415 行的 `computerFacts` 在查询 `runs` 表时**未在 SQL `WHERE` 子句中过滤运行状态**，而是把该实例/机器自创建以来的**所有历史 Run 记录**全量拉回 Node.js 内存，再执行 `rows.filter((r) => isActiveRunStatus(r.runStatus))`！
   - 同理，`listComputerPresence`（第 447–459 行）对每台机器循环调用 `computerFacts`（每次 3 条 SQL，并读取该组织内该机器的全部历史 `runs`）。
- **影响**：请求会读取所选组织内各实例/机器的全部历史 Run，并产生随实例数量增长的串行 DB 往返。N+1 和历史行传输可由源码确认；是否发生物理全表扫描、是否为最大瓶颈及实际收益，需用查询计划和测量验证，不能等同于无组织过滤地读取整张表。
- **优化建议**：
  1. 在 SQL 层保留 `packages/domain/src/presence.ts:isActiveRunStatus` 的语义，即排除 `completed`、`failed`、`cancelled`。当前非终态为 `queued`、`starting`、`running`、`awaiting_input`、`paused`；`awaiting_approval` 属于 Task 状态，不能放入 Run 状态过滤。新增状态时也须保持一致。
  2. 将 `listAgentInstancePresence` 与 `listComputerPresence` 重构为按 `organizationId` 批量查询一次 `computers`、`devices`、`agentRuntimes` 和活跃 `runs`，在内存中按 `computerId` / `agentInstanceId` 建立 `Map` 进行 $O(1)$ 组装，将 $1 + 4N$ 次查询降至固定 **4–5 次查询**。
  3. 保留撤销设备优先级、软删除实例、Task 审批状态和 queueDepth 语义；以多组织、共享机器及所有非终态回归用例验证，并对比查询次数、返回行数、p95 延迟与内存。
- **优先级 / 规模**：P1 · M

### P2. 补齐数据库高频查询路径缺失的索引 (`messages.task_id` 与活跃 `runs` 索引)
- **代码证据**：
  - 对照 `packages/db/src/schema.ts` 与各 Service 的 SQL 查询条件：
    1. **`messages` 表缺少 `task_id` 索引**：`audit-service.ts:getTaskAuditBundle` 按组织和任务过滤，再按 `(created_at, id)` 排序；当前索引主要围绕 room、thread 与客户端幂等键，缺少支撑该任务查询的索引。数据增长时存在额外扫描风险，具体执行计划待验证。
    2. **`runs` 表缺少匹配最新任务运行的排序索引**：ContextPack 按 `(organization_id, task_id)` 过滤并按 `(created_at DESC, id DESC)` 取最新一次；现有 `runs_task_status_created_idx (task_id, status, created_at)` 和 `runs_agent_history_idx (organization_id, agent_instance_id, created_at DESC, id DESC)` 不能直接等同于该查询所需的索引。
    3. **按机器/实例读取活跃运行的索引候选**：Presence 当前先读取历史运行再在内存筛选；P1 下推状态过滤后，需要结合 `(organization_id, computer_id/agent_instance_id, status)` 的实际查询形状评估索引，不能将建议中的新条件写成已存在的 SQL。
- **影响**：这些查询存在索引与条件/排序不完全匹配的风险；是否选择顺序扫描、开销增长幅度及新增索引收益，应在代表性数据量下用 `EXPLAIN (ANALYZE, BUFFERS)` 和耗时测量确认，同时评估写入与存储成本。
- **优化建议**：新增一个有序 SQL 迁移文件（如 `0061_*.sql`）并同步更新 `packages/db/src/schema.ts`：
  - `messages_org_task_created_idx ON messages (organization_id, task_id, created_at, id)`
  - `runs_org_task_created_idx ON runs (organization_id, task_id, created_at DESC, id DESC)`
  - `runs_org_computer_status_idx ON runs (organization_id, computer_id, status)`
  - 结合 P1 的最终查询形状评估是否还需实例非终态索引，避免与已有 `runs_agent_history_idx` 重复堆叠索引；迁移编号须以实施时最新序列为准。
- **优先级 / 规模**：P1 · S

### P3. 优化 `audit-service.ts` 与 `context-pack-service.ts` 中的串行查询与 N+1 循环
- **代码证据**：
  - `apps/server/src/services/audit-service.ts:63-124` 的 `getTaskAuditBundle` 在校验完 `taskRow` 后，依次**串行 `await`** 了 10 条完全独立的 `SELECT` 查询（`rooms`、`messages`、`runs`、`artifacts`、`approvals`、`schedulerDecisions`、`eventLog`、`decisionRecords`、`handoffs`、`blockers`）。
  - `getGoalAuditBundle` 又逐个等待子任务审计包，查询数量随子任务数增长；包含 room 查询时，单个任务包需要 11 次读取，具体总数取决于 Goal/Task 是否有 room。
  - `apps/server/src/services/context-pack-service.ts:150-169` 在遍历任务的 `edges`（最多 100 条依赖边）时，在 `for` 循环内对每条边串行查询 `runs` 和 `artifacts`（最多 200 次查询）。
- **影响**：复杂 Goal 的审计包导出及多依赖任务的 ContextPack 构建耗时显著增加，在高延迟远程 Postgres（如云端托管库）环境下尤为明显。
- **优化建议**：
  1. 评估查询批量化及有界并发，保持组织授权、字段脱敏、确定性排序和现有读取一致性要求；结合连接池容量限制 Goal 子任务并发，不能对所有子任务无界 `Promise.all`。PGlite 和远程 Postgres 的并行收益可能不同，需要分别测量。
  2. ContextPack 必须先按任务取**最新一次 Run**（`created_at DESC, id DESC`），再判断其状态是否 `completed`，只读取该 Run 的制品。严禁先过滤 `completed` 再取最新：最新运行失败、取消或尚未完成时，不得退回旧成功 Run。保留组织/项目边界、每前置任务最多 100 条制品及截断标记，不能用全局 `LIMIT` 替代每组上限。
  3. 增补“旧成功运行 + 新失败/运行中记录”、多任务排序与制品截断回归，记录优化前后的查询次数及延迟。
- **优先级 / 规模**：P1 · M

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

### P5. 在保留重连对账与移除校验的前提下减少消息刷新请求
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
- **影响**：在需要根消息快照、且增量消息无需多页追赶时，一次刷新约需 $2 + \lceil M/100 \rceil$ 次请求；首次加载、线程视图和追赶多页的请求数不同。应按场景测量，不能把它当作每次刷新的固定值。
- **优化建议**：
  1. WS 的 `root_reply_count` 增量更新只能覆盖实际收到的事件。`RealtimeContext` 在重连成功后失效缓存，此时状态已经是 connected；若据此跳过最新根消息快照，断线期间新增的线程回复可能永久留在旧计数，因为根消息 `after` 查询不会返回旧根消息或其回复。保留首次/重连/`sync.required`/降级刷新对账，建立可验证的同步状态后再减少稳定在线期间的快照。
  2. 优先对 `messageVisibility` 做有界并发或批量接口评估，保留失败处理和重连后全部已缓存消息的移除核对；不能仅依赖在线审核事件而让漏收事件的旧内容继续显示。
  3. 覆盖断线时新增回复、消息被移除、重连后无新消息、分页与并发历史加载场景，测量每次刷新的请求数和耗时。
- **优先级 / 规模**：P2 · M

### P6. 降低 `budget-service.ts` 空闲状态下的每秒数据库扫描频率
- **代码证据**：
  - `apps/server/src/app.ts:138` 默认以 `intervalMs: 1000`（每秒 1 次）启动 `startGoalBudgetMonitor`。
  - `apps/server/src/services/budget-service.ts:146-158` 每秒执行 `SELECT id, organization_id FROM goals WHERE status = 'running'`，并对每个运行中的 Goal 开启事务执行 `SELECT ... FOR UPDATE`、查询 `tasks` 与活跃 `runs`。
- **影响**：即使系统中没有任何 `running` 状态的 Goal，服务端也会以 86,400 次/天的频率持续查询 `goals` 表；在使用远程 Serverless Postgres（如 Neon / Supabase）时，每秒一次的查询会阻止数据库进入自动休眠 (Scale-to-Zero)。
- **优化建议**：
  1. 为仅按 status 的扫描检查实际计划；现有 `(project_id, status)` 复合索引不能直接当作等价的 status 索引。可在初始扫描时读取预算配置，跳过没有受支持预算的 Goal；有预算的执行路径仍须在事务内重读并校验，避免依赖过期内存配置。
  2. 空闲时自适应退避，启动/恢复事件及时唤醒；存在运行中 Goal 时保留预算期限响应、调度事务检查与非重叠扫描。还需检查其他定时器及连接行为，不能仅凭该优化承诺数据库能够 Scale-to-Zero。
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
- **代码证据**：以下为当前基线中需要按职责评估的大文件示例，行数仅辅助定位，不作为全仓排名或拆分验收标准：
   1. `apps/artood/src/product-source-runtime.ts` (**2,487 行**)：包含产品源码运行时配置校验、工作区边界断言、研究修订声明、发布工作区预留、导出捕获 V1/V2 等多阶段逻辑。
  2. `apps/artood/src/node-client.ts` (**2,181 行**)：同时承担普通 Run 启停、Worktree 准备、受管 Journal 交互、验证执行、产品发布、本地应用发布、H4–H7 跨机操作客户端挂载等全部职责。
  3. `packages/db/src/schema.ts` (**1,979 行**)：将身份、任务/DAG、房间/消息、运行/事件、记忆/技能、自治研发、跨节点源码交接、恢复与清洁验证等 **60+ 张表**全部堆叠在单文件中（注意第 2 行其实已经拆分出了 `source-clean-restart-schema.js`，证明按领域拆分 Schema 完全可行）。
   4. `apps/artood/src/product-release.ts` (**1,635 行**)
   5. `apps/artood/src/verification.ts` (**1,665 行**)
  6. `apps/artood/src/process-adapter.ts` (**1,520 行**)
  7. `apps/server/src/node-binding.ts` (**1,438 行**)
  8. `apps/server/src/app.ts` (**1,232 行**)
- **影响**：职责集中可能增加理解和并行修改成本；文件行数本身不能证明 IDE 类型推导慢或运行性能差。应优先依据实际冲突、依赖边界和修改频率选择拆分对象。
- **优化建议**（严格遵循 `AGENTS.md` 安全边界与 `T7` 机械式拆分原则）：
  - **纯移动 + 原地 `re-export`**：每次仅拆分一个模块并独立提交，保持所有公开导出符号与类型签名 100% 不变。
  - **`packages/db/src/schema.ts`**：按领域拆分为 `schema/identity.ts`、`schema/work.ts`、`schema/messaging.ts`、`schema/execution.ts`、`schema/autonomous-handoff.ts`，在 `schema.ts` 中统一 `export *`。
  - **`apps/server/src/app.ts`**：
    1. 将第 146–274 行约 130 行的 `ctx.on*Queued` 节点派发绑定逻辑提取至 `apps/server/src/node-dispatch-wiring.ts`；
    2. 将仍内联在 `app.ts` 中的 Devices、Collaboration、Goals/Plans/Checkpoints、Tasks/DAG、Skills、Approvals/Leases、Memories 按稳定职责提取为独立的 `*-routes.ts`（与已拆出的 `project-routes.ts`、`channel-routes.ts`、`discussion-routes.ts` 保持一致），使 `app.ts` 聚焦装配；不以压到某个行数为目标。
- **优先级 / 规模**：P3 · L（分多个独立小 commit 推进；涉及安全边界时风险中高）

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
  1. 先机械提取 `app.ts` 的派发装配代码，再比较各阶段的授权、会话世代、回执绑定与停止确认差异；只有确认为同一不变量的部分才提炼辅助函数，不能以配置表或行数目标抹平阶段边界。
  2. 评估提取 `createPendingStopRegistry<TId>(timeoutMs)`，保留每阶段的超时语义、实际退出确认与 `close()` 清理，并先运行相关全部回归。
- **优先级 / 规模**：P3 · M

### C3. 清理散乱的 Import 语句（含文件末尾 Import 与重复模块导入）
- **代码证据**：
  - `apps/server/src/app.ts`：
    - 文件最底部第 **1232 行** 有 `import { goalSourceRecoveries, goalRecoveryValidations, goalRecoveryValidationReviews } from "@artoo/db";`。
    - 文件顶部第 4、10、45、46 行另有 4 处分开写的 `import { ... } from "@artoo/db"`，以及第 40 行和第 48 行分两次 `import { eq } from "drizzle-orm"` / `import { and } from "drizzle-orm"`。
  - `apps/server/src/node-binding.ts:1-56`：对 `@artoo/db` 分了 8 次 `import`，对 `@artoo/domain` 分了 13 次 `import`。
  - `apps/server/src/services/context-pack-service.ts:1-22`：对 `@artoo/db` 和 `@artoo/domain` 同样存在多次重复导入。
- **影响**：高频追加特性时在文件首尾直接插入 `import` 导致头部与尾部杂乱，降低了模块依赖关系的清晰度。
- **优化建议**：合并同一模块的重复 `import` 语句，将 `app.ts:1232` 的尾部导入移回文件顶部，并按“内置模块 → 外部依赖 → `@artoo/*` 工作区包 → 相对路径”统一排序。
- **优先级 / 规模**：P3 · S（低风险维护，不应先于业务正确性与产品验收）

### C4. 引入轻量级代码格式化与静态检查工具链 (Biome 或 ESLint + Prettier)
- **代码证据**：
  - 检查根目录配置文件发现，仓库目前**没有任何 `.eslintrc`、`eslint.config.*`、`biome.json` 或 `.prettierrc`**，根 `package.json` 也无 `lint` 或 `format` 脚本。
  - 由于缺少单行长度与格式化约束，代码库中出现了大量单行 500–950 字符的“压缩式”JSX/TS 代码（例如 `apps/web/src/components/GoalsPage.tsx:146` 单行 950+ 字符、`InventoryPages.tsx:132` 单行 580+ 字符、`RoomConversation.tsx:111` 单行 620+ 字符）。
- **影响**：超长单行代码在 Code Review 和 Git Diff 时极难定位具体修改点，任何一处微小的属性调整都会造成整行 800 字符的 diff 冲突。
- **优化建议**：
  1. 评估 **Biome** 或 Prettier + ESLint，选择符合现有 TypeScript/React 约定的配置（如 `lineWidth: 120`），将工具版本固定在开发依赖中。
  2. 先对新增/修改文件启用 `npx biome check --changed`（避免一次性格式化全仓造成巨型 diff 冲击 blame 历史），并在拆解组件时逐步格式化存量超长行。
- **优先级 / 规模**：P2 · S

### C5. 治理 `scripts/` 与 `docs/` 目录平铺膨胀
- **代码证据**：
  - `scripts/` 目录下共有 **136 个文件**，其中 `scripts/` 根层级直接平铺了 **61 个 `.mjs` 脚本**（大量 `ios-ui-*`、`preview-*`、`recovery-*`、`v1-*` 混杂在一起）。
  - `docs/` 包含多类设计、运维与历史文件，其中已追踪的 Markdown 为 **93 篇**；阶段性过程记录与当前指南共存。
- **影响**：新加入的开发者或 Agent 难以快速分辨哪些脚本是当前 CI 门禁的主入口、哪些文档是现行有效规范 vs 历史归档记录。
- **优化建议**：
  1. 在 `docs/` 根目录建立 `docs/INDEX.md`（文档地图），按“现行架构与契约”、“运维与发布 Runbook”、“客户端指南”、“历史里程碑归档”分类索引。
  2. 在不破坏 `package.json` 与 `.github/workflows/*.yml` 引用路径的前提下，为 `scripts/` 建立清晰的 README 索引，后续新增脚本按 `scripts/ios/`、`scripts/gates/`、`scripts/fixtures/` 归类存放。
- **优先级 / 规模**：P3 · S

---

## 8. 工程效率、开发者体验与 CI/CD 优化机会 (DX & CI/CD)

### E1. 验证并移除 `shared-vitest` 分片中可能冗余的 Chromium 安装
- **代码证据**：
  - `.github/workflows/preview.yml:50-80` 定义了 `shared-vitest` 矩阵任务（`shard: [1, 2]`，运行在 `windows-latest` 上）。
  - 第 66–67 行在两个分片中均执行了：
    ```yaml
    - run: npx playwright install chromium
      working-directory: apps/web
    ```
  - Web Playwright E2E 与认证 E2E 由 `shared-checks` 入口执行；当前检查到的 Vitest 浏览器边界测试主要使用受控替身，但不能仅凭测试运行器名断定没有真实浏览器的间接依赖。`vitest.ci.config.mjs` 还按完整文件划分 parallel 与 windows-process 分区。
- **影响**：若两个 parallel 分片确实不依赖浏览器安装，可减少安装耗时与网络传输；具体节省量尚未测量。
- **优化建议**：在无 Playwright 浏览器缓存的 Windows 环境验证两个实际分片及文件覆盖聚合，再删除确认冗余的安装步骤。保留 `shared-checks`、iOS、Mac/Windows 桌面中真实需要浏览器的步骤，不跳过原有用例或改变分区来使其通过。
- **优先级 / 规模**：P2 · S

### E2. 支持本地 iOS 多 suite 子集，并测量 CI 的实际瓶颈
- **代码证据**：
  - `package.json` 中，`verify:ios:core`、`verify:ios:assistant`、`verify:ios:mentions`、`verify:ios:correction`、`verify:ios:retention` 五条独立命令均有前置 `npm run build:preview && ...`，本地依次调用它们会重复构建。
  - `.github/workflows/preview.yml:131-195` 的 `ios` 任务在单台 `macos-15` Runner 上串行运行全部检查与 5 个原生 UI 套件，超时阈值高达 **180 分钟**。
  - CI 使用 `npm run verify:ios` → `preview-gate.mjs --suite=ios`，其中 `build:preview` 只执行一次；随后 `ios-ui-suites-e2e.mjs` 默认运行 all，并在循环前统一执行 XcodeGen。不能把本地五条命令的重复构建推断为 CI 当前行为。
- **影响**：本地调试多个指定子套件可以减少重复构建；180 分钟是超时上限，不是实际耗时证据，CI 是否应并行需先测量构建、Simulator 启动、套件执行及清理各阶段。
- **优化建议**：
  1. 在现有单 suite / all 契约上增加多个 suite 子集，明确由外层入口构建一次、聚合器统一生成工程；验证选择、去重、非法参数和完整结果聚合。
  2. 有计时依据后再评估矩阵并行；保持每套件独立夹具、超时/清理与证据目录，并验证跨 Runner 的构建产物、工具链和原始源码指纹一致，不能直接绕过 `verifyUISuiteResults`。
- **优先级 / 规模**：P2 · M

### E3. 优化 Vitest 本地开发反馈速度（区分纯单元测试与 PGlite 重型集成测试）
- **代码证据**：
  - `vitest.config.ts:25-35` 将所有 `{apps,packages}/**/*.test.{ts,tsx}` 放在同一个默认池中运行，因 PGlite (WASM Postgres) 初始化开销较大，全局设置了 `testTimeout: 30000` 并要求 `--maxWorkers=2`。
- **影响**：开发者在修改纯函数模块（如 `packages/domain`、`packages/protocol` 或 `apps/web` 组件）时，运行 `npm test` 仍需等待数百个 PGlite 数据库实例启停。
- **优化建议**：在根 `package.json` 中补充快捷脚本（如 `test:unit` 指向 `packages/domain`、`packages/protocol`、`apps/web` 等无 DB 测试，`test:server` 指向服务端测试），保留 `npm test` 的全量语义不变，提升日常 TDD 循环速度。
- **优先级 / 规模**：P3 · S

### E4. 补齐真实 Provider 端到端验收与发布/恢复证据（交付前置）

- **已有证据与缺口**：`docs/agent-team-development.md` 的 “Validation and unfinished acceptance” 及顶部增量记录区分了受控夹具、真实进程验证和失败的 Provider 尝试；当前仍需可重复的完整产品验收。工作区交付、Artoo 自身 CI 或 publisher 站点均不构成目标产品发布成功证据。
- **优化建议**：
  1. 先整理现有失败记录、尚未通过的集成/客户端检查和目标能力范围，冻结待验收提交、构建、节点本地 Profile 与工具链指纹。将已通过、失败、未运行和平台条件跳过分别记录。
  2. 在操作者已授权的 Provider/数据共享、发布环境及凭据就绪后，按既有 runbook 执行从空仓库、规划、独立评审、节点验证到实际发布端点的完整流程，并验证承诺范围内的失败/重启恢复；若依赖尚未就绪，明确记录阻碍，不以 mock 或缩减验收标准替代。
  3. 发布前具备独立的已验证执行器、不可变输入版本、健康标准和恢复方案；记录真实退出/关闭、证据绑定、清理结果及未覆盖能力。涉及生产或不可逆数据变更时另按授权与备份/恢复要求执行，更新本文不代表已获得这些执行授权。
- **验收标准**：可复现运行记录和独立证据支持所声称的产品能力，失败与范围限制完整保留；不能仅凭模型回答、CLI exit 或 fixture 成功宣称验收通过。
- **优先级 / 规模**：P1 · L（交付前置，依赖环境与授权；不要求为其他独立优化等待外部条件）

---

## 9. 分阶段持续优化路线图与 ROI 矩阵

以下优先级是结合正确性、交付依赖和实施成本给出的建议，不是已测得的 ROI。**P0 保留给已确认的阻断性事故或发布阻断；当前静态证据不足以把 P1/P2/E1 直接定为 P0。** 大文件和 import 整理低于业务正确性及验收缺口。F1 已完成，不参与待办排序。

### 9.1 汇总优先级矩阵

| 编号 | 类别 | 优化事项 | 核心文件定位 | 收益 (Impact) | 规模 | 风险 | 优先级 |
| --- | --- | --- | --- | --- | :---: | :---: | :---: |
| **E4** | 产品验收 | 冻结版本并完成真实 Provider 产品端到端验收、发布与恢复证据 | `docs/agent-team-development.md`、既有 runbook | 高（验证交付承诺） | L | 高 | **P1** |
| **P4** | 性能 / 正确性 | 补齐 Goal 缓存失效，再评估固定轮询退避 | `GoalsPage.tsx`, `ReleasePage.tsx`, `invalidation.ts` | 中高（状态及时性与请求减少） | S | 低 | **P1** |
| **X2** | 交互 / 正确性 | 审批计数按项目隔离，依据真实审批单跳转 | `LeftRail.tsx`, `approval-service.ts` | 中高（消除跨项目误导） | S | 低 | **P1** |
| **P1** | 性能 (Server) | 批量读取 Presence 并保留全部非终态语义 | `presence-service.ts`, `domain/src/presence.ts` | 中高（查询次数与历史行传输减少，延迟待测） | M | 中 | **P1** |
| **P2** | 性能 (DB) | 按查询计划补齐消息/运行索引 | `packages/db/src/schema.ts`, 新迁移 | 待测（取决于数据与计划） | S | 中 | **P1** |
| **P3** | 性能 (Server) | 有界并发审计读取，批量获取最新 Run 及其制品 | `audit-service.ts`, `context-pack-service.ts` | 中高（查询往返减少，延迟待测） | M | 中 | **P1** |
| **X1** | 交互 (UX) | 明确 Workspace / Board 导航及激活态 | `ProductHeader.tsx`, `Nav.tsx` | 中（导航一致性） | S | 低 | **P1** |
| **F2** | 功能 (Budget) | 定义可信计量、未知费用与超额策略后实现成本预算 | `budget-policy.ts`, `run-service.ts`, `budget-service.ts` | 中高（前提满足后提供预算能力） | L | 中高 | **P2** |
| **P5** | 性能 / 同步 | 保留重连对账与移除核对，减少消息请求 | `RoomConversation.tsx`, `RealtimeContext.tsx` | 待测（活跃房间请求数） | M | 中 | **P2** |
| **E1** | CI/CD | 无浏览器缓存验证分片后移除冗余安装 | `.github/workflows/preview.yml`, `vitest.ci.config.mjs` | 待测（安装耗时与流量） | S | 低 | **P2** |
| **U2** | UI 系统 | 按反馈缺口接入 Toast / Tooltip，保留无障碍与队列反馈 | `App.tsx`, `ui/feedback.tsx` | 中（反馈一致性） | S | 低 | **P2** |
| **U3** | UI 系统 | 正常连接态紧凑展示，异常/待发队列保留横幅 | `ConnectionStatus.tsx`, `ui/product-shell.css` | 中（空间与信息层级） | S | 低 | **P2** |
| **U1** | UI 系统 | 分批收敛 CSS 级联与全局选择器 | `styles.css`, `ui/*.css` | 中（维护性，视觉收益待实测） | M | 中 | **P2** |
| **U4** | UI 系统 | 为 `GoalsPage`、`ReleasePage`、`AgentHistoryPage` 补齐 `<Skeleton>` 占位 | `apps/web/src/components/GoalsPage.tsx`, `ReleasePage.tsx`, `AgentHistoryPage.tsx` | 中（布局稳定性，实际指标待测） | S | 低 | **P2** |
| **X3** | 交互 (UX) | 增强 `PlanForm`：支持任意位置任务删除/重排与 `localStorage` 草稿持久化 | `apps/web/src/components/GoalsPage.tsx:259-277` | 中（大幅改善手动编写多任务计划的体验） | M | 低 | **P2** |
| **X4** | 交互 (UX) | 为 `MessageComposer` 增加输入 `@` 时的内联成员自动补全浮层 | `apps/web/src/components/RoomConversation.tsx:301-320` | 中（对齐现代 IM 的 `@mention` 交互直觉） | M | 低 | **P2** |
| **P6** | 性能 (Server) | 空闲预算监视退避，保留期限响应与事务检查 | `budget-service.ts` | 中（减少空闲查询，休眠能力待测） | S | 中 | **P2** |
| **P7** | 性能 (iOS) | 消除 `ArtooApp.swift` 中通知计数的双重 JSON 编解码 | `apps/ios/Sources/App/ArtooApp.swift:191-193` | 中低（提升代码整洁度与解码效率） | S | 极低 | **P2** |
| **C4** | 工程工具 | 引入 Biome / Prettier + ESLint 并逐步治理 500+ 字符的超长单行代码 | `package.json`, `apps/web/src/components/*` | 中（大幅提升 Git Diff 可读性与代码规范性） | S | 低 | **P2** |
| **E2** | CI/CD | 本地多 suite 子集，按计时评估 CI 并行化 | `ios-ui-suites-e2e.mjs`, `preview-gate.mjs` | 待测（本地重复构建与 CI 瓶颈） | M | 中 | **P2** |
| **F3** | 功能 (iOS) | Release 管控、Agent History 与现有 Goals 入口优化 | `WorkspaceViews.swift`, `ArtooApp.swift` | 中（补齐明确的客户端差距） | L | 中 | **P2** |
| **F4** | 功能 (Search) | 设计服务端搜索、分页及可见性契约 | 消息/任务/记忆服务、新迁移 | 中（历史检索与规模演进） | M | 中 | **P2** |
| **C1** | 架构解耦 | 按实际职责与冲突机械拆分模块 | `app.ts`, `schema.ts`, `apps/artood/src/*` | 中（维护性，依赖实际痛点） | L | 中高 | **P3** |
| **C2** | 架构解耦 | 核对阶段差异后提取共用装配与停止管理 | `app.ts`, `node-binding.ts`, `services/imported-*` | 中（减少已确认的重复） | M | 中高 | **P3** |
| **C3** | 代码整洁 | 合并重复导入并整理位置 | `app.ts`, `node-binding.ts`, `context-pack-service.ts` | 低（可读性） | S | 低 | **P3** |
| **E3** | 开发效率 | 增加聚焦单元/服务端测试入口，保留全量门禁 | `package.json`, `vitest.config.ts` | 中（缩短本地反馈） | S | 低 | **P3** |
| **X5** | 交互 (UX) | 引入全局命令面板 (`Cmd/Ctrl + K`) 支持跨项目/任务/频道快速跳转 | `apps/web/src/components/*` | 中（提升高频用户与管理员操作效率） | M | 低 | **P3** |
| **F5** | 功能 (Security) | 兼容的审计签名契约、密钥生命周期与验签 | `audit-service.ts`, domain 审计契约 | 中低（可验证的签发来源与完整性） | M | 中 | **P3** |
| **C5** | 仓库整洁 | 建立 `docs/INDEX.md` 文档地图与 `scripts/` 分类索引 | `docs/`, `scripts/` | 中低（降低新成员与 Agent 的上下文检索成本） | S | 极低 | **P3** |

### 9.2 推荐执行路径

1. **先处理正确性和验收依赖**：推进 **P4、X2**，修复缓存失效与跨项目审批计数；按 **E4** 整理已有失败、确认环境/授权并冻结验收版本。外部条件未就绪时记录阻碍，继续独立任务。
2. **再做有数据支撑的性能优化**：为 **P1、P2、P3** 记录查询次数、代表性数据量、查询计划和耗时；保持原有状态、最新 Run、组织隔离与制品截断语义后实施。**E1** 经无缓存分片验证后可作为独立小改动；**P5、P6** 先证明同步/预算时效不退化。
3. **按实际使用改进客户端体验**：推进 **X1、U2–U4、X3、X4、F3、F4**；复用已有 iOS Goals 能力，新增持久化草稿需区分账号/组织/服务端作用域并处理退出清理。**U1、C4、E2** 随相关模块调整和测量推进。
4. **在契约明确后扩展能力，再做维护性整理**：**F2、F5** 先评审计费/签名契约和故障语义；**C1–C3、C5、E3、X5、P7** 按实际痛点实施，不以行数或格式整理替代产品验收。能力或发布版本发生变化后，重新绑定并执行相应验收。

每项保持独立、可审阅的提交；先运行相关回归，再按 `AGENTS.md` 完成集成后的必要检查。本文不继承旧 backlog 中“只跑聚焦检查”的概括性限制。文档修订本身不改变实现或验收状态，也不授权生产发布。

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
