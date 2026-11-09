# Web 与 Windows daemon 收敛记录（2026-11-09）

本轮以现有 Web 控制面和 Windows npm daemon 为交付范围：整合已实现的开发分支，完成相应检查，发布 Windows npm daemon，并给出 Web 部署方案。iOS、macOS 客户端新功能不属于本轮开发范围；现有 CI 门禁保留。八类需求并未全部完成，下面区分已有功能与后续缺口。

本文的“完成”仅指列明的实现子项已有 Web/API 链路；“部分”表示该类需求还有明确缺口；“缺失”表示未发现相应管理界面或服务端能力。源码盘点不能替代安装、公网部署、真实模型或实体多电脑验收。

## 八类功能现状

| 类别 | 状态 | 已完成的实现子项与证据 | 部分或缺失项 |
| --- | --- | --- | --- |
| 电脑管理 | 部分 | [Computers 页](../apps/web/src/components/InventoryPages.tsx) 展示电脑、在线状态、runtime/CLI、版本和能力；[Settings](../apps/web/src/components/SettingsPage.tsx) 支持生成配对码、管理员登记电脑、撤销设备；[设备与运行时接口](../apps/server/src/app.ts) 提供 pairing、claim、enroll、presence、runtimes。 | 没有通用电脑配置编辑面板。daemon 需依照安装文档完成本机环境配置；电脑显示在线不等于模型已认证或全部能力合格。 |
| Agent 管理 | 部分 | [注册与启停](../apps/web/src/components/InventorySetup.tsx) 支持显示名、已发现 runtime、workspace、声明能力；Agent 卡片显示 model/effort；[资源接口](../apps/server/src/resource-routes.ts) 验证管理员权限、已登记 runtime 和能力范围。 | 缺少 Web model/effort 档案编辑、CLI 运行配置编辑及完整 Agent 档案管理。当前 [daemon 入口](../apps/artood/src/main.ts) 的内置 runtime presets 为 Codex 与 Claude Code，不能表述为支持任意 CLI。 |
| 团队 | 部分 | [规划讨论](../apps/web/src/components/GoalDiscussion.tsx) 支持选择 2–6 个 Agent、角色、轮数和时间；[Goals](../apps/web/src/components/GoalsPage.tsx) 展示 Agent Team 的阶段职责和独立审核；[讨论接口](../apps/server/src/discussion-routes.ts) 支持启动、停止与计划提案。 | 缺少独立团队 CRUD、可复用团队模板、团队预算页及可配置并行执行界面。当前 [Agent Team 自动目标](../apps/server/src/services/goal-automation-service.ts) 使用单一并发运行预算，不能宣称任意并行团队已完成。 |
| 目标与任务 | 部分 | 已有 Goals、看板、任务详情、计划接受/拒绝、检查点；[依赖与租约](../apps/web/src/components/TaskDependencies.tsx)、[分派和重试](../apps/web/src/components/TaskActions.tsx) 有实际 API；服务端维护调度、依赖、重试预算和运行状态。 | 没有独立队列运营面板与队列顺序编辑；部分服务端调度参数没有对应 Web 配置。Agent Team 的固定预算与重试策略不等于通用调度管理已完成。 |
| 工作空间 | 部分 | 分派时可请求 isolated Git worktree；[工作保留](../apps/web/src/components/WorkspaceRetention.tsx) 显示节点报告的路径、分支和结果；Goals 可授权在预先配置的电脑间交接；[任务审核](../apps/web/src/components/ArtifactReview.tsx) 支持制品查看、接受或要求修改。 | 缺少 Web Git diff、冲突解决和 merge 工作台。[自动 workspace base 配置](../apps/web/src/components/AgentWorkspaceAllocation.tsx) 新建明确限于 Mac，不能作为 Windows 自动分配已完成的证据。跨电脑交接受配置和产品流程限制，实体多电脑全流程仍需独立验收。 |
| 预算与用量 | 部分；团队/Agent 成本控制缺失 | [RunUsageSummary](../apps/web/src/components/RunUsageSummary.tsx) 显示单次运行的 provider tokens/cost；未报告值显示 unavailable；[用量接口](../apps/server/src/services/run-service.ts) 保留 provider session 与更新时间。目标时间和重试预算有服务端执行。 | 缺少 per-agent/team 汇总、预算预警、硬成本限额与可信度分层面板。[budget-policy](../apps/server/src/services/budget-policy.ts) 明确拒绝 `max_cost_usd`，不能把未报告成本当作零或宣称费用上限已生效。 |
| 监控与审批 | 部分 | [Runs/Audit](../apps/web/src/components/RunsAuditPage.tsx)、运行时间线、输出、审计包、连接/daemon 状态与 Stop 已有；[ApprovalInbox](../apps/web/src/components/ApprovalInbox.tsx) 支持任务审批与说明，服务端执行审批门禁。 | 审批主要嵌入任务，缺少独立全局审批运营页、统一告警规则和告警投递。执行审批与本机 runtime 权限是不同边界。 |
| 账号、安全与权限 | 部分 | [认证接口](../apps/server/src/auth/auth-routes.ts) 支持 Google session/logout；[权限边界](../apps/server/src/auth/request-auth.ts) 限制管理员操作；已有设备撤销、AI 分享许可、成员停用与内容管理。 | 缺少 Web 邀请/角色编辑、项目级权限配置、MFA 和完整安全设置中心。已实现的 owner/admin/member 边界不代表完整权限管理产品。 |

