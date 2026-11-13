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

F4 通过 [PR #82](https://github.com/Xiejiayun/artoo/pull/82) 合并为 `7aff640`（实现 `a161b70`）。随后该 PR 的远程 changed、postgres、image job 成功；其余 job 尚未完成，不视为整个 CI 已通过。postgres job 不替代真实 Provider 或生产迁移验收。

F2 前置设计已明确 [计量契约与启用门槛](cost-metering-contract.md)：绑定执行/Provider 会话/Profile 的精确累计计量、revision/修正、事务幂等、unknown 与恢复、全部 Goal 阶段覆盖和“暂停后续调度”语义。当前 Codex 无费用、Claude 终态观测及旧 Usage upsert 均不足以提供该保证；保留拒绝 max_cost_usd，不将未知计为 0。**F2 实际计量/账本/成本准入/UI 尚未完成**，不能用设计文档标记该功能完成；缺少已验证的完整来源能力时继续其他独立项。

## 后续顺序

P5 首次聚焦 E2E 在创建频道后的首次发送处超时，输入框为空；未改代码重跑通过。既有组件测试已记录列表刷新后到房间校验间会替换 DOM，E2E 现在等待房间校验响应再输入，不改发送/同步断言或超时。连续 3 次通过，证据 `.git/opt-p5-e2e-stable.log`；首次失败保留 `.git/opt-p5-e2e.log`。类型/构建/回归日志分别为 `.git/opt-p5-final-typecheck.log`、`.git/opt-p5-server-build.log`、`.git/opt-p5-web-build.log`、`.git/opt-p5-tests.log`、`.git/opt-p5-client-tests.log`。这不替代最终统一 E2E。

P5 通过 [PR #67](https://github.com/Xiejiayun/artoo/pull/67) 合并为 `53b1d55`（实现 `dabaaea`）。

恢复预检通过 [PR #68](https://github.com/Xiejiayun/artoo/pull/68) 合并为 `a455704`（实现 `03546d9`）。

C1 → C2 → C3 → E3 → X5 → F5 → C5 → E1 完整分区重验。F2 保留待实现/验收；E4 的最终版本验收与未就绪环境并行跟进。

所有条目仍须以最新源码复核适用性。E1 必须在无浏览器缓存的真实 Windows 分片通过后才移除安装步骤；iOS 原生验收需要 macOS；E4 产品发布需具备已授权的环境、凭据、受保护 Profile、健康标准和恢复方案。当前未执行新的产品发布，尚未运行最终统一 E2E。

F2 当前行为回归：`structured-output`、领域预算、Goal 成本拒绝门控 3 文件 25 项通过（`.git/opt-f2-current-behavior.log`）；本次只提交前置设计，不改变 Usage、预算或调度代码。
