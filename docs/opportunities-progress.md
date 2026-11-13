# Opportunities 实施记录

依据 [opportunities.md](../opportunities.md)（2026-11-13）逐项实施。每项从 fetch 后的最新 main 创建独立分支，先回归、再合并并同步 main，下一项重新 fetch。最终集成门禁包含 typecheck、build、完整 Vitest 和 Web E2E；原生客户端与真实 Provider 验收分别记录，不能由夹具替代。

## 完成与进行中

| 编号 | 状态 | 范围与验证 |
| --- | --- | --- |
| C5 | 已建立索引并验证 | 新增 docs/INDEX.md 与 scripts/README.md，覆盖 docs 根目录全部 90 篇文档，区分现行指南、运维发布、客户端与版本化/历史记录；156 个本地链接、14 个命令引用及 preview --list 检查通过。保留现有路径和 CI/npm 调用。 |
| F5 | 已实现并验证 | 显式协商的 Ed25519 v1 Task/Goal 导出、受保护启动配置、公钥环轮换/撤销与离线验签；保留默认 v1alpha1。根 typecheck、server/Web build、125 项聚焦回归及资源夹具补强后的 HTTP/CLI 4 项通过。[格式与运维](audit-signing.md)。 |
| X5 | 已实现并验证 | 全局命令面板、单项目实体检索、键盘与项目/路由联动，复用确认表单；根 typecheck、Web build、6 文件 64 项及真实 Chromium 连续两轮 6 项通过。[范围](command-palette.md)。 |
| F1 | 已有能力，无需重复 | 方案已更正 DAG 证据门控结论，保留现有行为。 |
| P4 | 已实现并验证 | 集中查询键，补齐 Goal 相关事件失效与项目订阅；自动化和静态发布轮询在线退避。应用发布保留 5 秒轮询及本地健康时效判断。根 typecheck、Web build 通过；完整 Web 单元/组件回归 60 文件、574 项通过；新增实时事件/退避回归所在两文件 23 项通过。 |
| X2 | 已实现并验证 | 按当前项目任务 ID 关联组织级审批，徽标可筛选并打开真实任务（包含 ready 执行审批）；合并重复缓存记录，支持显示全部及审批清空状态。根 typecheck、Web build 通过；LeftRail/TaskList/WorkspaceLayout/ApprovalInbox 4 文件、15 项通过。 |
| E4 | 已发现测试安装，等待共享授权与最终验收 | [验收准备与证据要求](opportunities-acceptance-2026-11-13.md)。补查 `%USERPROFILE%/.artoo` 后找到 rc.8 安装及独立配置；当前源码 helper 生产准入和已安装 Chromium 本地页面/实际关闭预检通过。尚未读取凭据或调用 Provider；单次 45 分钟真实外部模型验收的共享授权仍待操作者回复，最终版本验收未完成。 |
| P1 | 已实现并验证 | 实例/电脑 Presence 批量查询，SQL 排除终态，保持组织/撤销/队列/状态语义。[测量](presence-performance-2026-11-13.md)：20 实例/4 电脑/1,020 Run，查询数 81→5、13→4；返回行 1,080→48、1,028→28。5 文件 52 项通过；根 typecheck、server build 通过。 |
| P2 | 已实现并验证 | 追加 0061 迁移与匹配 schema，增加任务消息/最新 Run 排序索引及共用非终态部分索引。[查询计划与成本](presence-indexes-2026-11-13.md)及可复现脚本已记录；根 typecheck、server build、10 文件 53 项回归通过。独立 Postgres 与写入吞吐未测量。 |
| P3 | 已实现并验证 | 最新 Run 批量读取、每 Run LATERAL 制品上限，Goal 审计按 20 任务批量装配；保持隔离、脱敏、排序与截断。[测量](evidence-query-batching-2026-11-13.md)：101 边交接 204→10 次查询，45 子任务审计 501→36 次。根 typecheck、server build、7 文件 27 项回归通过。 |
| X1 | 已实现并验证 | 顶部新增 Workspace 入口，根路径独立激活、面包屑明确，移除 Board 借壳高亮；窄屏导航隐藏编号并允许内部滚动。根 typecheck、Web build、2 文件 5 项组件回归及真实浏览器聚焦 E2E 通过。覆盖键盘与 320/390/1024/1180/1440px，无页面横向溢出，320/1440px 截图已人工检查。 |
| P5 | 完整实现并验证 | 可选 v1 能力协商 100→500，并新增完整 ID 覆盖的紧凑计数/移除 HTTP 对账，普通根消息刷新省正文快照；历史计划预览候选及旧服务端保留原路径。失败仍可见，已确认移除即时清理全部相关缓存，保留并发历史和较新实时计数。[契约](message-reconciliation.md)与[真实 HTTP 测量](message-reconciliation-performance-2026-11-13.md)：250 条刷新 5→3→2 请求，224KB→13.6KB；冻结版本 p50 59.52→40.25→25.35ms，尾延迟波动单列。根 typecheck、server/Web build、聚焦 5 文件 59 项及边界/实时 2 文件 12 项通过；最终真实浏览器两项通过，覆盖断连期间回复、旧分页移除、无新根和刷新。 |
| U2 | 已实现并验证 | 应用级 Toast，保存/创建/复制/审批/计划/下载/实例启停成功反馈；避免重复播报与旧提示期限重置，保留错误及队列语义。根 typecheck、Web build、完整 Web 61 文件 599 项及真实 Chromium 1 项通过；覆盖实际下载、焦点、320/1440px 与键盘关闭。[记录](ui-feedback-2026-11-13.md)。 |
| U3 | 已实现并验证 | 健康态收拢为 Header 绿点，异常/轮询/待发保留横幅；一个生命周期保留重放、离页保护和重试。真实浏览器暴露并修复 StrictMode 下 online 监听丢失，新增回归先红后绿。根 typecheck、Web build、完整 Web 63 文件 604 项及真实 Chromium 1 项通过。[记录](connection-status-2026-11-13.md)。 |
| U1 | 已分域迁移并验证 | 控件/布局基础规则按原顺序迁入 ui；零特异性排除共享表单原语，移除覆盖焦点环的旧规则。明暗/320/1440px 共 25 组 550 属性稳定采样，530 不变、20 为预期焦点变化，无额外差异；根 typecheck、Web build、4 文件 23 项及最终真实 Chromium 5 项通过。[归属](web-css-ownership.md)与[证据](web-css-validation-2026-11-13.md)。剩余业务规则按组件继续渐进迁移。 |
| U4 | 已实现并验证 | 统一首次加载骨架，沿用目标/发布响应式列；历史/设置分区独立加载，保留缓存、错误重试及空状态，不提前显示发布结论。根 typecheck、Web build、完整 Web 64 文件 610 项和真实 Chromium 3 项通过；明暗/320/1440px 栏宽及位置一致、无横向溢出。[记录](loading-states-2026-11-13.md)。未声称 CLS 收益。 |
| X3 | 已实现并验证 | 手动计划支持中间删除、双向移动及稳定依赖；草稿按服务端/组织/账号/目标隔离，退出清理，坏数据显式丢弃，旧提交不删除新编辑。根 typecheck、Web build、聚焦 4 文件 80 项、阶段完整 Web 65 文件 617 项通过；最终快照保护回归 2 文件 36 项及真实 Chromium 3 项通过。[行为与分阶段证据](plan-drafts.md)。 |
| E1 | 缓存门禁已合并，完整核验进行中 | #106 保留安装并增加独立空缓存/前后观察。实际 Windows CI 的第一分片 303 文件、4,500 项通过/23 项条件跳过，进程分区 4 文件 88 项通过，均确认缓存和 executable 前后不存在；第二分片与覆盖聚合待完成。[方法、早期失败与结果](ci-vitest-browser-validation-2026-11-13.md)。尚未删除安装步骤或宣称整个 CI 通过。 |
| E1 前置修复 | 已通过 PR #68 合并 | 损坏附件在恢复数据库启动前拒绝，有效附件仍只流式复制一次。真实大附件回归先红后绿；原四案例和附件回归共 2 文件、5 项通过，根 typecheck、server build 通过。超时清理父 harness 1 项通过，核验子进程故意 5 失败、2 通过及实际关闭和安全清理，证据单独记录。 |

