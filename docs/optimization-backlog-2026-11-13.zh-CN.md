# 优化待办清单(按 commit 拆分)

生成日期:2026-11-13。基线:`main` @ `268b8ce`。来源:对 UI、性能、功能、流程的静态扫描(未运行应用)。

本文档面向任何接手的 agent(Claude Code、Gemini、GPT 均可)或工程师。每个任务对应**一个 commit**,按 ROI 从高到低排序,自上而下执行。

## 工作约定

1. 先 `git pull origin main`,再开始。每个任务一个 commit,直接合入 `main` 并 `git push origin main`。不要把多个任务合并成一个 commit。
2. 提交信息格式:`<type>(<scope>): <summary>`,例如 `perf(web): ...`、`refactor(artood): ...`。
3. 由 AI 协作完成的 commit,在提交信息末尾加署名行:
   - Claude:`Co-Authored-By: Claude <noreply@anthropic.com>`
   - 其他模型使用各自的署名,不要冒用。
4. 校验只跑**与改动相关的聚焦检查**,不要做全量检查:
   - Web 类型检查:`npx tsc -b apps/web`
   - 聚焦测试:`npx vitest run <相关测试文件>`
5. 遵守仓库 `AGENTS.md`:
   - 数据库改动必须新增有序的 SQL migration,并同步更新 schema,不得修改已发布的 migration。
   - 协议和 context 的扩展只能新增可选的、带版本的字段。
   - 不得削弱 `run.verification`、验证 profile、fail-closed 等安全约束。
6. 完成一个任务后,把本文的复选框改成 `[x]`,并在同一个 commit 里提交这个改动,同时填写 commit hash。
7. 固定 fixture 或 mock 测试通过,不等于真实 provider、签名分发或生产部署的证据。需要时,请分开记录它们。

## 已完成

- [x] T0-1 `perf(web): lazy-load low-frequency route pages`(`3c790f2`)。`AppRoutes.tsx` 中的 Settings、Release、Memory、RunsAudit、Inventory、AgentHistory 改为 `React.lazy`。
- [x] T0-2 `perf(web): back off polling while realtime WS is connected`(`57a974b`)。新增 `usePollMs`(位于 `app/RealtimeContext.tsx`),应用到 GoalOverview、ChannelsPage、GoalDiscussion、AssistantTurns、CollaborationPanel、ContentManagement、useGoalContext。WS 连接时,轮询间隔放大 6 倍。
- [x] T0-3 `feat(web): contain route render failures with an error boundary`(`41e326b`)。新增 `components/RouteErrorBoundary.tsx`,包住路由区域。

> 更正:早先扫描曾认为 `prefers-reduced-motion` 覆盖不足。实际上 `ui/base.css` 已有全局规则,无需处理。

---

## 待办(按优先级)

### [x] T1 `perf(web): extend WS-aware polling to remaining fixed intervals` (`a832f89`)
- **ROI**:高。改动小,可直接减少后台请求量。
- **背景**:仍有固定间隔的轮询未使用 `usePollMs`:
  - `components/InventoryPages.tsx`(约第 53 行,daemons,5s)
  - `app/useProject.ts`(约第 10 行,goal_entry 时 5s)
  - `components/ContentReporting.tsx`(约第 29 行)
  - `components/GoalDiscussion.tsx` 之外同类的零散查询
- **做法**:对适合改动的查询改用 `usePollMs(base)`。`usePollMs` 的定义在 `app/RealtimeContext.tsx`。
- **不要改**:
  - `ConnectNodeDialog.tsx`:配对流程需要 2s 的实时反馈。
  - `DesktopSetup.tsx`:轮询的是本地 bridge,不是服务端。
  - `DaemonBadge.tsx`:它用 `dataUpdateCount` 做快照比对和在线状态判断,改动前先读懂其逻辑和测试。
- **验收**:
  - `npx tsc -b apps/web` 通过。
  - `npx vitest run apps/web/src/components/InventoryPages.test.tsx` 通过。
  - 只改间隔,不改任何 query key 或数据形状。

### [x] T2 `perf(web): share a single daemons query across components` (`060d394`)
- **ROI**:高。
- **背景**:`queryKeys.daemons` 被 `DaemonBadge`、`InventoryPages`、`ConnectNodeDialog` 各自注册了 `refetchInterval`。TanStack Query 会共用同一个缓存,但每个观察者的轮询定时器是独立的。
- **做法**:抽一个 `useDaemons({ intervalMs, enabled })` hook(放在 `app/` 下)。统一 `queryFn`、`retry`、`refetchOnMount` 等选项,让各处调用同一个 hook。
- **验收**:
  - 行为不变:`DaemonBadge.test.tsx`、`InventoryPages.test.tsx`、`ConnectNodeDialog.test.tsx` 通过。
  - 不改变 `DaemonBadge` 的快照判断语义。

