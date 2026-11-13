# Opportunities 实施记录

依据 [opportunities.md](../opportunities.md)（2026-11-13）逐项实施。每项从 fetch 后的最新 main 创建独立分支，先回归、再合并并同步 main，下一项重新 fetch。最终集成门禁包含 typecheck、build、完整 Vitest 和 Web E2E；原生客户端与真实 Provider 验收分别记录，不能由夹具替代。

## 完成与进行中

| 编号 | 状态 | 范围与验证 |
| --- | --- | --- |
| F1 | 已有能力，无需重复 | 方案已更正 DAG 证据门控结论，保留现有行为。 |
| P4 | 已实现并验证 | 集中查询键，补齐 Goal 相关事件失效与项目订阅；自动化和静态发布轮询在线退避。应用发布保留 5 秒轮询及本地健康时效判断。根 typecheck、Web build 通过；完整 Web 单元/组件回归 60 文件、574 项通过；新增实时事件/退避回归所在两文件 23 项通过。 |
| X2 | 已实现并验证 | 按当前项目任务 ID 关联组织级审批，徽标可筛选并打开真实任务（包含 ready 执行审批）；合并重复缓存记录，支持显示全部及审批清空状态。根 typecheck、Web build 通过；LeftRail/TaskList/WorkspaceLayout/ApprovalInbox 4 文件、15 项通过。 |
| E4 | 环境未就绪，最终验收待执行 | [验收准备与证据要求](opportunities-acceptance-2026-11-13.md)。当前进程缺少 live 参数，默认安装清单不存在；操作者回复不清楚可沿用的测试配置。补查仓库 artifacts 与本机 Artoo 目录未发现安装/candidate 清单。全部优化后重新冻结最终版本，本项仍未完成。 |
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
| E1 | 完整第一分片失败，后续重验 | #68 后 Windows / Node 24 第一分片完整运行：292 文件通过、1 失败、3 跳过；唯一失败为 server-entry 的 30 秒 readiness，单文件复核亦失败。存储四案例及附件回归通过。[方法与结果](ci-vitest-browser-validation-2026-11-13.md)。第二分片、进程分区和覆盖聚合未执行，安装步骤保留；完整冷验证移至后续集成版本。 |
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

## 后续顺序

P5 首次聚焦 E2E 在创建频道后的首次发送处超时，输入框为空；未改代码重跑通过。既有组件测试已记录列表刷新后到房间校验间会替换 DOM，E2E 现在等待房间校验响应再输入，不改发送/同步断言或超时。连续 3 次通过，证据 `.git/opt-p5-e2e-stable.log`；首次失败保留 `.git/opt-p5-e2e.log`。类型/构建/回归日志分别为 `.git/opt-p5-final-typecheck.log`、`.git/opt-p5-server-build.log`、`.git/opt-p5-web-build.log`、`.git/opt-p5-tests.log`、`.git/opt-p5-client-tests.log`。这不替代最终统一 E2E。

P5 通过 [PR #67](https://github.com/Xiejiayun/artoo/pull/67) 合并为 `53b1d55`（实现 `dabaaea`）。

恢复预检通过 [PR #68](https://github.com/Xiejiayun/artoo/pull/68) 合并为 `a455704`（实现 `03546d9`）。

C1 → C2 → C3 → E3 → X5 → F5 → C5 → E1 完整分区重验。F2 保留待实现/验收；E4 的最终版本验收与未就绪环境并行跟进。

所有条目仍须以最新源码复核适用性。E1 必须在无浏览器缓存的真实 Windows 分片通过后才移除安装步骤；iOS 原生验收需要 macOS；E4 产品发布需具备已授权的环境、凭据、受保护 Profile、健康标准和恢复方案。当前未执行新的产品发布，尚未运行最终统一 E2E。

F2 当前行为回归：`structured-output`、领域预算、Goal 成本拒绝门控 3 文件 25 项通过（`.git/opt-f2-current-behavior.log`）；本次只提交前置设计，不改变 Usage、预算或调度代码。