## 本轮整合内容

- 以 `application-publication-executor` 的累计实现作为基线，纳入 `windows-prepared-startup` 的 prepared loader 与安装绑定修复；不覆盖现有诊断实现为旧版本。
- 采用原 #22 的 CI 分区和实际测试覆盖核对，将四个 Windows 进程相关测试整文件放在独立单 worker 作业；原断言、平台条件和超时不变。并行两个分片继续执行其余文件，聚合检查比较实际 JSON reporter 与完整 discovery，缺失、重复、重叠或 commit 不同均失败。首次整合 CI 中 `windows-browser-session-script.test.ts` 的三个 PowerShell 子进程在 10 秒限制处超时，因此将该完整文件加入已有串行分区；最终 [CI 42594544051](https://github.com/Xiejiayun/artoo/actions/runs/42594544051) 的四文件串行分区 88/88 通过，两个并行分片和实际覆盖聚合也通过。原失败证据保留；负载隔离有效不等于已证实资源争用根因。
- Computers 与 Settings 保留桌面接入，并增加 [Windows npm daemon 接入说明](web-deployment-plan.zh-CN.md)。UI 不展示未经发布验证的版本；实际启动命令是 `artood start`，配对与环境配置按文档执行，没有新增 `pair` 或 `status` 子命令。
- #19 的 trusted-profile 文件批量读属于独立性能待办，本轮不扩入；#23 的 iOS context 修改按 Web/Windows 范围不纳入。

## 验证记录与边界