### [x] T3 `perf(web): memoize list rows for tasks, messages and run timeline` (`e516fac`)
- **ROI**:中高。
- **背景**:`TaskList`、`MessageCard`、`RunTimeline` 在数据量大时,每次 WS 事件都会引发整列重渲染。全仓库的 `memo`、`useMemo`、`useCallback` 总共只有约 14 处。
- **做法**:
  1. 先阅读 `components/TaskList.tsx`、`MessageCard.tsx`、`RunTimeline.tsx`,确认列表项的 props 是否稳定。
  2. 给 `MessageCard` 和任务行加 `React.memo`。
  3. 对传入的回调(`onOpenThread`、`onReport`、`onPlan`)在父组件中用 `useCallback` 稳定引用。
  4. 先用 React Profiler 或简单的渲染计数验证有收益,再提交。没有收益就不要提交。
- **验收**:`MessageCard.test.tsx`、`TaskList.test.tsx`、`RunTimeline.test.tsx` 通过。

### [x] T4 `perf(web): paginate or virtualize long timelines` (`6546006`)
- **ROI**:中。依赖 T3 的结论。
- **背景**:仓库里没有任何虚拟化或窗口化实现。
- **做法**:
  1. 先确认消息流是否已经分页。仓库有 `apps/server/src/message-pagination.test.ts`,说明服务端消息接口已分页,web 端多半已经使用 `useInfiniteQuery`。
  2. 重点检查 `RunTimeline` 和 `TaskList` 是否一次性渲染全部数据。
  3. 如果真的会出现几百条以上,引入"显示更多"按钮(最小方案),不要为了虚拟化引入新依赖,除非有数据支撑。
- **验收**:渲染节点数有上限,现有测试通过。

### [x] T5 `perf(server): audit list endpoints for pagination and indexes` (`3b8c239`, `626ebba`)
- **ROI**:中,需要先调查。
- **背景**:`apps/server/src/*routes.ts` 里只有 `notifications` 和 `moderation` 两类接口明确支持 `limit` 或 `before`。schema 有较多表(`packages/db/src/schema.ts`)。
- **做法(分两步,各一个 commit)**:
  1. **调查**:列出所有返回数组的 `GET` 接口(tasks、runs、goals、agents、audit 相关),在文档末尾的"调查记录"里写明各接口是否有上限、对应表是否有支撑过滤和排序的索引。这一步只产出文档,不改代码。
  2. **修复**:只对确认会无限增长的接口,新增向后兼容的可选 `limit`/`before` 参数,默认行为保持不变。需要索引时,新增有序的 SQL migration,并同步 `schema.ts`。
- **约束**:不得改变现有响应的字段含义。新增分页字段必须是可选的。
- **验收**:对应的 `apps/server/src/*.test.ts` 通过。

### [x] T6 `refactor(web): fold ad-hoc page CSS into modular ui/*.css` (`f611f9e`)
- **ROI**:低中。
- **背景**:`apps/web/src/styles.css` 约 1329 行,同时存在 `ui/*.css` 模块化样式,两者有重叠。
- **做法**:每次只迁移一块(例如与 `ChannelsPage` 相关的规则)到对应的 `ui/*.css`,保持选择器和特异性不变。每迁移一块提交一次。
- **验收**:`npx tsc -b apps/web` 通过;Playwright 截图或人工检查对应页面无视觉变化。

### [x] T7 `refactor(artood): split oversized modules by responsibility` (`ca224f0`)
- **ROI**:低中(维护性)。风险较高,必须在已有测试保护下进行。
- **候选文件**(行数为扫描时的近似值):
  - `apps/artood/src/product-source-runtime.ts`(约 2435 行)
  - `apps/artood/src/node-client.ts`(约 2229 行)
  - `apps/artood/src/product-release.ts`(约 1629 行)
  - `apps/artood/src/verification.ts`(约 1618 行)
  - `apps/artood/src/process-adapter.ts`(约 1461 行)
  - `apps/server/src/node-binding.ts`(约 1417 行)
  - `apps/server/src/app.ts`(约 1142 行)
  - `packages/db/src/schema.ts`(约 1890 行)
- **做法**:
  - 每个文件一个 commit。
  - 只做**纯移动**(提取函数或类型到同目录新文件,并在原文件 re-export),不改变逻辑。
  - `verification.ts`、`process-adapter.ts` 和 `node-binding.ts` 涉及安全边界(验证命令绑定、进程退出确认、fail-closed),**只允许机械式拆分**,并要求先跑该模块对应的全部测试。
  - `schema.ts` 拆分不得改变导出名称和迁移结果。
