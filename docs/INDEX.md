# 文档地图

先从[仓库 README](../README.md)了解产品，再按本页选择当前指南。
[AGENTS.md](../AGENTS.md)规定架构边界与必需检查；可执行命令以
[package.json](../package.json)、[工作流](../.github/workflows/)和
[脚本地图](../scripts/README.md)为准。文档中的成功结果只适用于其明确绑定的版本和环境。

## 现行架构与契约

| 主题 | 入口与范围 |
| --- | --- |
| 总体架构 | [产品设计](../design.md)、[Agent Team 开发](agent-team-development.md)、[Windows 原生执行](windows-native-development.md) |
| 团队与工作 | [项目 Squad](project-squads.md)、[Agent 规划](agent-planning.md)、[手动计划与草稿](plan-drafts.md)、[资源生命周期](resource-lifecycle.md)、[Agent 历史](agent-history.md) |
| 协作与数据边界 | [跨客户端同步](cross-client-sync.md)、[AI 数据共享](ai-data-sharing.md)、[内容治理](content-moderation.md)、[内联提及](inline-mentions.md) |
| 查询与证据 | [服务端搜索](server-search.md)、[消息对账](message-reconciliation.md)、[Skill 发现](skills-discovery.md)、[审计签名](audit-signing.md) |
| 工作区与恢复 | [Git 结果](worktree-results.md)、[工作与恢复报告](workspace-recovery.md)、[自动源码交接](automatic-source-handoff.md)、[Windows 源码节点](windows-native-source-nodes.md) |
| 应用编译与执行 | [固定编译包](application-compiler-entry.md)、[本地应用服务](application-local-service.md)、[Broker Profile 检查](application-broker-profile-check.md)、[Owned target 输入](windows-owned-target-input.md)、[原生开发验证](application-development-verification.md) |
| 发布契约 | [目标产品发布](product-publication.md)、[有界本地应用发布](application-publication.md)；按各自支持范围使用，不以静态站点成功推断后端/数据库发布成功 |
| 成本预算前置设计 | [计量契约与启用门槛](cost-metering-contract.md)：尚未实现可信账本与成本预算启用，不是现行 wire schema |
| 代码与 Web 规范 | [渐进代码质量](code-quality.md)、[UI 系统](ui-system-spec.md)、[CSS 归属](web-css-ownership.md)、[全局命令](command-palette.md) |

## 运维与发布 Runbook

| 场景 | 入口 |
| --- | --- |
| 共享预览部署与维护 | [共享服务](shared-server.md)、[预览运维：配对/备份/恢复](preview-operations.md)、[小团队预览交付](trusted-team-preview.md) |
| Windows/Linux 节点接入 | [npm daemon 使用](npm-daemon-setup.zh-CN.md)、[打包与验证](../scripts/npm-daemon/README.md) |
| Web 与云端基础设施 | [Web/Windows 部署方案](web-deployment-plan.zh-CN.md)、[Azure 调度](azure-deployment.md)、[Azure Container Apps/Supabase](azure-container-apps.md)、[GitHub Actions 发布](github-actions-production-release.md) |
| Windows 单需求安装 | [本地入口与停止约定](../scripts/windows-local-request/README.md) |
| 审计密钥 | [生成、分发、轮换、撤销及离线验签](audit-signing.md) |
| 门禁与验收 | [脚本入口](../scripts/README.md)、[v1 发布门禁](v1-release-gates.md)、[Apple 发布就绪](apple-release-readiness.md)、[E4 最终产品验收准备](opportunities-acceptance-2026-11-13.md) |

执行部署、密钥更换或数据恢复前，遵循对应 Runbook 的环境、权限、版本、健康检查和恢复要求。
源码检查、受控夹具、真实 Provider、签名分发与生产部署分别保留证据。

## 客户端指南

