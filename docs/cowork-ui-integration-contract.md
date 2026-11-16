# Cowork UI 联合接入契约

2026-11-16，实施基线 `80c43bb89b4e909df8207df773eb88f2cef755f9`。
本文件固定并行任务接缝，不表示实现或验收通过。
详细范围见 [联合实施计划](cowork-ui-scheduler-implementation-2026-11-16.md)。

## 文件归属与接线

| 执行线 | 写入范围 | 共享文件约定 |
| --- | --- | --- |
| Web | `apps/web/src/{app,components,ui}`、样式与 Web 构建依赖 | 主线只增加 ApiClient 的 `getProjectControlView`；组件消费真实数据，不移植模拟 World |
| Server | scheduler 生命周期协议、服务、资源/发布后台、追加迁移 | domain/protocol index 采用可合并的独立 export；迁移序号由此线统一分配 |
| Node | `apps/artood/src` 的唯一 Run owner、managed journal、workspace、Runtime | 与 Server 约定生命周期接缝；主线不并发改 `node-client.ts` |
| 主线 | `domain/control-view.ts`、`control-view-routes.ts`、`services/control-view-service.ts`、Web API 方法及任务记录 | `app.ts` 只追加 route registrar；每次合并保留双方独立注册 |

## UI 读取边界

已实现 `GET /api/v1/projects/:id/control-view?limit=&after=&capacity=true`，返回直接的
`ProjectControlViewV1` 对象，客户端方法为 `getProjectControlView(projectId, options?)`。
这是 tenant/project 范围的只读快照：有界任务分页、任务最新 Run、非秘密租约观察、
执行请求状态、历史调度说明与项目总量。原始 Task/Run 状态和最新尝试的失败记录保持。
分页顺序为不可变 Task ID 降序；`page.next_after` 只能用于原组织和项目。
`capacity=true` 才读取完整的保留占用快照，普通刷新返回 `occupied:null` 和
`source:not_requested`。前端使用 `projectControlView` 查询前缀失效及降级轮询。
队列/容量的历史观察与当前准入判断分别标记；没有事实的字段返回 unknown/null，
不通过前端计时器生成排队原因、执行进度或成功结果。统计不能从当前分页冒充项目总量。

此读取不返回 credential/hash/ContextPack/远程命令，不创建调度决策或改变 Run、
租约和资源占用。返回的租约到期时间只是观察值，不是物理启动或继续执行权限。
现有 bootstrap、TaskSnapshot、事件/消息读取和人工操作继续保留。

## 显示与命令

- backlog/ready、assigned、running、review、done、cancelled 保留精确状态，
  awaiting_approval/blocked 单独可见；失败是 Run 尝试结果，不能改写公共 Task 枚举。
- 现有四级优先级、UI 选择状态、项目/Task/Run URL 与 React Query 实时失效继续使用。
- 登录、配对、接受计划、提问回复、评审、重试、取消及发布调用现有可信 owner。
  新字段/接口显式版本化；失败不把本地状态改成成功。
- 新生命周期与 Stop 权限独立于 `scheduler.attempt-renew.v1`。
  Server/Node 接线保留请求、用户、项目、Run、epoch、原会话和实际进程证据绑定。
- UI 中机器在线/硬件/已安装 CLI 来自节点；排空是独立管理准入设置。
  不提供电脑开机、关机、重启、唤醒或电源 API；排空显示为“暂停接收新任务”，
  不停止已有 Run。任务 Stop 仅停止该任务的执行进程。
  逻辑 Agent、机器上的实例与项目 Squad 不互相隐式替代。
- 发布目标由实际受保护配置决定；人类评审通过不会自动授予合并/部署权限。
  成本预算继续关闭。

## 当前执行状态

- T00：来源、状态投影、文件归属和接口边界已记录；各线实施中继续补齐具体 schema。
- Web：T01 新壳/导航/登录已通过 [PR #161](https://github.com/Xiejiayun/artoo/pull/161) 合入 main，待最终验证；T02 实施中。
- Server：T09 独立生命周期，之后资源/claim/reaper/发布。
- Node：T10 原始启动窗口与自动续租接入唯一物理 owner，之后隔离/恢复/平台/Runtime。
- 主线：T08 只读联合视图、ApiClient、实时失效与回归用例已实现，待最终验证；每项可审阅结果以独立提交/PR 正常合入 main。

按用户最新指令，中间不主动验证；最终统一执行 T19 的完整验证，所有中间结果标为未验证。
真实 Provider 安装、两台实际机器与目标发布配置仍需独立环境证据；不能用 UI 模拟补足。