- **验收**:该模块对应的测试文件全部通过;`npm run typecheck` 通过。

### [x] T8 `chore(web): introduce i18n scaffolding`
- **ROI**:低,但越晚越贵。**开始前先和产品负责人确认是否需要多语言。**
- **做法**:先只做脚手架(轻量的字典加 `t()`),迁移一个页面作为样板。不要一次迁移全部文案。
- **验收**:默认语言行为不变;现有测试的文案断言通过。

### T9 `docs/test: fix the dag evidence TODO`
- **ROI**:低。
- **背景**:`packages/domain/src/dag.ts` 约第 89 行有一处 TODO,与 artifact、contract、review 的证据判定(`gatingNeedsEvidence`)有关。
- **做法**:先读懂语义。这涉及自动评审的授权边界,改动前先对照 `AGENTS.md` 的"Autonomous development"一节。不确定时,只补充测试或文档,不改行为。

### T10 流程类:真实 provider 验收(非代码任务)
- **ROI**:高,但需要人来决策和提供凭据。
- **背景**:`AGENTS.md` 明确指出,fixture 验证不等于真实 provider 验收,已验证的工作区交付不等于产品发布。
- **做法**:参考 `docs/agent-team-development.md` 里的剩余工作和现有 runbook,安排一次真实 provider 的端到端验收,并把结果单独记录。agent 不应自行使用或伪造凭据。

---

## 调查记录(由执行 T5 的人填写)

| 接口 | 是否分页或有上限 | 相关索引 | 结论 |
| --- | --- | --- | --- |
| `GET /api/v1/rooms/:id/messages` | 已分页 (`limit`, `before`, `after`, `thread_root_id`) | `messages_room_position_idx (room_id, position)`、`messages_thread_position_idx (thread_root_id, position)` | 已完备，无需改动 |
| `GET /api/v1/notifications` | 已分页 (`limit`, `before`) | `notifications_user_created_idx (organization_id, user_id, created_at, id)` | 已完备，无需改动 |
| `GET /api/v1/agents/:id/history` 及 `:runId` | 已分页 (`limit`, `before`) | `runs_agent_history_idx (organization_id, agent_instance_id, created_at DESC, id DESC)`、`event_log_run_history_idx` | 已完备，无需改动 |
| `GET /api/v1/moderation/reports` 及 `/my-reports` | 已分页 (`before`) | `content_reports_queue_idx`、`content_reports_reporter_message_idx` | 已完备，无需改动 |
| `GET /api/v1/memories/context` | 有上限 (`limit`) | `memories_org_status_idx (organization_id, status)`、`memories_project_scope_idx` | 已完备，无需改动 |
| `GET /api/v1/goals/:id/plans`、`/checkpoints`、`/discussions` | 单 Goal 作用域内数量有限 | `plans_goal_idx`、`checkpoints_goal_idx (goal_id, created_at)`、`discussions_goal_idx` | 已有复合索引，单 Goal 下规模受控 |
| `GET /api/v1/rooms/:roomId/decisions`、`/handoffs`、`/blockers` | 单 Room 作用域 | `decision_records_room_idx`、`handoffs_room_idx`、`blockers_room_idx` | 已有 `room_id` 索引 |
| `GET /api/v1/tasks?project_id=<id>` | 无 `limit` 参数 | 仅有 `tasks_project_status_updated_idx (project_id, status, updated_at)`，缺少按 `(organization_id, project_id, created_at, id)` 排序的覆盖索引 | **T5-2 修复**：增加可选 `limit` 参数，并新增 `tasks_org_project_created_idx` 索引 |
| `GET /api/v1/goals` | 无 `limit` 参数 | 仅有 `goals_project_status_idx (project_id, status)`，缺少 `(organization_id, created_at)` 排序索引 | **T5-2 修复**：增加可选 `limit` 参数，并新增 `goals_org_created_idx` 索引 |
| `GET /api/v1/approvals` | 无 `limit` 参数 | 仅有 `approvals_status_expires_idx (status, expires_at)`，缺少 `organization_id` 前缀及 `created_at` 排序索引 | **T5-2 修复**：增加可选 `limit` 参数，并新增 `approvals_org_status_created_idx` 索引 |
| `GET /api/v1/memories` | 无 `limit` 参数 | 已有 `memories_org_status_idx`、`memories_updated_idx` | **T5-2 修复**：增加可选 `limit` 参数 |