- Apple：[Mac/iOS E2E](apple-client-e2e.md)、[开发归档](apple-development-archive.md)、
  [App Store 分发](ios-app-store-distribution.md)、[审核准备](ios-app-review.md)。
- 已安装真实 Provider：[Mac 验证](mac-live-provider-verification.md)、
  [Windows 验证](windows-copilot-verification.md)；配置与受保护 Profile 是执行前置条件。
- 客户端功能与覆盖：[协作 UI](native-collaboration-ui.md)、
  [工作管理 UI](native-work-management-ui.md)、[工作流覆盖](apple-client-workflow-coverage.md)、
  [iOS 发布/历史/Goals](ios-release-history-2026-11-14.md)、
  [通知解码](ios-notification-decoding-2026-11-14.md)。

## 版本化验证与测量记录

这些记录包含具体基线、方法、失败和局限。查验当前状态时先看
[opportunities 实施记录](opportunities-progress.md)与
[E4 验收状态](opportunities-acceptance-2026-11-13.md)，再核对实际提交与输出。

- 性能：[Presence 批量读取](presence-performance-2026-11-13.md)、
  [索引](presence-indexes-2026-11-13.md)、[证据查询](evidence-query-batching-2026-11-13.md)、
  [消息对账](message-reconciliation-performance-2026-11-13.md)、
  [预算监视](budget-monitor-2026-11-14.md)。
- Web：[CSS 验证](web-css-validation-2026-11-13.md)、[成功反馈](ui-feedback-2026-11-13.md)、
  [连接状态](connection-status-2026-11-13.md)、[首次加载](loading-states-2026-11-13.md)。
- 工程：[Windows 冷浏览器缓存实验](ci-vitest-browser-validation-2026-11-13.md)、
  [依赖升级](dependency-upgrades.md)、[优化原始清单](../opportunities.md)、
  [首轮优化待办](optimization-backlog-2026-11-13.zh-CN.md)。
- 客户端：[验证里程碑](apple-client-milestones.md)、
  [2026-10-08 收尾](apple-client-closeout-2026-10-08.md)、
  [2026-10-10 收尾](apple-client-closeout-2026-10-10.md)、
  [执行修正尝试](apple-execution-correction-attempts.md)、
  [2026-11-09 Web/Windows 收敛](release-convergence-2026-11-09.md)。

## 历史里程碑与设计计划

以下保留原路径，便于追溯决策；计划和历史验收不能替代当前实现或发布资格。

| 类别 | 记录 |
| --- | --- |
| 早期自治研发 | [首个工作区里程碑](autonomous-development.md)、[2026-11-03 能力评估](autonomous-product-development-assessment-2026-11-03.md)、[2026-11-12 协作方案](agent-collaboration-design-and-implementation-2026-11-12.zh-CN.md) |
| 产品版本规划 | [v1 路线](v1-roadmap.md)、[v1 候选审计](v1-release-candidate.md)、[v2 路线](v2-roadmap.md)、[Android 计划](v2-android-plan.md)、[v3 产品](v3-product-plan.md)、[v3 Apple](v3-ios-mac-client-plan.md)、[Apple UX](v3-apple-client-ux-implications.md) |
| 历史专项设计 | [Presence](v3-113-presence-design.md)、[Goals schema](v3-115-goals-schema-design.md)、[Goal 审计发布记录](v3-140-goal-audit-bundle.md) |
| UI 演进 | [协作改版](collaboration-ui-refresh.md)、[产品改版](product-ui-refresh.md)、[体验交付](experience-redesign-2026-11-11.md)、[Server/UI 契约地图](server-ui-contract-map.md)、[Production UI gate](production-ui-gate.md) |
| 原始实施计划 | [superpowers/plans/](superpowers/plans/)：按日期保留的历史计划，执行前复核源码、现行指南和授权 |

新增指南时将其加入对应主题；把一次性的运行结果写进有日期/版本边界的记录并从指南链接。
不为整理目录移动已有文档或改写其历史结论。