P4 合并为 `172d1f0`（实现 `f59fbf9`）。远程在该次直接推送提示 PR 保护要求，后续均走普通 PR 合并；不使用 admin/bypass。每项本地验证与远程 CI 状态分别报告；CI 未结束不能视为通过。

X2 通过 [PR #61](https://github.com/Xiejiayun/artoo/pull/61) 合并为 `235133c`（实现 `e0a4750`）。

E4 的环境准备通过 [PR #62](https://github.com/Xiejiayun/artoo/pull/62) 合并为 `e61992b`。P1 通过 [PR #63](https://github.com/Xiejiayun/artoo/pull/63) 合并为 `8dfab8c`（实现 `6cd97fc`）。

P2 通过 [PR #64](https://github.com/Xiejiayun/artoo/pull/64) 合并为 `fa2deb8`（实现 `c086f08`）。

P3 通过 [PR #65](https://github.com/Xiejiayun/artoo/pull/65) 合并为 `ffbaf6d`（实现 `e4a8719`）。X1 首轮组件测试在并行构建时发生既有 Skills 懒加载查找超时；无修改断言/超时，单 worker 复跑 5 项全通过。日志：`.git/opt-x1-final-tests.log`、`.git/opt-x1-typecheck-final.log`、`.git/opt-x1-build.log`、`.git/opt-x1-e2e.log`。浏览器证据目录：`apps/web/test-results/workflows-2026-11-13T12-33-02-018Z`；该聚焦 E2E 不替代最终统一验收。


U3 通过 [PR #72](https://github.com/Xiejiayun/artoo/pull/72) 合并为 `ac9f802`（实现 `b390d6b`）。

U1 通过 [PR #73](https://github.com/Xiejiayun/artoo/pull/73) 合并为 `a2e2cf3`（实现 `9e147bc`）。

U4 通过 [PR #74](https://github.com/Xiejiayun/artoo/pull/74) 合并为 `2e35c13`（实现 `d9f7483`）。

U2 通过 [PR #71](https://github.com/Xiejiayun/artoo/pull/71) 合并为 `dd236c7`（实现 `a45bf8d`）。

P5 第二阶段通过 [PR #70](https://github.com/Xiejiayun/artoo/pull/70) 合并为 `228add7`（实现 `0edfdf7`）；E1/E4 环境与失败证据记录通过 [PR #69](https://github.com/Xiejiayun/artoo/pull/69) 合并。

X3 通过 [PR #75](https://github.com/Xiejiayun/artoo/pull/75) 合并为 `d90df1b`（实现 `3a2b888`）。

X4 已实现内联成员提及，保留显式通知复选框和原发送/草稿/未确认重试身份；方向键、Enter、Escape、IME、长度限制及同名成员可用。根 typecheck、Web build、完整 Web 66 文件 625 项、最后聚焦 2 文件 34 项及最终 Chromium 3 项通过，含大字体与短屏多行输入回归。[行为与证据](inline-mentions.md)。

X4 通过 [PR #76](https://github.com/Xiejiayun/artoo/pull/76) 合并为 `46c28b1`（实现 `7f1f37a`）。合并时远程 CI 仍在运行，本地结果不代表其已通过。

P6 已实现预算监视空闲退避（上限 30 秒）、提交后启动/恢复唤醒和无适用预算预筛选；保留事务内重读、组织边界、期限检查和关闭排空。根 typecheck/server build、预算/DAG 6 文件 40 项及最终 Goal/Plan/监视器 5 文件 30 项通过。确定性前 120 秒空闲扫描 120→7；本机查询计划和其他定时器限制单列，[记录](budget-monitor-2026-11-14.md)。不承诺数据库休眠。

P6 通过 [PR #77](https://github.com/Xiejiayun/artoo/pull/77) 合并为 `1e3ce41`（实现 `42904a7`）。

P7 已实现类型化通知分页，徽标和收件箱直接解码，保留会话/认证、分页、全收件箱未读数和未知/失败/零语义。Windows 22 个请求/53 端点静态契约与 5 个修改 Swift 文件语法检查通过。全仓 parser 的两个诊断在原始 main 同样复现；Xcode/XCTest 和原生验收未运行，仍有平台验证缺口。[记录](ios-notification-decoding-2026-11-14.md)。

P7 通过 [PR #78](https://github.com/Xiejiayun/artoo/pull/78) 合并为 `93e5bb7`（实现 `938617f`）。原生运行缺口保留。

C4 引入固定 Biome 2.6.6，按暂存/已提交差异提供格式与五条基础正确性检查，PR 工作流校验准确基线；只格式化新补全模块。根 typecheck、Web build、原输入区 2 文件 34 项回归、真实 Git 门禁 3 项及暂存 check/lint/format（各 5 文件）通过。缺失基线先由 Git 验证，避免工具本身成功空跑；无全仓格式化。[规则、命令与证据](code-quality.md)。

C4 通过 [PR #79](https://github.com/Xiejiayun/artoo/pull/79) 合并为 `b2c0f67`（实现 `caf3f8f`，证据 `92b2208`）。

E2 已实现 `verify:ios:suites -- --suites=core,mentions`：一次 preview 构建、聚合器统一生成 Xcode 工程，子进程校验 v1 源码与 pbxproj/共享 schemes 指纹后复用。保留独立夹具、逐套件 build-for-testing、准确 XCTest/结果聚合、超时、清理及证据目录。新增聚合/原生分阶段计时；Simulator 启动包含在 XCTest 耗时中，尚无独立 boot 测量。根 typecheck、契约/工程绑定/证据隔离/Simulator 选择 71 项及 staged 代码质量 8 文件通过；Windows CLI 3 场景验证正确选择与 fail-closed，不属于原生通过。Mac 原生与实际 CI 耗时仍待验收，未启用矩阵并行。[使用与计时范围](apple-client-e2e.md)。日志 `.git/opt-e2-final-tests.log`、`.git/opt-e2-typecheck.log`、`.git/opt-e2-quality.log`、`.git/opt-e2-cli.log`；完整统一门禁待全部集成后执行。

E2 通过 [PR #80](https://github.com/Xiejiayun/artoo/pull/80) 合并为 `8068041`（实现 `3d37f84`）。

F3 已补 Tasks → Goals、Goal/More → Release 和 Team → Agent History；分开静态/本地发布、健康时效、确认停止、按需分页与工具证据。根 typecheck、Windows 58 端点静态契约、12 个 Swift 文件语法和服务端 2 文件 16 项回归通过；新增 8 个 XCTest 尚未执行，原生类型检查、小屏交互和 E2E 仍待 Mac。[行为、证据与验收缺口](ios-release-history-2026-11-14.md)。

F3 通过 [PR #81](https://github.com/Xiejiayun/artoo/pull/81) 合并为 `a904ed7`（实现 `82e3fba`）。

F4 已增加任务/Memory/消息服务端 q，定义字面子串、过滤后 limit、房间根/回复范围和查询绑定游标；Web 搜索独立缓存、历史分页、验证深链和移除同步。测量后追加 0062 消息正文及任务标题/描述 GIN 索引，PGlite 显式加载 pg_trgm；Memory 候选索引未稳定改善命中查询，因此不加入迁移。根 typecheck、server/Web build、搜索/迁移/存储/消息/Memory 5 文件 32 项、最终搜索/真实移除 2 文件 12 项、完整 Web 67 文件 630 项及 Chromium 2 项通过。浏览器实测修复频道隐藏搜索入口与弹窗/时间线重复 key；320px/桌面截图已检查，覆盖分页、旧回复跳转、实时移除、字面查询、失败重试与 Escape/焦点恢复。[契约、测量与局限](server-search.md)。独立 Postgres 与真实 Provider 验收未运行，最终统一门禁待全部集成。

F4 通过 [PR #82](https://github.com/Xiejiayun/artoo/pull/82) 合并为 `7aff640`（实现 `a161b70`）。随后该 PR 的远程 changed、postgres、image、build、shared-windows-process 与必需 Windows/Linux 打包聚合成功；mac-desktop 失败，其他部分 job 尚未完成，不视为整个 CI 已通过。Mac 失败来自 packaged smoke 仍断言可见的 `Live updates connected` 文字，U3 后页面已有具名健康 status 状态点；日志 `.git/opt-f4-remote-mac-desktop.log`，待独立修复验收脚本并重新运行。postgres job 不替代真实 Provider 或生产迁移验收。

F2 前置设计已明确 [计量契约与启用门槛](cost-metering-contract.md)：绑定执行/Provider 会话/Profile 的精确累计计量、revision/修正、事务幂等、unknown 与恢复、全部 Goal 阶段覆盖和“暂停后续调度”语义。当前 Codex 无费用、Claude 终态观测及旧 Usage upsert 均不足以提供该保证；保留拒绝 max_cost_usd，不将未知计为 0。**F2 实际计量/账本/成本准入/UI 尚未完成**，不能用设计文档标记该功能完成；缺少已验证的完整来源能力时继续其他独立项。

F2 前置设计通过 [PR #83](https://github.com/Xiejiayun/artoo/pull/83) 合并为 `1e5b28f`（文档提交 `9ea3a6b`），当前行为回归 3 文件 25 项通过，不改变功能启用状态。

C1 首步将 `app.ts` 的节点能力/分派装配移到 `node-dispatch-wiring.ts`；普通 Run 装配仍在原生命周期位置调用。保留 `??=` 自定义覆盖、每阶段原有查询/错误、当前节点会话解析和制品 store 身份。语法 Token 对比确认移出的语句及还原后的所有非 import 代码一致，公开 buildApp/options 签名不变；根 typecheck、server build、staged 代码质量 2 文件通过。此步不抽象授权/回执、不改路由或数据库；C1 的领域路由拆分仍待后续小步完成。

C1 的 Node 26 五文件实验已失败并中止：其余四文件完整通过，整轮实际记录 110 通过、3 个跨节点长链案例 30 秒超时，126 项未完成；终止已核实、无子进程的自有内存 DB worker 另产生 1 个预期退出错误，未删除临时夹具。日志 `.git/opt-c1-dispatch-tests.log` 与失败明细 `.git/opt-c1-observed-failures.json` 保留。曾对该 worker 采样 7 秒，样本 `.git/opt-c1-worker.cpuprofile` 仅用于定位，不能用该轮量化性能或宣称整套通过。

三个失败案例用 Node 24.22.1、单 worker、无采样复核为 1 通过/2 超时；未改动 `1e5b28f` 的原 app 源码基线对照为 2 通过/1 超时（H8 发布重试），本次提取后的文件已按字节恢复并再次通过语法对比。随后当前代码 H7 单例复核通过（1 项，184 项因聚焦选择未运行）。证据 `.git/opt-c1-node24-failed-cases.log`、`.git/opt-c1-main-baseline-cases.log`、`.git/opt-c1-node24-h7-recheck.log`。这证明 H8 超时也存在于基线，不能证明其慢因或完整跨节点验收通过；最终统一门禁仍须重跑，时限和断言均保持。

C1 首步通过 [PR #84](https://github.com/Xiejiayun/artoo/pull/84) 合并为 `76b9451`（实现 `e633cf3`）；完整跨节点长链验收缺口如上，不能以机械比对替代。

U3 后续验收脚本修复：packaged desktop、iOS core、mentions 与 recovery 的六处健康检查改用具名 `status`，保留原可见性与时限。按 C4 格式化触及的文件；语法树比对确认其余工作流/清理语句一致。提取始终等待的工作流清理，双失败保留两个原因，避免 `finally` 抛错覆盖原失败；真实 embedded fixture 测试改按 AST 提取原 writer，三个测试的全部子进程输入及断言经 AST 比对保持。

本轮 preview 构建、11 文件 staged 质量、6 文件 55 项 Node 回归与真实 Chromium 连接状态 1 项通过；本地生产模式恢复演练的 8 项检查通过、`cleanup=true`，证据 `artifacts/recovery/2026-11-13T18-20-20-667Z/report.html`。iOS core `--self-check` 已越过健康检查并通过前五个真实服务端/浏览器检查，随后在折叠的规划代理复选框处超时；资源与临时目录清理、源码稳定检查均通过，整体自检仍为失败，证据 `artifacts/ios/ui-harness-2026-11-13T18-22-10-199Z.html`。Windows 本轮没有运行 Mac 安装或 iOS 原生验收。

F4 的远程 [run 43473093909](https://github.com/Xiejiayun/artoo/actions/runs/43473093909) 现已结束：两个 Windows Vitest 分片和进程分区成功；mac-desktop/iOS 均因旧健康文字断言失败，当前修复覆盖这些位置，尚待远程重验。shared-checks 的 Web E2E 为 44 通过/7 失败（计划编辑 3、发布健康刷新 3、旧保存反馈位置 1），后续分别定位修复；不能声称整个 CI 通过或冷缓存 E1 完成。日志 `.git/opt-f4-remote-ios.log`、`.git/opt-f4-remote-shared-checks.log`。

恢复负向 harness 另 1 项通过（`.git/opt-health-recovery-failure.log`）：先完成真实持久化任务/消息/子进程制品，再故意选择非法浏览器通道；父测试核验子流程失败、实际关闭和删除、CLI exit 1。该结果不计为额外一次成功恢复演练。当前本轮日志还包括 `.git/opt-health-unit-tests-final.log`、`.git/opt-health-browser.log`、`.git/opt-health-ios-harness.log`、`.git/opt-health-quality-final.log`。

健康状态脚本修复通过 [PR #85](https://github.com/Xiejiayun/artoo/pull/85) 合并为 `a4f0a59`（实现 `82f040d`）。Mac/iOS 原生远程结果仍须绑定后续版本检查。

P4/U2/X3 验收后续：真实服务端发布事件为 `product.release.queued/completed/health`，原 P4 回归误用了不存在的 `goal.release.health`。先以实际名称复现 3 项失败，再加入发布事件缓存失效；真实 RealtimeProvider 回归同时验证在线退避及立即重读。发布健康 E2E 的独立服务器原未启动 publisher，补齐生产使用的真实 publisher，保留原断言/时限；这两处问题均有证据，不将夹具遗漏当作唯一产品缺陷。

计划编辑 E2E 显式选择目标所属项目，避免共享服务器上其他场景新增项目改变默认选择，重载后同样重选；保存反馈定位应用级 Toast。iOS browser self-check 使用真实摘要控件展开代理配置与任务条件。根 typecheck、preview 构建、7 文件 staged 质量、2 文件 27 项单元/组件回归通过。首轮浏览器 8 通过/3 发布健康失败；启动真实 publisher 后发布健康 3 项全部通过（分阶段共 11 项，尚非完整统一 E2E）。修改测试的语法树比对确认，发布健康仅增加 publisher 启动，受信预览仅改变保存反馈位置，其余原始断言不变。

iOS `--self-check` 最终 8 项通过，资源关闭、临时目录删除及源码稳定均为 true；检查实际三次进程贡献的上下文/归因、接受前零任务及接受后两任务/blocks 依赖。证据 `artifacts/ios/ui-harness-2026-11-13T18-34-26-311Z.html`，接受计划截图已检查。前一轮失败 JSON/截图另存 `artifacts/ios/attempts/2026-11-13T18-22-10-199Z-core-harness-failure`。这是浏览器 harness，不是原生或 live Provider 验收。日志 `.git/opt-integration-invalidation-red.log`、`.git/opt-integration-final-regression.log`、`.git/opt-integration-browser.log`、`.git/opt-integration-browser-health-final.log`、`.git/opt-integration-ios-harness.log`、`.git/opt-integration-final-typecheck.log`。

集成验收后续通过 [PR #86](https://github.com/Xiejiayun/artoo/pull/86) 合并为 `fe5707c`（实现 `73d7a77`）。合并后的远程 postgres/changed/image/进程分区成功；两个 Vitest 分片、shared-checks、iOS 仍运行，Mac queued，不能视为完整 CI 通过。

C1 领域路由第一步：11 个决策/交接/阻塞/等待关系端点从 `app.ts` 原序移入 `collaboration-routes.ts`，仍在原 Fastify scope 注册，沿用认证、幂等与逐请求 `requestContext`。AST 对比确认处理器、上下文绑定及还原装配后的所有非 import 代码/公开签名一致。根 typecheck、server build、2 文件 staged 质量、Node 24 单 worker 的协作 HTTP/服务/认证 3 文件 21 项通过（`.git/opt-c1-collaboration-*`）。不重复创建或改写领域契约/数据库；C1 其余领域路由仍继续逐个提取。

补充历史平台证据：已下载的 F4 [run 43473093909](https://github.com/Xiejiayun/artoo/actions/runs/43473093909) iOS job 日志证实 `a161b708d3bcec40c6fdfe7f66f4280fb36c6f10` 的原生编译及 199 项 XCTest 单元测试通过，包含 P7 两个类型化通知回归和 F3 Release 展示/停止回归。该 job 随后在 core 浏览器健康旧断言处失败，整体仍失败；这补充先前 Windows 本地未运行 XCTest 的证据，不代表最终版本原生 UI、真机或真实 Provider 验收通过。

C1 协作路由通过 [PR #87](https://github.com/Xiejiayun/artoo/pull/87) 合并为 `124dcc6`（实现 `7f531d4`）。该版本的 shared-checks 与 iOS 在静态契约检查处失败：固定源码清单漏了新拆出的协作模块，并非端点消失；日志 `.git/opt-c1-remote-shared-checks.log`、`.git/opt-c1-remote-ios.log`。后续 Goals 提取一并补齐清单并重跑，不能将远程失败写成成功。

补充 #86 的完整 shared-checks 证据：远程实际 Web Chromium 51 项、认证 E2E 6 项均通过，日志 `.git/opt-integration-remote-shared-success.log`。对应版本仍是 `73d7a77`，不替代最终集成版本的统一门禁，也不代表其他平台 job 已通过。

C1 Goals/Plans/Checkpoints 的 16 个端点原序移入 `goal-routes.ts`，仍在原 Fastify scope 注册，逐请求绑定用户上下文；保留取消流程的真实停止确认、断连失败处理和完成竞态。共享的可选 limit 校验原样移入无状态 `route-input.ts`。AST 比对确认所有处理器、停止流程、校验及还原后的 app 非 import 语句/公开签名一致；没有协议或数据库变化。

本步根 typecheck、server build、4 文件 staged 质量、Node 24 单 worker 的 Goal/审计/预算/预配置提交 4 文件 43 项通过。真实 WebSocket 暂停/取消与离线重连边界另 2 项通过，同文件其余 8 项因聚焦选择未运行。iOS 静态契约清单加入协作和 Goals 模块，22 个请求样本/58 个端点检查通过；这是静态检查，非原生通过。证据 `.git/opt-c1-goals-*`，C1 其余领域路由继续逐项处理。

C1 Goals 路由通过 [PR #88](https://github.com/Xiejiayun/artoo/pull/88) 合并为 `2727d6d`（实现 `a8c04c9`），已拉取最新 main 后开展 Devices 提取。远程该版本的后续 CI 尚未验收，不能用本地检查替代。

C1 Devices 的七个端点及私有平台/IP/TTL 校验原样移入 `device-routes.ts`；配对读取与撤销分别在原位置注册。保留同一个早期创建的 claim limiter、认证与幂等豁免、逐请求身份、真实连接注册表，以及仅实际关闭连接时发出的撤销离线事件。AST 对比确认处理器、所有私有辅助函数和还原后的 app 非 import 语句/公开签名一致。

本步根 typecheck、server build、3 文件 staged 质量、iOS 22 请求/58 端点静态契约通过。Node 24 单 worker 的设备 HTTP、真实 node/control WebSocket 撤销、在线状态与完整配对连接流程 4 文件 26 项通过（`.git/opt-c1-devices-*`）；不涉及新协议、迁移或生产发布，最终统一验收仍待后续集成。

C1 Devices 通过 [PR #89](https://github.com/Xiejiayun/artoo/pull/89) 合并为 `a105711`（实现 `e6bc414`），已再次拉取 main 后开展 Tasks/DAG 提取。远程 #86 的 Mac desktop 门禁已成功；iOS 与第二个 Vitest 分片尚未完成，不视为该轮完整 CI 通过。

C1 Tasks/DAG 的 14 个端点原序移入 `task-routes.ts`，包含任务/审计读取、依赖增删、准备/分派/重试/评审及 fixed-input result 分派；原 `readBaseVersion` 私有校验一起移动，保持非法值拒绝、过期版本冲突及旧客户端无版本语义。bootstrap 仍在原装配位置，开发 mock 执行与 Run 取消保持独立。AST 比对确认全部处理器、校验和还原后 app 的非 import 语句/公开签名一致。

本步根 typecheck、server build、3 文件 staged 质量、iOS 22 请求/58 端点静态契约通过。Node 24 单 worker 的 DAG 增删、OCC、节点 owned-result 绑定、并发快照和任务审计 6 文件 25 项通过，日志 `.git/opt-c1-tasks-*`。owned-result 是受控协议证据，不是实际 Provider/进程验证；最终统一门禁待其余独立项完成。

C1 Tasks/DAG 通过 [PR #90](https://github.com/Xiejiayun/artoo/pull/90) 合并为 `c5d2f5b`（实现 `8aad1d5`），随后再次拉取 main 开展 Skills 提取。

C1 Skills 的三个安装/读取端点原序移入 `skill-routes.ts`，保留逐请求身份、项目作用域、启用过滤及 manifest 校验。AST 对比确认处理器、上下文与还原后的 app 非 import 语句/公开签名一致。根 typecheck、server build、3 文件 staged 质量、iOS 22 请求/58 端点静态契约通过；Node 24 单 worker 的完整 Skills HTTP/调度能力贡献回归 1 文件 7 项通过，覆盖禁用、不兼容 Runtime 和其他项目的技能拒绝（`.git/opt-c1-skills-*`）。

C1 Skills 通过 [PR #91](https://github.com/Xiejiayun/artoo/pull/91) 合并为 `6c88bdd`（实现 `8da580c`），再次拉取 main 后开展 Approvals/Leases 提取。

C1 Approvals/Leases 的六个正式端点和一个开发审批端点原样移入 `approval-routes.ts`，分别在原位置注册。开发入口仍由 app 的 `options.enableDevRoutes === true` 判断控制，逐请求身份、limit/状态校验、响应与服务调用保持。AST 对比确认原 guard、七个处理器及还原后的 app 非 import 语句/公开签名一致。

本步根 typecheck、server build、3 文件 staged 质量、iOS 22 请求/58 端点静态契约通过。Node 24 单 worker 的审批、执行前门控和租约完整回归 3 文件 19 项通过，覆盖替换/并发决策/实际分派、历史与 blocker 关联、路径冲突/释放/过期与非法输入（`.git/opt-c1-approvals-*`）。最终统一门禁仍待后续集成。

C1 Approvals/Leases 通过 [PR #92](https://github.com/Xiejiayun/artoo/pull/92) 合并为 `282935f`（实现 `b9329a7`），再次拉取 main 后开展 Memories 提取。

C1 Memories 的六个端点原序移入 `memory-routes.ts`，保留普通列表 1–1000 与上下文检索非负 limit 的不同规则、静态 context 路由、接受/拒绝/替换和字面搜索行为。AST 比对确认处理器、上下文与还原后的 app 非 import 语句/公开签名一致。根 typecheck、server build、3 文件 staged 质量、iOS 22 请求/58 端点静态契约通过；Node 24 单 worker 的完整 Memory 与服务端搜索 2 文件 19 项通过，覆盖组织鉴权、过滤后上限、接受后检索和 supersede（`.git/opt-c1-memories-*`）。

当前方案指定的 app 内联领域已逐项提取；schema 和其余大文件仍需按依赖/实际边界评估，不能仅按行数宣布整个 C1 完成。#88 远程 shared-checks、Mac desktop、必需 Windows/Linux 打包聚合等成功；iOS/第二个 Vitest 分片尚未完成，不视为该轮完整 CI 通过。#86 两个 Vitest 分片、进程分区和 shared 聚合已成功，iOS 尚未结束，最终统一验收仍待后续集成。

C1 Memories 通过 [PR #93](https://github.com/Xiejiayun/artoo/pull/93) 合并为 `6b27005`（实现 `a206daf`），再次拉取 main 后评估并开始 schema 身份领域提取。

C1 schema 首步将组织、用户、AI 同意、内容规则、成员限制和 Agent 六张表原样移入 `schema/identity.ts`，三种原有列构造函数移至内部 `schema/columns.ts`。`schema.ts` 原地 re-export，保留所有公开表声明与调用方路径；身份模块无 root 反向依赖。AST 比对确认六张表、三个构造函数及还原后的 schema 全部非 import 声明一致，没有 DDL 或迁移变更。

本步根 typecheck、DB build、3 文件 staged 质量、Node 24 单 worker 的迁移/seed/AI 同意升级/认证/内容治理 5 文件 18 项通过。构建后的完整公开 schema 经真实 drizzle-kit 导出，与基线 119 张表、815 条 SQL 逐条一致（仅忽略语句顺序；模块提取确实改变输出顺序，最初原始文件 hash 比较因此失败，未将它写成字节一致）。定义摘要 `9df3a12e8e57d616595673f2543adfff64f78de1e3a3858ce61f93cf3b3dcc80`，证据 `.git/opt-c1-schema-identity-*`。迁移文件完全未变，不运行生产迁移；C1 其余表组/大文件边界仍待评估。

C1 schema 身份领域通过 [PR #94](https://github.com/Xiejiayun/artoo/pull/94) 合并为 `0eccb1c`（实现 `1cc868a`），拉取 main 后开始工作流表提取。

C1 schema 工作流领域将项目、任务、DAG 依赖、文件租约和集成队列五张表原样移入 `schema/work.ts`，root 原地 re-export，跨领域 Goal/Run 外键仍使用原延迟回调。AST 比对确认表声明、外键和还原后的全部 schema 非 import 声明一致。根 typecheck、DB build、2 文件 staged 质量、Node 24 单 worker 的 schema/seed/DAG/租约/生命周期 5 文件 28 项通过（`.git/opt-c1-schema-work-*`）。构建后的公开 schema 与基线 119 张表、815 条完整 SQL 逐条一致，仅忽略输出顺序，定义摘要仍为 `9df3a12e8e57d616595673f2543adfff64f78de1e3a3858ce61f93cf3b3dcc80`；没有迁移变更或生产数据库操作。C1 其余稳定领域继续分步评估。

C1 schema 工作流领域通过 [PR #95](https://github.com/Xiejiayun/artoo/pull/95) 合并为 `24ad72f`（实现 `fc15d1e`），重新拉取 main 后提取消息协作领域。该 PR 的远程检查仍未全部完成，不能以本地结果宣称整个 CI 成功。

C1 schema 消息协作领域将房间、消息、内容举报、通知、助手对话/派发和决策/交接/阻塞共九张表原样移入 `schema/messaging.ts`，root 原地 re-export。AST 对比确认九张表和外键回调一致、其余声明及顺序不变。首次 typecheck 发现 root 中两个 `assistantTurns` 外键引用缺导入，补齐后根 typecheck、DB build、2 文件 staged 质量及完整 DDL 比对通过；仍为 119 张表、815 条逐条相同的 SQL（仅忽略顺序）。首次测试过滤实际仅选中 schema 1 文件 6 项，通过；随后按已存在路径补跑消息/通知/助手/协作完整 6 文件 36 项，通过（Node 24 单 worker，`.git/opt-c1-schema-messaging-*`）。不以未匹配的过滤条件声称执行过其他文件；未修改迁移或数据权限。

C1 schema 消息协作领域通过 [PR #96](https://github.com/Xiejiayun/artoo/pull/96) 合并为 `78bcebf`（实现 `a1666c1`），重新拉取 main 后开始运行领域提取。

C1 schema 运行领域将模型/effort/电脑/Runtime/实例/Skill 配置、Run/调度/制品/Usage/审批、上下文与事件/幂等/验证证据共 16 张表原样移入 `schema/execution.ts`；只依赖原列构造函数及身份/工作流表，root 原地 re-export。AST 对比确认全部表声明、回调及剩余声明顺序一致；根 typecheck、DB build、2 文件 staged 质量、Node 24 单 worker 的 schema/seed/调度/真实子进程 Usage/回执/上下文/执行审批 7 文件 43 项通过（`.git/opt-c1-schema-execution-*`）。真实 drizzle-kit 导出的 119 张表、815 条完整 SQL 与基线逐条一致，仅忽略顺序；没有迁移变更。真实子进程 Usage 案例不代表 live Provider 验收，也不启用 F2 成本预算。

C1 schema 运行领域通过 [PR #97](https://github.com/Xiejiayun/artoo/pull/97) 合并为 `b55fab5`（实现 `8ae824c`），拉取 main 后开始自治研发领域提取。

C1 schema 自治研发领域将 Goal 自动化、独立评审、发布、跨节点源码交接及后续设计/执行/验证/恢复/研究修订共 60 张表原样移入 `schema/autonomous-handoff.ts`，root 原地 re-export；已有 clean/restart 模块继续保持原边界。AST 对比确认全部表声明与外键回调一致、其余声明及顺序不变。根 typecheck、DB build、2 文件 staged 质量、Node 24 单 worker 的 schema/seed/源码传输/恢复契约/发布/Goal 自动化 6 文件 95 项通过（`.git/opt-c1-schema-autonomous-handoff-*`）。真实 drizzle-kit 导出的完整 119 张表、815 条 SQL 与基线逐条一致，仅忽略顺序；定义摘要保持 `9df3a12e8e57d616595673f2543adfff64f78de1e3a3858ce61f93cf3b3dcc80`。没有迁移变更或生产数据库操作；受控传输/发布契约不等同真实 Provider、Windows native helper 或目标产品发布验收。

C1 schema 自治研发领域通过 [PR #98](https://github.com/Xiejiayun/artoo/pull/98) 合并为 `00dc11a`（实现 `42d338a`），拉取 main 后开始 artood 的上下文渲染提取。

C1 artood 将三个纯上下文文本渲染函数移入内部 `process-adapter-context.ts`，仍由原适配器在原位置调用，包入口没有新增导出。AST 比对确认函数/字面量/类型及其余进程生命周期语句和公开签名一致；原文件按 C4 规则格式化，所以 diff 包含格式变化。根 typecheck、artood build、2 文件 staged 质量、Node 24 单 worker 的完整 process-adapter、只读上下文与恢复入口回归 3 文件 69 项通过、11 项按既有 Windows 条件跳过（POSIX symlink 范围，不报为通过）；日志 `.git/opt-c1-process-context-*`。现有真实子进程测试核对 legacy 文本字节、紧凑 UTF-8 分页与工具边界，不代表 live Provider 或 POSIX 验收。

C1 已完成方案明确列出的 app 装配/领域路由和五个 schema 领域提取；schema 的设备/auth、Memory 和手动 Goal 小块保留原入口。已评估其余 artood 示例：node-client 已挂载各阶段专用客户端，而 product-source-runtime、product-release、verification 与进程控制中的私有 WeakMap 身份、预留、Profile/命令绑定和关闭确认跨函数共享；继续拆分需要新状态接口，并非独立纯移动。本轮只选择已证明独立的文本渲染，不按行数强拆这些授权边界。模块地图已补入项目 AGENTS.md；下一步处理 C2 中已确认同构的六组 pending-stop 管理，保留各阶段接收/鉴权差异。

C1 上下文渲染通过 [PR #99](https://github.com/Xiejiayun/artoo/pull/99) 合并为 `90f1486`（实现 `1d4cbb5`），随后重新拉取 main 开展 C2。该实现版本的远程 shared-checks 实际 Web Chromium 51 项、认证 E2E 6 项通过，日志 `.git/opt-c1-final-remote-shared.log`（run 43497326659）；这些结果绑定该提交，不代表最终版本或全部平台 CI 通过。

C2 将六组已确认同构的阶段停止等待移入 `createPendingStopRegistry`：共享同 ID 等待、原 15 秒期限、requestStop → dispatch → 合格关闭回执、失败传播及断连清理。各阶段查询/权限、结果校验和错误文字仍在原绑定；整个 receive 处理器 AST 一致，ACK 仍不能替代关闭。普通 Run、产品发布及应用发布停止保持各自语义，没有引入阶段授权配置表。另明确关闭后拒绝迟到的登记，避免断连后发送新 stop。尚未完成的 dispatch 继续真实等待，不因超时或断连伪造其完成。

本步根 typecheck、server build、3 文件 staged 质量及 AST 有界替换复核通过。Node 24 单 worker 的注册表/节点绑定/验证/分配/源码重放/预览回归 6 文件 86 项通过，包含最终 11 项注册表边界用例（`.git/opt-c2-stops-tests.log`）。真实 H7/H3 绑定基线两例通过；改动后首轮 H7 30 秒超时、H3 通过，保留 `.git/opt-c2-stops-source-tests.log`。临时诊断包装下 H7 单例通过，但未得到阶段慢因；包装已按字节恢复。未包装、未改断言和时限的原两例复核均通过（`.git/opt-c2-stops-source-recheck.log`，2 通过/183 未选）。这些结果不能证明首轮超时根因或完整跨节点长链通过，后续 E1/统一验收仍需覆盖。

C2 通过 [PR #100](https://github.com/Xiejiayun/artoo/pull/100) 合并为 `5535d38`（实现 `b3d821f`），已再次拉取 main。

C3 合并并排序 `app.ts`、`node-binding.ts`、`context-pack-service.ts` 的重复导入，按内置、外部、工作区、相对路径分组。分别从 50/64/17 条变为 49/43/15 条；每个导入的来源、别名、type/runtime 标记及全部非 import AST 与 `5535d38` 一致。当前 app 的尾部导入已在 C1 领域移动时消除，本次不虚构额外删除。按 C4 规则格式化触及的上下文文件，其余业务语句仅格式变化；根 typecheck、server build、3 文件 staged 质量及 Node 24 单 worker 的装配/认证/上下文/节点绑定 5 文件 18 项回归通过（`.git/opt-c3-imports-*`）。没有新增业务或性能收益声明；最终集成门禁仍待后续执行。

C3 通过 [PR #101](https://github.com/Xiejiayun/artoo/pull/101) 合并为 `cc9a94d`（实现 `9695cb9`），拉取 main 后开展 E3。

E3 增加 `test:unit`（domain/protocol/Web 单元及组件）和 `test:server`（全部服务端），保留原 `npm test`、Vitest 配置、超时及平台条件。实际 discovery 精确对应完整 606 文件中的 136/157 文件，DB/storage/artood/desktop 等仍在全量入口；README 说明编译入口前置、真实浏览器和独立 fixture harness 范围，以及追加位置过滤参数不会缩小原目录集合。

实际执行新 `npm run test:unit -- --maxWorkers=2`，Node 24 的 Vitest 进程路径经 CIM 确认；136 文件、1,497 项全部通过，无跳过或未完成用例。JSON reporter 的实际文件集合与 discovery 一致（`.git/opt-e3-unit-tests.log`、`.git/opt-e3-unit-results.json`、`.git/opt-e3-inventory.log`）。staged 质量通过，未改测试原文或依赖。`test:server` 本步核对完整发现集合，尚未重新执行其全部 157 文件；最终全工作区门禁仍待后续集成。本机单位入口耗时 591.84 秒，没有同版本全量对照，因此不声称量化提速。

E3 通过 [PR #102](https://github.com/Xiejiayun/artoo/pull/102) 合并为 `a826fef`（实现 `5a7d4e2`），拉取 main 后开展 X5。

X5 增加 Header 命令按钮和 Ctrl/Command+K 面板，复用现有 Modal、查询缓存、项目订阅及真实创建/连接表单。项目选择仅改变搜索范围，执行结果时才同步项目与任务选择；按需读取单个项目的 Task/Goal/Channel，保留组织匹配、失败重试、移除项目/迟到响应隔离及 prepared Goal 限制。支持页面、项目、实体与 Agent History 导航，最多显示 50 条结果；确认表单前不写入。行为与范围见 [Global commands](command-palette.md)。

初轮 Chromium 三项均失败：两项在导航尚未提交时打开面板，被随后提交的路由关闭；另一项暴露共享 Modal 将 `tabIndex=-1` 的结果按钮仍算作 Tab 边界。结果改为 combobox 持焦点的 listbox 选项；打开加入路由 transition，关闭只作用于前一已提交页面上原已打开的面板。布局 effect 单独调整仍有失败，临时诊断日志确认 URL 变化与 React 提交的先后；诊断源码已按字节恢复。并发导航单元回归在修复前明确失败，之后与焦点回归通过，没有放宽断言或测试期限。

最终根 typecheck、Web build、6 文件 staged 质量及相关 6 测试文件 64 项通过（Node 24，单 worker；`.git/opt-x5-typecheck-final3.log`、`.git/opt-x5-web-build-final3.log`、`.git/opt-x5-quality-final3.log`、`.git/opt-x5-focused-tests-accepted.log`）。GoalsPage/ProductHeader 按 C4 全文件格式化；AST 复核只排除新增创建入口/效果，并规范化 React children 的相邻同文本字面量，其余发射 JS 结构一致。早期 NodeList 迭代、测试 fixture/选项类型错误以及缓存通知断言时序失败均已修正并保留原日志；不以初轮失败充当最终结果。

最终 Chromium 3 场景连续两轮共 6 项通过，覆盖真实项目/Task/Goal/Channel/Agent 导航、表单前零写入与确认后各一次写入、Connect Local Node、抽屉冲突和实际 Tab/Escape。320×568 暗/亮及 1440×900 截图人工检查通过，列表和面板保持内部滚动、无横向溢出。证据 `.git/opt-x5-e2e-final.log`、`.git/opt-x5-e2e-final-environment.json`，HTML/截图目录 `apps/web/{playwright-report,test-results}/workflows-2026-11-13T21-07-39-308Z`；初轮、修复中失败及临时诊断保留各自日志。本项不替代最终统一 E2E、原生或 live Provider 验收。

X5 通过 [PR #103](https://github.com/Xiejiayun/artoo/pull/103) 合并为 `40ba866`（实现 `310b9d2`），拉取 main 后开始 F5。

F5 新增显式 `signing=ed25519-v1` 协商的 `artoo.audit-signed.v1`，覆盖 Task/Goal 的已授权、已脱敏证据。Ed25519 签名覆盖除 signature 外全部原始 JSON 字段，包括包摘要、导出时间、kind 与签名元数据；规范化和摘要属于新版本，旧 v1alpha1 默认输出保持。Web 下载按钮请求新格式；未配置时仍返回 deferred，旧客户端保持原 API。配置在打开数据库前校验 issuer、Ed25519、SPKI 指纹及私钥匹配，错误不输出密钥或文件内容。公钥信任须独立分发；retired 验历史、revoked 拒绝，轮换须更新受保护配置并重启。离线 CLI 只接受下载的 envelope 和独立可信公钥环；未安装生产密钥或执行发布。

根 typecheck、server/Web build、19 源码文件 staged 质量及 10 个既有文件有界新增/格式化 AST 比对通过；聚焦 8 文件 125 项全部通过（Node 24，单 worker；`.git/opt-f5-focused-tests-final.log`）。覆盖各字段及嵌套未知数据篡改、完整原始 JSON、轮换撤销、认证/组织隔离、脱敏、参数协商、旧默认输出、真实持久化启动/TCP 导出和实际离线 CLI。最后复核将新启动与 HTTP 测试接入既有 settled fixture：等待原始回调、晚到资源及子进程实际 close 后再删临时目录；时限和断言保持。补强后根 typecheck 与 HTTP/CLI 4 项再次通过（`.git/opt-f5-typecheck-resources.log`、`.git/opt-f5-http-resources.log`），配置 17 项亦通过（`.git/opt-f5-config-lifecycle.log`）。测试资源所有者本身未修改。

中间失败如实保留：首轮篡改测试直接修改冻结元数据，改为克隆 HTTP 解析对象后通过；首轮整组为 124 通过/1 启动案例 30 秒超时。未改断言和期限的配置复跑 17 项通过，尚未证明该次超时慢因，不能称为已修复启动性能。增加了失败阶段计时诊断和安全清理。一次误并发构建经 PID 核验后只终止新启动进程，失败日志保留；随后串行 typecheck/server/Web build 全通过。完整证据 `.git/opt-f5-*`。签名不等于证据事实正确、执行/发布成功或可信时间；本项不替代最终统一 E2E、原生、live Provider 和生产密钥运维验收。

F5 通过 [PR #104](https://github.com/Xiejiayun/artoo/pull/104) 合并为 `a41ee56`（实现 `fa5a3b4`），已拉取最新 main 后开展 C5。

C5 新增 [文档地图](INDEX.md)与[脚本地图](../scripts/README.md)，从 README 提供入口。文档区分现行架构/契约、运维发布、客户端、版本化验证和历史计划；脚本区分日常检查、CI 分区/聚合、原生 suite 包装、支持模块、发布工具与受控场景。明确 Node 测试与 Vitest 的发现范围、真实 Provider/原生/生产验收边界及后续 gates/ios/fixtures 归类规则。没有移动文件、改写历史证据或改变 npm/工作流路径。

本机校验 156 个本地链接、docs 根目录全部 90 篇文档的索引覆盖、14 个真实 package 命令和 preview 的 --list 分支；实际 `npm run verify:preview -- --list` 与 diff whitespace 检查通过（`.git/opt-c5-links.log`、`.git/opt-c5-preview-list.log`）。纯文档不新增镜像测试；完整类型/构建/运行门禁留在最终集成执行。

C5 通过 [PR #105](https://github.com/Xiejiayun/artoo/pull/105) 合并为 `d46efae`（实现 `4de1396`），已拉取最新 main 后开展 E1。新增入口诊断确定本机失败发生在开发入口首次启动；并行加载实验仍有超时，已撤回，不放宽原时限。完整冷缓存分区将由带前后缓存观察记录的实际 Windows CI 验证；安装步骤尚保留，当前并未完成 E1 或最终统一门禁。详见[追加的诊断与候选说明](ci-vitest-browser-validation-2026-11-13.md#2026-11-14-启动诊断与-ci-隔离候选)。

E1 的缓存观察门禁与启动诊断作为独立基础步骤，经 [PR #106](https://github.com/Xiejiayun/artoo/pull/106) 合并为 `a1c4bf2`（实现 `119db12`），随后重新 pull main。没有删除 Chromium 安装。根 typecheck、完整 workspace build、实际观察器正向/拒绝场景、staged/changed 质量及 YAML/AST 保持核验通过；候选 CI run `43515163808` 的实际 checkout 为 `05622d4b4fb3473cbb9ec412611abe538ba70a67`。当前 windows-process 4 文件 88 项通过，parallel-1 303 文件、4,500 项通过/23 项既有条件跳过，均有一致的前后缓存及 executable 不存在记录；parallel-2 与整体覆盖聚合尚未完成，不视为整个 E1 或 CI 通过。

该轮 shared-checks 的真实 Web 结果为 51 通过、3 失败。失败页面均选中了命令面板测试新建的项目；Goal ID 链接刷新后仍只查询默认项目，未像房间链接确认目标归属。独立临时回归精确失败为所请求 Goal 仍为 none、项目仍为另一项目（`.git/opt-goal-link-diagnostic-before3.log`）。现从上述最新 main 独立分支修复，保留原测试断言和时限；原 CI 失败及早期诊断未被重跑覆盖。

Goal 链接修复在当前项目列表找不到指定 Goal 时，按需调用现有鉴权单 Goal 接口，核对 ID/组织和 bootstrap 已知项目后一次性切换；忽略 URL 项目提示。查询按组织/账号/Goal 隔离，缓存必须重新验证，迟到响应和显式后续选择不能回拉；失效项目或查询失败显式重试。Plan/Release/Board 等待归属查询，不展示无关 Goal 或提前给出发布结论。行为见 [Global commands](command-palette.md)。

根 typecheck 及 Web build 通过，9 文件 staged 质量、Board/Release 除已声明的加载/错误/重试变化外的完整发射 JS AST 保持核验通过。首轮聚焦 7 文件为 108 通过/1 失败：Board 同时呈现新增错误和原 ErrorState，原唯一 alert 断言失败；改为沿用原 ErrorState 后，原 Board、导航与新增链接边界 3 文件 21 项全部通过（`.git/opt-goal-link-tests-recheck.{log,json}`）。新增 9 项覆盖组织/ID、失败重试、bootstrap 更新、缓存重验、账号变化和迟到响应。最初两个测试误用了 Playwright 的 exact 选项，修正为 Testing Library 的既有精确 name 匹配后根 typecheck 通过；未改业务断言、时限或跳过条件。

真实 Chromium 按命令面板创建第二项目 → Goal 链接 → 原加载状态 → 原自然交付顺序完整执行，8 项全部通过（`.git/opt-goal-link-e2e.log`），包含先前 CI 的全部 3 项失败及新增 Plan/Release/Board 刷新归属回归。该聚焦结果仍不替代最终 main 的完整四门禁、完整 Web E2E 或真实 Provider 验收。

## 后续顺序

P5 首次聚焦 E2E 在创建频道后的首次发送处超时，输入框为空；未改代码重跑通过。既有组件测试已记录列表刷新后到房间校验间会替换 DOM，E2E 现在等待房间校验响应再输入，不改发送/同步断言或超时。连续 3 次通过，证据 `.git/opt-p5-e2e-stable.log`；首次失败保留 `.git/opt-p5-e2e.log`。类型/构建/回归日志分别为 `.git/opt-p5-final-typecheck.log`、`.git/opt-p5-server-build.log`、`.git/opt-p5-web-build.log`、`.git/opt-p5-tests.log`、`.git/opt-p5-client-tests.log`。这不替代最终统一 E2E。

P5 通过 [PR #67](https://github.com/Xiejiayun/artoo/pull/67) 合并为 `53b1d55`（实现 `dabaaea`）。

恢复预检通过 [PR #68](https://github.com/Xiejiayun/artoo/pull/68) 合并为 `a455704`（实现 `03546d9`）。

E1 完整分区重验 → 最终统一门禁。C1 本轮选定的职责拆分与其余候选边界评估如上。F2 保留待实现/验收；E4 的最终版本验收与未就绪环境并行跟进。

所有条目仍须以最新源码复核适用性。E1 必须在无浏览器缓存的真实 Windows 分片通过后才移除安装步骤；iOS 原生验收需要 macOS；E4 产品发布需具备已授权的环境、凭据、受保护 Profile、健康标准和恢复方案。当前未执行新的产品发布，尚未运行最终统一 E2E。

F2 当前行为回归：`structured-output`、领域预算、Goal 成本拒绝门控 3 文件 25 项通过（`.git/opt-f2-current-behavior.log`）；本次只提交前置设计，不改变 Usage、预算或调度代码。
