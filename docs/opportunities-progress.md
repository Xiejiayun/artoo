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
| E4 | 本机原生边界已验证，等待共享授权与最终验收 | [验收准备与证据要求](opportunities-acceptance-2026-11-13.md)。现有 rc.8 helper 与真实 Chromium 的嵌套 Job 三场景通过；使用已有准入私有 TEMP 后，真实节点→CLI→浏览器密封存储链及十个拒绝场景通过。旧夹具断言与权限失败分别保留。尚未读取凭据或调用 Provider；单次 45 分钟真实外部模型验收的共享授权仍待回复，最终版本产品验收未完成。 |
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
| E1 | 完整空缓存分区通过，移除冗余安装 | 安装移除后，main `ea75afe` 的实际 Windows CI 三 lane 共 611 文件、8,848 项通过/90 项既有条件跳过；实际文件覆盖无遗漏/重叠，前后缓存及 executable 均不存在。保留观察器及真实浏览器 suite 安装。[版本、方法与结果](ci-vitest-browser-validation-2026-11-13.md)。本机完整失败及远程其他 job 分别记录。 |
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

Goal 链接修复通过 [PR #107](https://github.com/Xiejiayun/artoo/pull/107) 合并为 `e5a4915`（实现 `560ba3b`），拉取 main 后开展 E1 安装移除。完整三 lane、前后空缓存和文件覆盖聚合均通过，详见 [E1 证据](ci-vitest-browser-validation-2026-11-13.md#2026-11-14-完整-windows-ci-证据与安装移除)。仅删除 parallel installer，解析后的 YAML 除该步骤外完全一致；staged/changed 无适用 JS/TS/JSON/CSS 文件，均正常退出。通过 [PR #108](https://github.com/Xiejiayun/artoo/pull/108) 合并为 `061335e`（实现 `662b200`），再次拉取 main 后单独复核本机原生夹具；未称尚未完成的远程整套 CI 通过。

本机 Node 24.22.1、Chromium 156.0.8078.80、现有 rc.8 pinned helper 的真实嵌套 Job 正常/中止/外层取消三项全部通过，实际退出、Job 清空及 EOF 均核验。随后节点→受保护 CLI→Job 浏览器存储夹具首次因复制 backend 的旧错误文字断言失败；改为精确匹配现行安装准入错误，并立即断言没有派发。完整 AST 复核保留其余流程、时限、关闭断言与全部十个拒绝场景；按 C4 格式化该 worker。

第二轮在默认 TEMP 被生产私有上下文检查拒绝，原因为其他本地 principal 可修改；没有派发 CLI。使用已配置且通过完整准入的 `temporary_directory` 后，正向节点链产生真实密封 v3 存储观测，但旧 Zod getter 文案断言失败。现断言 CLI 现行安全诊断的事件/版本、单一 root ZodError 及省略 message，不要求生产执行不可信 getter；另在观察器断言前明确核对节点 outcome，保留原始失败原因。未修改生产权限、诊断、执行命令或截止时间。

最终完整原生存储夹具 1 项通过、零跳过，内含全部十个实际 CLI 拒绝场景；正向种子只应用一次，真实存储写失败命中一次，源码不变、私有上下文清理、原始关闭回执及序列化副本拒绝均通过。实际子进程 close 为 0/null，运行前后源码 patch 和 4,762 个输入文件摘要一致；fixture 按原约定保留独立证据目录。完整证据 `.git/opt-native-recheck-2026-11-13T22-57-50.015Z/`；早期失败 `.git/opt-native-2026-11-13T22-44-39.073Z/`、`opt-native-recheck-2026-11-13T22-51-10.166Z/` 与 `opt-native-recheck-2026-11-13T22-53-15.627Z/` 保留。worker 语法、单文件 staged 质量及最终 AST 检查通过；这不是模型产品、跨实体电脑、原生客户端或发布验收。

原生夹具调整通过 [PR #109](https://github.com/Xiejiayun/artoo/pull/109) 合并为 `ea75afe28ecc3abf2e104f49fb1d72dea7e7334e`（实现 `dfe625c`），再次拉取 main 后冻结本机最终四门禁。

## 2026-11-14 首轮最终集成门禁

干净 main `ea75afe28ecc3abf2e104f49fb1d72dea7e7334e`，Windows、Node 24.22.1、npm 11.20.0，串行执行四门禁，整个驱动实际退出 1。各阶段核验 HEAD 和干净源码保持；证据 `.git/opt-final-20261114-070254/summary.json`。typecheck 和完整 workspace build 均退出 0；完整 Vitest 退出 1，611 文件、8,841 项通过、9 项失败、88 项条件跳过；随后完整真实 Chromium Web E2E 退出 1，54 通过、1 失败。不能称该轮最终验收通过。

Vitest 的九项失败分布在 server-entry（1）、imported-design-review-verification（1）、goal-automation（1）、preview-storage（1）、release-capability-batch（1）及 imported-design-continuation（4）。入口明确在首次开发启动的原 30 秒 readiness 期限失败；其余八项 JSON 保留 Vitest 的 `STACK_TRACE_ERROR` 注册栈，未保留原始错误文字。当前 runner 的 timeout 错误会复制这种栈，且本轮 PowerShell 原生 stderr/CLIXML 解析错误污染了人类日志；因此仍需原始流采集和相称诊断，不只凭耗时断言全部同因。原始 JSON、日志及失败记录保留，时限和断言未放宽。

同一 main 的 [CI run 43524088497](https://github.com/Xiejiayun/artoo/actions/runs/43524088497) 已完成 shared-checks、两个 parallel lane、windows-process、shared 聚合和 mac-desktop。三 lane 的完整实际结果为 611 文件、8,848 通过、90 条既有条件跳过、零失败，Node 24.22.2；原覆盖核验函数重新复核文件零遗漏/重叠及六份前后空缓存记录。shared-checks 38 个门禁通过，包含 Web 55 项、认证浏览器 6 项；Mac 18 个门禁和生产模式隔离恢复演练 8 项通过，实际进程关闭及清理完成。恢复使用确定性本地子进程，不是 live Provider 或生产灾难恢复验收。证据 `.git/opt-final-remote-43524088497/verified-{vitest,shared,mac}.json`。截至本次记录，iOS 仍运行 `verify:ios`，整个 workflow 尚未结束，windows-desktop 按既有条件跳过。

本机与上述 CI 的文件和 8,938 项用例身份逐项相同。九项本机失败在 CI 均通过；另两项 Windows desktop-worker 的真实 IPC 关闭/独立 guardian 进程树案例在本机执行通过、CI 条件跳过，解释了跳过数差异。比较证据 `.git/opt-final-20261114-070254/verified-comparison.json`；环境和耗时差异不构成慢因证明，也不覆盖本机失败。

Web 唯一失败是项目创建和改名连续完成时，两个合法的相同 `Project saved.` Toast 同时存在，旧测试把通知区当作唯一 status。现先等待创建提示按原生命周期消失，再执行保存并使用原 status/文字断言；这也防止把上一次创建提示误当作本次保存反馈。没有改变产品 Toast、超时、后续项目/配对/撤销/Skill 流程或其断言。暂存质量、根 typecheck 及原场景连续三次真实 Chromium 完整复核均通过，实际 close 0/null；证据 `.git/opt-toast-e2e-recheck-20261114-0922/{summary.json,stdout.log,stderr.log,source.patch}`，HTML `apps/web/playwright-report/workflows-2026-11-14T01-20-20-091Z`。目录名不作启动时间依据，实际开始/结束以 summary 为准。原完整失败保留，修复合并后仍须完整 Web 重验。

## 2026-11-14 iOS 原生路径补充

Toast 复核通过 [PR #110](https://github.com/Xiejiayun/artoo/pull/110) 普通合并为 `182c969222b80c80064432a1bbbee947ddd822bb`（实现 `09feecb`），拉取 main 后创建本项分支。合并后的完整 Web 尚待重跑。

在该干净 main 上按原失败 fullName 精确选择九项、保留 maxWorkers=2 和原期限复核，五项通过、四项失败，另 260 项因聚焦未运行；不是完整套件通过。原始字节流证据 `.git/opt-failed-nine-recheck-20261114-0926/` 显示 H7/H8 各在 30 秒测试期限、storage 在 60 秒测试期限、入口在 30 秒 readiness 期限失败。H8 的 prepare-publication 观测约 32.1 秒；尚未确立根因，未放宽期限或修改生产逻辑。原完整九失败保留。

旧 main 的 CI run 43524088497 被后续 main 推送按现有 `cancel-in-progress` 策略自动取消。下载工件后，独立按原始 xcresult tests/summary、相同源码指纹和完成后的父报告核验 core 7、assistant 1、mentions 1、correction 1，共十项通过，资源/临时目录/原生进程组清理均完成且无强制关闭；证据 `.git/opt-final-remote-43524088497/ios-cancelled-evidence/verified-ios-partial.json`。retention 未完成，publisher iPhone/iPad 未执行，整个 workflow 仍为 cancelled；不称完整 iOS 通过。

本项扩展现有两个 core XCTest，不增删原十一项原生用例或改变期限：任务真实执行并人工验收后，从 Team 按 Agent ID 打开精确 Run，核对原 ContextPack 请求、验收标准和实际响应事件，再确认任务、Run、制品和摘要保持；取消用例从 Tasks→Goals 进入，经 Goal→Publication 核验独立静态/本地应用未发布状态，再保留原 Keep/确认取消全部断言，并经 More→Release 复核同一 Goal 及读取未写入审计。fixture 已有 executor Agent ID，现传入原生环境；同名实例仍不作为历史身份依据。三种新增截图加入显式报告白名单，相关报告模块按仓库规则格式化。

Windows 前置：22 请求/58 端点静态契约、原生套件与截图报告 29 项 Node 测试、两文件 staged 质量通过；三份变更 Swift 在系统 Node 26.13.0 下语法解析退出 0。Node 24.22.1 的旧 WASM parser 虽输出三文件无语法诊断，但随后进程 OOM 退出，记为失败；全仓解析还命中已记录的旧语法诊断，不以它宣称通过。证据 `.git/opt-f3-native-paths-{api,contract,swift,swift-system}-20261114/`。这些都不替代 Swift 编译、XCTest 或新路径原生实测；新增 UI、发布停止/健康/断网交互及最终完整 iOS 验收仍待 macOS 门禁。

## 2026-11-14 连接状态 E2E 时序与完整 Web 复核

iOS 新路径通过 [PR #111](https://github.com/Xiejiayun/artoo/pull/111) 合并为 `3ecb0e47e531b70cd31eb2475bfee0ec7d98c973`（实现 `19ab792`）。该干净 main 的 typecheck 与完整 workspace build 通过，随后完整 Web 为 54 通过/1 失败：连接状态测试在待发横幅已出现、浏览器 request 事件尚未到达时就检查 `taskId`，得到空字符串。原始完整失败保留在 `.git/opt-final-browser-2026-11-14T01-51-41-174Z/`。

重新 fetch 并从同一最新 main 创建独立分支，只将原 Mark ready 点击与实际 `requestfailed` 事件同步等待。AST 比对确认其余可执行语句一致，原有服务器 backlog/ready、队列、重连、幂等键、视口和全部期限断言均保留。staged Biome、根 typecheck 通过；真实 Chromium 原场景连续三次通过（`.git/opt-connection-sync-recheck-20261114/`），随后完整 Web 55 项全部通过（`.git/opt-connection-sync-full-web-20261114/`）。两个驱动均观察到真实 close 0/null，运行前后提交与工作区状态不变；这轮候选是 `3ecb0e4` 加该单文件 patch，尚不称为合并后 main 的复核。

同一 main 的 [run 43542991905](https://github.com/Xiejiayun/artoo/actions/runs/43542991905) 已完成 shared-checks 与 mac-desktop。下载原始报告并核对 job 的 run/HEAD、38 个共享检查、Web 55 项、认证 6 项、18 个 Mac 检查和 8 项隔离恢复演练；全部通过，恢复的浏览器实际正常关闭、节点/服务端关闭及临时目录清理均完成。机器核验汇总 `.git/opt-final-remote-43542991905/verified-shared-mac.json`。此时两个完整 Vitest lane 与 iOS 仍运行，Windows desktop 按既有条件跳过，不能宣称整个 workflow 通过；上述恢复是确定性本地子进程演练，不是 live Provider 或生产恢复证据。

此前本机完整 Vitest 的九项失败继续保留。四项再次在 Node 26 原期限下复核仍失败；H8 单 worker CPU 采样和阶段计时显示其 prepare-publication 约 29.94 秒，整个测试触发 30 秒期限。该诊断不能证明所有失败的共同根因，也不是通过证据；没有改生产行为、断言或期限。证据 `.git/opt-four-system-node26-20261114/`、`.git/opt-h8-owned-worker-2026-11-14T01-59-55-025Z/`。F2 可靠计量/账本/成本准入仍未实现，E4 仍等待真实外部 Provider 共享授权及最终产品验收。

## 2026-11-14 iOS 历史响应查询修正

PR #111 的 [原生 CI](https://github.com/Xiejiayun/artoo/actions/runs/43542284017) 完整结束为失败：core 七项中六项通过，任务执行/验收用例已走到真实 Agent History 响应展开，随后测试进程 SIGABRT。原始 xcresult 的诊断日志明确报告字符串标识符查询超过 XCTest 的 128 字符上限，响应为实际执行器产生的完整 150 字符文字；不是应用进程崩溃或业务断言失败。后续四套原生 suite 和 publisher 检查未执行，不能计为通过。父进程实际退出 1，原生进程组、服务端/节点及临时目录清理完成。完整工件和解压后的诊断摘录保留在 `.git/opt-f3-pr111-43542284017/`。

重新 fetch 并从干净最新 main `cb2a128` 创建独立分支，只把该响应的字符串标识符查询改为精确 `label == %@` 谓词，并显式断言完整 label 等于服务器响应。原生用例、响应、滚动次数、期限及既有业务断言保留。本机 Swift 语法解析、原生 suite/报告契约 29 项及 API 静态契约通过；这些不是 Swift 编译或原生 XCTest 通过，实际 macOS 门禁仍须重跑。

## 2026-11-14 原生 core 复核与回环链接修正

[PR #113](https://github.com/Xiejiayun/artoo/pull/113) 普通合并为 `b779006fbdc05ccbd95ba7abfc39818332874d79`（实现 `202ed95`），随后重新 fetch/pull 干净 main。合并依据是该测试修正的实际针对性结果：[run 43548201742](https://github.com/Xiejiayun/artoo/actions/runs/43548201742) 的 Swift 编译成功，原 core 七项全部通过，任务执行/验收案例完整走过新增 Agent History 请求、150 字符真实响应、精确 label 校验和截图，03:28:59 UTC suite 结束，xcodebuild 明确 `TEST EXECUTE SUCCEEDED`。此时后续独立原生 suite 仍运行，未称完整 iOS 或整个 workflow 通过；最终仍需下载原始 xcresult/关闭报告核验。

该 PR 的共享检查 38 项（含 Web 55、认证 6）及 Mac 安装 18/恢复 8 项已完成并独立核验。Vitest 首轮完整 611 文件为 8,846 通过、2 失败、90 条既有条件跳过：两项未修改的 `node-client-release-retry.integration.test.ts` 在等待首个 WebSocket command ack 时失败。原失败、文件/用例身份和现行 main 对比保留 `.git/opt-pr113-43548201742/verified-vitest-{current,first-failure}.json`。原文件本机两项通过，与相邻真实进程测试并行复核 2 文件 24 项通过，此前精确 main 完整 CI 也通过；这些不建立首轮 CI 慢因或覆盖失败。完整 run 结束后仍须重验失败分片及聚合，不放宽时限或断言。

从上述新 main 单独修正 F3 静态发布链接：旧判断只排除 `127.0.0.1`，实际可表示的 `http://127.0.0.2:8080/` 会错误显示手机打开入口。现对 Foundation 解码后的 host 使用本机地址解析，排除整个 127/8、短式/十六进制 IPv4、localhost 根点/子域，以及 IPv6 回环和映射的 127/8；不执行 DNS 查询，不隐藏正常远程域名、局域网或非回环 IPv6。发布、健康、同步和无凭据条件保持。新增一个 XCTest 含 16 个拒绝与 10 个保留断言；Windows 语法检查不等于 Foundation/Swift/XCTest 通过，实际 macOS 验证尚待执行。

本机两份 Swift 语法解析退出 0（`.git/opt-f3-loopback-swift-final.log`），diff whitespace 与 staged 质量入口退出 0；本项无适用 Biome 文件，实际检查数为 0（`.git/opt-f3-loopback-quality.log`）。没有用其他语言镜像地址解析来替代原生 XCTest。

## 2026-11-14 回环链接验证与费用来源说明

[PR #114](https://github.com/Xiejiayun/artoo/pull/114) 普通合并为 `a73e7c0ec0ea13d41e58308efe49eb543a4b7bb2`（实现 `2fe95d2`），随后 fetch、切换 main、pull --ff-only，再创建本项分支。合并前 [run 43555955145](https://github.com/Xiejiayun/artoo/actions/runs/43555955145) 已实际完成 Xcode 26.3 编译和全部 200 项原生单元测试；新增回环地址用例通过，04:27:22 UTC unit suite 结束，明确 `TEST EXECUTE SUCCEEDED`。共享 38 项（Web 55/认证 6）及 Mac 安装 18/恢复 8 项独立工件核验通过，进程关闭和清理完成；证据 `.git/opt-pr114-43555955145/`。当时完整 iOS UI/publisher 和两个 Vitest 分片尚未结束，Windows 安装 UI 条件跳过；不称整个 workflow 或最终验收通过。

F2 公开来源进一步确认 Claude `total_cost_usd` 是客户端估算、恢复会话时可包含此前活动；旧 Usage 未声明准确账单、增量范围或全部 Goal 阶段覆盖。现只修正 Web/iOS 的 reported cost、来源和范围说明，保留旧数字、缺失/零值和 wire 行为，并在[计量决议](cost-metering-contract.md)记录官方来源。费用实际计量、事务账本、受保护 Profile、全部阶段准入和预算 UI 仍未实现，`max_cost_usd` 继续拒绝；没有新的 Provider 调用或账户操作。

Node 24 根 typecheck、Web build、4 文件 28 项费用展示/适配器/预算/执行拒绝回归及 4 文件 staged 质量全部通过，实际进程 close 均为 0/null，源码保持（`.git/opt-usage-2026-11-14T04-35-42-274Z/`）。适配器与领域契约的完整可执行 AST 和 main 一致。按 C4 格式化三个既有文件；首轮质量三项格式错误保留。首次文本式发射 JS 比对因格式/尾逗号差异而中止，尚未执行任何产品测试；随后完整 AST 比对通过。Swift 解析保留基线已有的一个诊断，完整源文字复原比对证明仅上述提示/标签变化，无其他代码变化（`.git/opt-usage-swift-preservation.log`）；不能称本项 Swift 编译或原生 UI 通过。

PR #113 的完整原生 run 此后结束为失败：原始 xcresult 中 core 7、assistant 1、mentions 1、correction 1 共十项通过，retention 1 项失败，无跳过。首次 `/observations` 返回 HTTP 500，内部保留 `TypeError: fetch failed`，未保存 cause，尚不能断言 DNS、超时或共同慢因。29 个门禁中该原生聚合失败，其余通过；publisher 未执行。原始导出、65 张 PNG、精确用例身份、记录的 post-XcodeGen 源码稳定性及全部父/原生进程关闭与非强制清理独立复核，证据 `.git/opt-pr113-43548201742/verified-ios-completed.json`。原两项 Vitest 首轮失败仍保留；已在 run 结束后只重跑失败分片，结果尚待完成。不删除断言、不增加时限、不将针对性成功写成完整验收。

## 2026-11-14 原生观察请求与截图证据补充

费用来源说明通过 [PR #115](https://github.com/Xiejiayun/artoo/pull/115) 普通合并为 `fcf2a3e1aaf9f9f5e5227df5320d27a6b21ef6fd`（实现 `8e1f7b3`），随后 fetch/pull 干净 main，再创建本项分支。此时该 PR 完整 CI 仍运行，changed 质量已通过；不将本地 28 项回归视作整个 CI 或原生通过。

针对已保留的 retention `/observations` HTTP 500，为内部请求添加纯诊断观察器：原样返回结果/抛回原错误，记录无查询参数的路由、耗时、中止状态及有限传输错误码/嵌套原因，省略令牌、请求体和异常消息/栈。原 15 秒请求信号/期限、HTTP 与 JSON 校验、suite/父预算、全部业务断言、证据/关闭/清理逻辑保持。CI 的原生附件改为每轮上传 `ios-native-ui-attachments`、保留 14 天，解决成功套件没有独立截图工件的证据缺口；失败 raw xcresult 仍按原规则保留。

Node 24 实际本地 HTTP/socket/中止与错误隐私测试及既有 retention 认证/串行边界/关闭/冷恢复测试 2 文件 11 项全部通过，无跳过（`.git/opt-native-request-tests-final.log`）。3 文件 staged 质量通过；初次检测到已有 finally 内嵌套 throw，改为设置原外层 catch 相同的失败字段并保留退出 1，未跳过断言。完整脚本 AST（仅声明的观察包装和相同失败字段处理）与 main 一致，整个 workflow 复原后与基线逐字相同，仅该附件上传条件/名称/保留天数变化（`.git/opt-native-request-preservation-final.json`）。这项是诊断与证据补充，尚未证明 HTTP 500 根因修复；完整原生重验及最终统一门禁仍待完成。

## 2026-11-14 紧凑窗口的费用说明回归

PR #116 普通合并为 `2516a6089f8799aefd521e7618f634dff49f16dd` 后，原 checkout 冻结该干净 main 串行运行完整四门禁；typecheck/build 已通过，Vitest 和随后完整 Web E2E 尚待结束。另从 fetch 后相同最新 main 创建独立 managed worktree，避免在验证期间切换或修改原源码。

PR #115 的 Mac 安装 E2E 首次在第四次 Run 的 Keep running 后失败：完整运行卡片原 `toBeInViewport({ ratio: 1 })` 得到 `0.945485532283783`。PR #116 的独立 Mac job 同一阶段、同一比例再次失败（`.git/opt-pr116-mac-job.log`）。常驻费用说明撑高运行卡片；现改为原生、默认收起的 Cost reporting limits，保留完整正文及 `aria-describedby`，数字、缺失和零值行为保持。原 Mac 业务流程、断言、5 秒时限和其他测试未修改。

Node 24 根 typecheck、Web build、2 文件 staged 质量全部实际 close 0/null 且源码保持（`.git/opt-compact-usage-checks-2026-11-14T05-13-58-590Z/summary.json`）。首次 staged 检查只报新增断言换行格式，修正后通过。首次 2 worker 聚焦有 3 项通过和 2 个 worker 启动超时，退出 1；保留原工具会话 48408，未放宽期限。随后原三文件单 worker 完整复核 20 项全部通过、退出 0（`.git/opt-compact-usage-unit-recheck.{log,json}`）。

真实 Chromium 148 运行实际 RunTimeline、WorkspaceRetention、RunUsageSummary 和 CSS 的明确标注布局夹具：在 1024×656 窗口、556px 面板中，改动前卡片 591px 无法完整显示，改动后 545px 完整显示并通过原 ratio 1 断言；Enter/Space 展开收起、320px 完整正文可见和无页面横向溢出通过，截图已检查。证据 `.git/opt-compact-usage-layout-2026-11-14T05-14-09-883Z/`。用量是明确 mock，夹具不是实际安装 Mac、账单、Provider 或产品发布验收；合并后的完整原生 Mac 流程仍需 CI 验证。

PR #114 完整三 lane 实际文件与用例集合、六份前后空缓存记录独立核验：611 文件、8,848 通过、90 既有条件跳过、零失败（`.git/opt-pr114-43555955145/verified-vitest-current.json`）。PR #113 只重跑失败 lane 后同一不可变 CI commit 的完整合并结果也通过，原两项首次失败和 iOS retention 失败仍保留（`.git/opt-pr113-43548201742/attempt-2/verified-vitest-combined.json`）。这些结果不代表新布局版本完整 CI 或真实 Provider 验收。

## 后续顺序

P5 首次聚焦 E2E 在创建频道后的首次发送处超时，输入框为空；未改代码重跑通过。既有组件测试已记录列表刷新后到房间校验间会替换 DOM，E2E 现在等待房间校验响应再输入，不改发送/同步断言或超时。连续 3 次通过，证据 `.git/opt-p5-e2e-stable.log`；首次失败保留 `.git/opt-p5-e2e.log`。类型/构建/回归日志分别为 `.git/opt-p5-final-typecheck.log`、`.git/opt-p5-server-build.log`、`.git/opt-p5-web-build.log`、`.git/opt-p5-tests.log`、`.git/opt-p5-client-tests.log`。这不替代最终统一 E2E。

P5 通过 [PR #67](https://github.com/Xiejiayun/artoo/pull/67) 合并为 `53b1d55`（实现 `dabaaea`）。

恢复预检通过 [PR #68](https://github.com/Xiejiayun/artoo/pull/68) 合并为 `a455704`（实现 `03546d9`）。

E1 安装移除合并 → 本机原生验证发现的夹具复核 → 最终统一门禁。C1 本轮选定的职责拆分与其余候选边界评估如上。F2 保留待实现/验收；E4 的最终版本验收与授权并行跟进。

所有条目仍须以最新源码复核适用性。E1 已取得安装移除前后的实际空缓存证据；iOS 原生验收继续跟进 macOS job；E4 产品发布需具备已授权的环境、凭据、受保护 Profile、健康标准和恢复方案。当前未执行新的产品发布，首轮最终统一门禁已执行但失败，后续修复后须重新验证，F2 与 E4 缺口保持。

F2 当前行为回归：`structured-output`、领域预算、Goal 成本拒绝门控 3 文件 25 项通过（`.git/opt-f2-current-behavior.log`）；本次只提交前置设计，不改变 Usage、预算或调度代码。