| 检查 | 当前已记录结果 | 边界 |
| --- | --- | --- |
| CI 覆盖核对器 | 23/23 通过 | 受控 discovery/reporter 正反例；不代表整个产品已验收。 |
| 实际 Vitest discovery 与 reporter 覆盖 | 最终 CI 实际报告 566 文件 = 并行分片 281 + 281 + 串行分区 4；聚合核对无遗漏、重复或额外文件 | 报告包含既有 platform/opt-in skips；文件覆盖不等于每个 case 都实际执行。 |
| Windows 串行分区 | 四文件 88/88 通过，含 session-script 原四例 | session-script 源码、断言和 10 秒超时未改；不代表 npm 安装后模型、浏览器或产品发布的完整验收。 |
| CI 门禁清单与脚本 | shared/shared-checks 分别 37/36；脚本语法和 `git diff --check` 通过 | 新增覆盖核对与 npm CLI 测试，不移除现有客户端门禁。 |
| Web 接入文案回归 | InventoryPages 与 SettingsPage 两个既有套件 16/16 通过 | 无新增 API、认证流程或 runtime 能力；不替代浏览器和安装验收。 |
| 本文文档链接 | 25 个相对链接的目标文件存在 | 部署文档已随 PR #26 合入 main；不是已部署网站检查。 |
| 类型检查与工作区构建 | `npm run typecheck`、`npm run build` 通过 | 构建仍报告现有 Web 主 chunk 大于 500 KiB 的提示，未做无关性能改造。 |
| Web 浏览器流程 | 27/27 通过，使用 Windows Edge、本机隔离开发服务 | 包括任务、审批、重试、目标、配对、制品和响应式流程；测试数据不是真实模型或公网数据。 |
| 认证浏览器流程 | 6/6 通过 | 检查登录入口、OAuth 发起、受保护 API 和静态站点边界；未完成真实 Google 账号登录。 |
| npm CLI 与发行契约 | 7/7 通过；独立审查通过 | 保留未知参数拒绝、秘密脱敏、manifest 与安装内容校验。 |
| npm 压缩包独立安装 | 仓库外安装通过，177 个 runtime 文件逐个核对，CLI shim/help/version 通过 | 自带 Windows x64 native helper；无需仓库或 .NET。未证明完整 supervised 产品执行资格。 |
| 安装后的 daemon 连接 | 实际 HTTP 配对、登记、WebSocket 注册、heartbeat 落库和正常 IPC 停止通过；exit/close 均为 0、双 EOF、服务端确认断开 | 使用 fixture owner 身份，关闭开发 node token；未调用模型或模拟物理 Ctrl+C。依赖隔离探针确认 0 次祖先 addon 解析。 |
| 完整本机 Vitest | 8,432 通过、90 既有跳过；554 文件通过、12 文件跳过；原始 npm 进程 exit 0 | 运行从 `c233493` 开始，期间仅修改 CI 分区、其核对器测试和文档，产品及 Vitest 测试源码未改。 |
| 最终远程 CI | [42594544051](https://github.com/Xiejiayun/artoo/actions/runs/42594544051) 的 shared-checks、两分片、Windows 串行及 aggregate 全部通过；mac-desktop 通过；ios 失败，windows-desktop skipped，因此整体 conclusion 为 failure | workflow head 为 `9c9daaa`，实际 checkout 为 PR merge ref `2bc51e9a`。iOS 不属于本轮开发范围；早先 [42588597318](https://github.com/Xiejiayun/artoo/actions/runs/42588597318) 的 3 个超时失败原样保留。 |
| PR 合并 | [PR #26](https://github.com/Xiejiayun/artoo/pull/26) 正常 merge，commit `f11f569794bf47a4c81fc79d95a43761047f5bcc` | 没有管理员绕过或删除分支；合并不等于云部署完成。 |
| Windows native transport | control 18/18 通过；另一个重新核对输入与安装的资格窗口 input 7/7 通过，确认原进程 exit/close、双 EOF 与清理 | 首次 input 5/7 的原失败保留，worker ctime 变化来源未确认；不宣称一次 25/25，也不代表 installed-product/live-provider/多电脑产品发布验收。 |
| 生产依赖审计 | 最终 CI 的 audit 门禁通过，报告 0 vulnerabilities | 本机 Microsoft npm feed 的 HTTP 429 网络失败保留；审计结果限于所核对的版本。 |

初次分区与失败证据保留在本机 `artifacts/release-convergence/ci-partition/`、`remote-ci-42588597318/`。最终 CI 的实际 reporter、coverage 与最终 run 状态在 `remote-ci-42594544051/`；本机原始完整测试日志和退出观察器记录在同级目录。Native 首次窗口和新 input 资格窗口分别在 `native-package/WINDOW-RESULT.json` 与 `native-package/input-r2/`。这些制品不作为 npm 包内容，也不替代公网部署验收。

Web 文案组件检查保存在 `artifacts/release-convergence/web-connection-copy.log` 与 `web-connection-copy-results.json`。

## 发行与部署状态

Windows npm 包 [`@jiayunxie/artood@0.1.0-rc.1`](https://www.npmjs.com/package/@jiayunxie/artood/v/0.1.0-rc.1) 已正式发布，npm 网站确认发布成功，`next` 指向该版本。当前 `latest` 仍为 `0.0.0-stage` 占位；安装必须明确指定 `0.1.0-rc.1`，不能使用不带版本的默认安装。包的构建与安装范围见 [npm daemon README](../scripts/npm-daemon/README.md)。

[发布工作流 42608645915](https://github.com/Xiejiayun/artoo/actions/runs/42608645915) 已完成精确制品核对、网页登录、staging、会话撤销与临时配置清理；npm 网站随后批准相同 stage `c017cb69-cdfc-4d8f-b387-88e16368ebb8`。站点发布和标签证据保存在本机 `artifacts/release-convergence/npm-published-success.jpg` 与 `npm-published-tags.jpg`。

本机现有 Microsoft npm feed 查询返回 E404，官方 registry 在本机被组织网络策略阻止；这一限制仍保留。独立 [Windows 线上安装验证 42615273316](https://github.com/Xiejiayun/artoo/actions/runs/42615273316) 已通过：从官方 `https://registry.npmjs.org/` 安装同一固定版本 `0.1.0-rc.1`，包名、版本、`next`、SHA-512 integrity 和 SHA-256 均与已发布制品相符。环境为 Windows、Node 24.22.2、npm 11.19.1；9 条原始命令 exit 0、signal null，安装后的 177 个 runtime 文件共 99,035,866 字节核对通过，CLI help/version 通过。

安装后的 daemon 完成实际 HTTP 配对、登记、WebSocket 注册与 heartbeat 落库，并经正常 IPC 停止；原进程 exit/close 均为 0、双 EOF、服务端确认断开，祖先可选 addon 解析尝试为 0。该验证使用托管 Windows runner 和 fixture owner，关闭开发 node token，未调用真实模型，也未证明 native-supervisor、受保护的本地应用发布、签名分发或日常 Console 完整流程资格；不表示本机 Microsoft 镜像可用。

此验证对应 PR head `5940691`，实际 checkout 为 PR merge ref `3080bb35872059877d0d2847074df39d8134d163`；结果仅覆盖该 npm 安装与连接工作流，不概括其他预览 CI。证据保存在本机 `artifacts/release-convergence/remote-npm-verify-42615273316/result.json` 与 `daemon-result.json`。

已发布制品对应的候选压缩包 SHA-256：`65c4c81189b80465cd9c4072c80aa3fc28cdbf2bf511529548b5bd45c11f179d`，构建 source 为 `c233493eda2ee0ab2fd1734935f2da6826cf7d74`。本机 tarball 独立安装与连接证据在 `C:\artoo-builds\npm-daemon-20261109\connection-release-r2\result.json`，发行压缩包位于同级 `release-r2/`；该记录不是线上 registry 安装证据。这些构建制品不提交进源码仓库。

Web 部署采用 [Azure 单机控制服务与 Windows 执行节点方案](web-deployment-plan.zh-CN.md)，保留单个 PGlite 写入者、持久数据盘、同源 HTTPS/WSS、Google OAuth 及离线备份恢复。方案文档不是 Azure 部署结果；实际云资源、域名、生产认证、备份恢复与多电脑关键路径验收需分别记录。

## 后续工作

本轮优先把既有 Web/Windows 流程整合、验证并交付。团队模板、运行档案编辑、per-agent/team 预算中心、Windows 自动 workspace 分配以及 Git 审查合并工作台保留为明确后续需求，不以界面占位或不生效的设置冒充已实现能力。
