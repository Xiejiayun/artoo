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

P4 合并为 `172d1f0`（实现 `f59fbf9`）。远程在该次直接推送提示 PR 保护要求，后续均走普通 PR 合并；不使用 admin/bypass。每项本地验证与远程 CI 状态分别报告；CI 未结束不能视为通过。

X2 通过 [PR #61](https://github.com/Xiejiayun/artoo/pull/61) 合并为 `235133c`（实现 `e0a4750`）。

E4 的环境准备通过 [PR #62](https://github.com/Xiejiayun/artoo/pull/62) 合并为 `e61992b`。P1 通过 [PR #63](https://github.com/Xiejiayun/artoo/pull/63) 合并为 `8dfab8c`（实现 `6cd97fc`）。

## 后续顺序

P3 → X1 → P5 → E1 → U2 → U3 → U1 → U4 → X3 → X4 → P6 → P7 → C4 → E2 → F3 → F4 → F2 → C1 → C2 → C3 → E3 → X5 → F5 → C5。E4 的最终版本验收与未就绪环境并行跟进。

所有条目仍须以最新源码复核适用性。E1 必须在无浏览器缓存的真实 Windows 分片通过后才移除安装步骤；iOS 原生验收需要 macOS；E4 产品发布需具备已授权的环境、凭据、受保护 Profile、健康标准和恢复方案。当前未执行新的产品发布，尚未运行最终统一 E2E。
