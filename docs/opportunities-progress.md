# Opportunities 实施记录

依据 [opportunities.md](../opportunities.md)（2026-11-13）逐项实施。每项从 fetch 后的最新 main 创建独立分支，先回归、再合并并同步 main，下一项重新 fetch。最终集成门禁包含 typecheck、build、完整 Vitest 和 Web E2E；原生客户端与真实 Provider 验收分别记录，不能由夹具替代。

## 完成与进行中

| 编号 | 状态 | 范围与验证 |
| --- | --- | --- |
| F1 | 已有能力，无需重复 | 方案已更正 DAG 证据门控结论，保留现有行为。 |
| P4 | 已实现并验证 | 集中查询键，补齐 Goal 相关事件失效与项目订阅；自动化和静态发布轮询在线退避。应用发布保留 5 秒轮询及本地健康时效判断。根 typecheck、Web build 通过；完整 Web 单元/组件回归 60 文件、574 项通过；新增实时事件/退避回归所在两文件 23 项通过。 |
| X2 | 已实现并验证 | 按当前项目任务 ID 关联组织级审批，徽标可筛选并打开真实任务（包含 ready 执行审批）；合并重复缓存记录，支持显示全部及审批清空状态。根 typecheck、Web build 通过；LeftRail/TaskList/WorkspaceLayout/ApprovalInbox 4 文件、15 项通过。 |
| E4 | 环境盘点完成，最终验收待执行 | [验收准备与证据要求](opportunities-acceptance-2026-11-13.md)。当前进程缺少 live 参数，默认安装清单不存在；已询问可沿用的已授权测试配置。全部优化后重新冻结最终版本，本项仍未完成。 |
| P1 | 已实现并验证 | 实例/电脑 Presence 批量查询，SQL 排除终态，保持组织/撤销/队列/状态语义。[测量](presence-performance-2026-11-13.md)：20 实例/4 电脑/1,020 Run，查询数 81→5、13→4；返回行 1,080→48、1,028→28。5 文件 52 项通过；根 typecheck、server build 通过。 |
| P2 | 已实现并验证 | 追加 0061 迁移与匹配 schema，增加任务消息/最新 Run 排序索引及共用非终态部分索引。[查询计划与成本](presence-indexes-2026-11-13.md)及可复现脚本已记录；根 typecheck、server build、10 文件 53 项回归通过。独立 Postgres 与写入吞吐未测量。 |
| P3 | 已实现并验证 | 最新 Run 批量读取、每 Run LATERAL 制品上限，Goal 审计按 20 任务批量装配；保持隔离、脱敏、排序与截断。[测量](evidence-query-batching-2026-11-13.md)：101 边交接 204→10 次查询，45 子任务审计 501→36 次。根 typecheck、server build、7 文件 27 项回归通过。 |
| X1 | 已实现并验证 | 顶部新增 Workspace 入口，根路径独立激活、面包屑明确，移除 Board 借壳高亮；窄屏导航隐藏编号并允许内部滚动。根 typecheck、Web build、2 文件 5 项组件回归及真实浏览器聚焦 E2E 通过。覆盖键盘与 320/390/1024/1180/1440px，无页面横向溢出，320/1440px 截图已人工检查。 |
| P5 | 批次优化已合并，其余待补齐 | 可选 v1 bootstrap 能力协商可见性批次 100→500；保留增量、根回复快照及全部缓存移除核对，未知能力回退 100。[兼容与测量范围](message-reconciliation.md)：250 条缓存刷新 5→3 请求（组件 mock）。根 typecheck、server/Web build、6 文件 71 项通过；跨浏览器线程同步/刷新 E2E 连续 3 次通过。仍须建立可验证的稳定同步状态再减少稳定在线快照，并补充真实 HTTP 请求耗时测量。 |
| E1 | 首轮出现失败，待重验 | Windows / Node 24 第一分片的 storage 四案例套件报告一项失败，已停止该轮实验并确认 Vitest 进程退出；第二分片、进程分区和覆盖聚合未执行。[方法与结果](ci-vitest-browser-validation-2026-11-13.md)。先聚焦核对恢复链，再按最终源码重新执行完整分区；尚未删除安装步骤。 |
| E1 前置修复 | 已实现并验证，待合并 | 损坏附件在恢复数据库启动前拒绝，有效附件仍只流式复制一次。真实大附件回归先红后绿；原四案例和附件回归共 2 文件、5 项通过，根 typecheck、server build 通过。超时清理父 harness 1 项通过，核验子进程故意 5 失败、2 通过及实际关闭和安全清理，证据单独记录。完整冷分片仍须重新执行。 |

P4 合并为 `172d1f0`（实现 `f59fbf9`）。远程在该次直接推送提示 PR 保护要求，后续均走普通 PR 合并；不使用 admin/bypass。每项本地验证与远程 CI 状态分别报告；CI 未结束不能视为通过。

X2 通过 [PR #61](https://github.com/Xiejiayun/artoo/pull/61) 合并为 `235133c`（实现 `e0a4750`）。

E4 的环境准备通过 [PR #62](https://github.com/Xiejiayun/artoo/pull/62) 合并为 `e61992b`。P1 通过 [PR #63](https://github.com/Xiejiayun/artoo/pull/63) 合并为 `8dfab8c`（实现 `6cd97fc`）。

P2 通过 [PR #64](https://github.com/Xiejiayun/artoo/pull/64) 合并为 `fa2deb8`（实现 `c086f08`）。

P3 通过 [PR #65](https://github.com/Xiejiayun/artoo/pull/65) 合并为 `ffbaf6d`（实现 `e4a8719`）。X1 首轮组件测试在并行构建时发生既有 Skills 懒加载查找超时；无修改断言/超时，单 worker 复跑 5 项全通过。日志：`.git/opt-x1-final-tests.log`、`.git/opt-x1-typecheck-final.log`、`.git/opt-x1-build.log`、`.git/opt-x1-e2e.log`。浏览器证据目录：`apps/web/test-results/workflows-2026-11-13T12-33-02-018Z`；该聚焦 E2E 不替代最终统一验收。

## 后续顺序

P5 首次聚焦 E2E 在创建频道后的首次发送处超时，输入框为空；未改代码重跑通过。既有组件测试已记录列表刷新后到房间校验间会替换 DOM，E2E 现在等待房间校验响应再输入，不改发送/同步断言或超时。连续 3 次通过，证据 `.git/opt-p5-e2e-stable.log`；首次失败保留 `.git/opt-p5-e2e.log`。类型/构建/回归日志分别为 `.git/opt-p5-final-typecheck.log`、`.git/opt-p5-server-build.log`、`.git/opt-p5-web-build.log`、`.git/opt-p5-tests.log`、`.git/opt-p5-client-tests.log`。这不替代最终统一 E2E。

P5 通过 [PR #67](https://github.com/Xiejiayun/artoo/pull/67) 合并为 `53b1d55`（实现 `dabaaea`）。

E1 → P5 同步状态与耗时验证 → U2 → U3 → U1 → U4 → X3 → X4 → P6 → P7 → C4 → E2 → F3 → F4 → F2 → C1 → C2 → C3 → E3 → X5 → F5 → C5。E4 的最终版本验收与未就绪环境并行跟进。

所有条目仍须以最新源码复核适用性。E1 必须在无浏览器缓存的真实 Windows 分片通过后才移除安装步骤；iOS 原生验收需要 macOS；E4 产品发布需具备已授权的环境、凭据、受保护 Profile、健康标准和恢复方案。当前未执行新的产品发布，尚未运行最终统一 E2E。
