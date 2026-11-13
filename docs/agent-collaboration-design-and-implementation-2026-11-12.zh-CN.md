# Artoo Agent 协作能力设计与实现方案

初稿日期：2026 年 11 月 12 日。更新日期：2026 年 11 月 13 日。版本：1.3，复核 main，补齐 Memory 复用、发言溯源和上下文批量读取，供分阶段实现。

本方案以 Artoo main 提交 `f059225` 为复核基线，结合已有 Multica、Paperclip、Codex 和 Claude Code 架构分析，设计可分批交付的团队协作增量。该基线在 v1.2 后没有新增功能代码；本轮深入复核已有 Memory、多人对话来源和依赖上下文查询。相对 v1.0，#53–#55 的 Agent 历史 API、工具活动与 Web 历史界面已纳入复用范围。文中的新增表、接口和能力仍需代码实现；文档合入不代表功能实现、测试通过或产品发布。

建议沿用现有控制面与节点执行架构。先复用现有记录完成上下文说明、结构化交接和负责人入口，再按技术门槛增加模型容量准入；新执行入口仍先落实资源授权，之后接代码结果、技能、有界委派和自动化。优先减少重复输入与无效协调调用，高 ROI 排序及收益验证见 12.3 和 13.2。

## 1 目标与范围

新增执行入口的首个交付目标：用户在项目 Thread 中明确请求某个 Agent 工作，发送前看到触发预览；请求持久化，投递重试不新建 Run，进程身份不确定时阻塞重复启动；排队后撤权能阻止后续执行；Task 能展示精确提交上的 PR 与 CI 状态。

后续目标：固定本次运行使用的 Skill 版本；在已接受计划中公开委派已有任务；按明确授权定时或因事件重新检查工作。

优先补齐两个日常使用缺口：用户面向一个 Squad 负责人完成规划与跟进；不同模型只接收适合自身窗口的、来源可追溯的上下文。共享频道提供协作记录，不能承诺每个 Agent 都自动记住全部历史。

保留以下约束：

- `packages/domain` 定义契约，`packages/protocol` 定义传输，`packages/db` 定义 schema 与追加迁移；Server 负责授权与编排，artood 负责节点执行与证据。
- GoalRunner 拥有持久化规划和目标任务调度；AssistantDispatcher 继续处理普通对话队列。新增入口连接已有所有者。
- Agent、AgentInstance、Computer、Runtime 保持独立；实例最多属于一个项目的 Squad。
- 原始用户授权与 system 决策归因分开保存；模型提案不能增加权限。
- `run.verification` 由节点产生；验证命令来自受保护的本地 profile，保持请求、profile、Run、源码摘要与真实进程退出绑定。
- 独立评审和产品发布保持各自的授权、证据与执行器。PR 合并只是代码集成事实。
- 当前单 Server 所有者和数据库独占写入锁保持有效；本方案不引入多副本或 Redis。

首版不实现运行中任意插入指令、停止后重开、任意 Skill 脚本和 MCP 配置分发、插件市场、大量 CLI 适配、自动合并或自动部署。没有可靠计量时不承诺美元费用硬上限。

### 1.1 首版支持矩阵

| 路径 | 首版支持条件 | 不满足时的行为 |
| --- | --- | --- |
| 普通 Thread 请求 | 当前项目、普通对话、现有可执行实例和全部授权 | 解释拒绝或按现有规则等待 |
| 普通 Task 指派 | ready、当前前置摘要、原审批/策略/租约检查 | 事务回滚，不创建排队占位来承诺一定执行 |
| 规划、产品阶段、独立评审 | 继续原有专用入口；共享资源检查接入 | 不从新通用入口插入或替换固定参与者 |
| 指令技能 | 逐 runtime 与执行模式完成只读交付资格验证 | 必需技能阻塞；普通未选技能任务不受影响 |
| Squad 委派 | 显式 collaboration grant、已接受计划、允许的任务/角色和合格只读协调者 | 未合格的产品阶段或手工 Goal 不提供该入口 |
| 周期/内部事件 | 首版仅 reconcile_goal，原 GoalAutomation 和原始授权仍有效 | 暂停/终态 Goal 跳过；不创建新目标或直接改派任务 |
| 统一负责人 | 复用原规划参与者和授权；控制轮次另需 C1 grant | 保留原两参与者规划和固定评审要求，不能降为单 Agent 自评 |
| 上下文适配 | 已确认实际模型、渲染方式与受保护预算；按执行模式验收 | 必需信息放不下时阻塞新适配路径，旧手工模式保留并标注未适配 |

平台支持范围以实际 runtime、操作系统、执行模式和节点能力组合记录；某一种普通 Codex 调用通过，不代表 Claude、独立评审或产品阶段也已合格。

## 2 竞品机制与取舍

以下事实来自用户已有分析快照，未将其描述为竞品的最新线上行为。

| 资料 | 值得借鉴的机制 | Artoo 的落地选择 |
| --- | --- | --- |
| Multica，资料截至 2026-11-10 | 触发预览、Agent 与 Runtime 使用权、公开 Squad 委派、Skill 文件交付、PR/CI、定时唤醒 | 显式请求执行；委派走结构化提案与现有计划；技能先只读；外部 CI 与节点验证分别展示 |
| Paperclip，2026-11 架构分析 | 持久化唤醒意图、原子签出、结构化等待、有界恢复、治理在服务端强制 | 请求来源可追溯；复用 Task/Run/Goal 状态；等待展示阻塞对象与动作；预算按可实施的次数和时长控制 |
| Codex，2026-11 架构图 | 协议入口与核心运行时分离、Thread/Turn/Item、持久会话、权限与沙箱约束 | 保持 RuntimeAdapter 窄接口；按能力和版本协商；普通对话与产品阶段上下文分开 |
| Claude Code，2026-11-10 架构图 | Harness 控制工具、上下文与权限；Skill 按需读取；子代理上下文隔离 | 平台权限由可信边界执行；技能准备与实际读取分开；独立评审不继承作者的可执行环境 |

不照搬竞品的默认宽权限、评论隐式启动、去除数据库外键或只按模型输出推进任务。Paperclip 的费用治理启发预算设计，但 Artoo 目前没有对应的可靠费用计量，不能直接宣称具备同样能力。

## 3 当前 main 的基础与缺口

| 领域 | 已确认基础 | 设计增量 |
| --- | --- | --- |
| 对话 | AssistantTurn 持久队列、`client_request_id` 去重、串行 pump、重发同一 Run | 触发预览、统一来源绑定、稳定等待原因、未启动输入合并 |
| 项目隔离 | 项目 Squad、显式实例和规划参与者项目检查已经合入 | 项目协调者配置与有界委派；不重复建设实例归属 |
| 资源生命周期 | 到期、停用、墓碑删除；活跃或退出不确定时阻止删除 | 资源管理权与 Agent/机器使用权分离 |
| Skills | 安装 manifest、本地元数据发现、搜索和实例匹配已经合入 | 固定内容版本、Agent 绑定、节点准备、逐 Run 追溯 |
| Goal/Plan | 已有规划、接受、分阶段执行、预算、独立评审与恢复；main #47 改进 Web 入口 | 接入新入口并保留原执行模式；不创建平行的目标调度器 |
| 结果 | patch/PR 产物与 integration_queue | 仓库绑定、可信 PR 关联、精确 head SHA 的外部状态 |
| 基础设施 | event_log、游标回放、TanStack Query、单数据库所有者 | 增加领域事件和读模型；可靠副作用不依赖在线 WebSocket |
| Agent 历史 | 跨实例 Run 历史、原 ContextPack 请求、分页事件与版本化工具活动 | 作为上下文来源索引和诊断入口，不把完整日志重复注入每个 Run |
| 上下文 | 不可变 ContextPack，已有 goal/dependency/review 字段与受限分页 | 按模型预算选择、带来源的摘要、角色视图与遗漏说明 |
| Memory | 已有提案、接受、拒绝、替代与确定性选择，Pack 保存 source_memory_ids | 复用生命周期，增加本次来源说明与统一预算；摘要不自动升格为已接受 Memory |

现有 native skill 观察只读取元数据，不上传正文、不证明加载，也不贡献调度能力。安装 manifest 不等于安装工具或授予权限。`budget-policy.ts` 明确拒绝 `max_cost_usd`。

现有普通对话历史按同组织、房间和 Thread 查询：最近最多 100 条文本，合计上限为 JavaScript 字符串长度 80,000，整条放不下则停止，并设置 `history_truncated`。当前请求另行携带。ModelProfile 虽有 `context_window`，此历史选择尚未据此计 token；不能将字符上限说成模型窗口适配。旧文件渲染同时展示部分字段和 Raw Payload，MCP 渲染则让各 payload 字段出现一次，预算必须区分实际渲染路径。

上下文组装目前先加载同组织全部 accepted Memory，再用 domain selector 筛选；调用时未传数量限制。依赖读取对最多 100 条边逐项查询最新 Run，存在合格 Run 时再查其产物，依赖阶段最多产生 200 次循环内查询。对话 Pack 保留 message ID、role、body、actor_id，但没有逐条携带原 actor_type、position 和 source Run 绑定。以上是源码静态事实，尚未测量延迟或证明用户实际遇到发言混淆。

## 4 总体架构

~~~mermaid
flowchart TB
  UI[Thread / Plan / Board / Skills]
  Intake[触发预览与请求解析]
  Auth[资源使用授权与原始用户检查]
  Intent[持久化请求来源和绑定]
  AD[现有 AssistantDispatcher]
  GR[现有 GoalRunner]
  Life[现有生命周期与 Scheduler]
  Node[artood / RuntimeAdapter]
  Verify[节点验证与独立评审]
  DB[业务表与 event_log]
  GH[GitHub 同步]
  Wake[时间与事件唤醒]
  UI --> Intake --> Auth --> Intent
  Wake --> Intake
  Intent --> AD --> Life
  Intent --> GR --> Life
  Life --> Node --> Verify
  Intent --> DB
  Life --> DB
  Verify --> DB
  GH --> DB
  DB --> UI
~~~

执行意图只持有请求来源、授权来源与执行所有者的绑定。对话状态来自 AssistantTurn，任务与进程状态来自 Task/Run，目标状态来自 GoalRunner。自动化阶段另以 occurrence 表示一次唤醒的处理进度，不能把长期 Goal 状态当作每次唤醒的完成状态；意图不复制另一份运行状态机。

## 5 执行意图与触发预览

### 5.1 交互和投递方式

Thread 保留“发送消息”，新增明确的“请求 Agent”。普通消息和旧 mention 继续只产生讨论与通知。请求预览显示目标、适用项目、投递方式、等待或拒绝原因，以及审批要求。自动选择只能显示候选和“提交时选择”，不承诺资源预留。

| delivery | 语义 | 支持阶段 |
| --- | --- | --- |
| queue | 新建普通 AssistantTurn，按已有规则等待 | 第一批 |
| assign_task | 尝试一次现有任务指派，保留 ready、审批、租约与容量门槛 | 第一批；不承诺通用任务等待队列 |
| merge_queued | 将输入加入同一用户、线程、显式目标的未启动轮次 | 第二批独立增量 |

不支持的投递方式明确返回 `unsupported_delivery_mode`，UI 不显示对应选项。普通入口不能插入规划讨论、独立评审或已运行进程。

### 5.2 契约和提交

新增版本化 ExecutionIntent 请求和只读预览契约：

~~~ts
type ExecutionIntentRequestV1 = {
  version: 1;
  client_request_id: string;
  source:
    | { kind: "conversation"; room_id: string; thread_root_id?: string; body: string }
    | { kind: "task_assignment"; task_id: string; expected_state_digest: string };
  target: { kind: "automatic" } | { kind: "instance"; agent_instance_id: string };
  delivery: "queue" | "merge_queued" | "assign_task";
};
~~~

实际 Zod schema 使用严格判别联合限制合法组合，例如 task_assignment 只能配 assign_task。组织、项目和授权人由认证与关联对象推导；浏览器不能自报 system 来源或任意 owner 绑定。

预览返回规范化 `request_digest`、eligible/waiting/approval_required/denied、候选目标、稳定 reason_code 和支持方式。预览不写入任务、不预留资源、不产生授权；摘要只关联请求，提交时重新校验。

当前 Task 没有通用递增 version，不能把并不存在的任务版本字段作为实现前提。新预览返回版本化 `task_precondition` 摘要：对任务状态、负责人、需求/验收、能力要求、执行策略来源、已接受计划引用和排序后的依赖引用进行规范化哈希。提交在现有任务锁内重读并比较；改变返回 `execution_precondition_changed`。容量、当前授权、审批有效性和依赖实际完成状态始终重新检查，不以摘要代替。该摘要不写入 Task、不把 updated_at 当作单调版本；旧指派 API 继续原有实时检查。

所有新增摘要明确算法和格式：`sha256:` 加 64 位小写十六进制；规范化由同一 domain helper 定义对象键序、空值和有序/无序数组规则，输入使用 UTF-8。请求摘要覆盖解析后的 version、source、target、delivery，并绑定服务端组织和用户；不静默裁剪正文或做可能改变原意的 Unicode 归一化，不改变旧契约已有摘要的解释。

新增表：

| 表 | 核心内容与约束 |
| --- | --- |
| execution_intents | organization_id、authorizer_user_id、client_request_id、source、project/thread、摘要、目标、delivery、authorization_origin；组织+用户+client_request_id 唯一，同键不同内容冲突 |
| execution_intent_bindings | intent_id、owner_kind、owner_id、owner_attempt_sequence；A3 绑定 AssistantTurn 的明确尝试或固定 Task Run，合并可共享同一次尝试；C2 扩展 automation_occurrence 绑定 |
| execution_dispatch_authorizations | 原执行来源、run_id、原始用户、策略版本、上下文摘要与发送序号；记录有权发送的决定，不替代节点回执 |
| assistant_turn_inputs | 合并阶段增加 turn、attempt_sequence、message、intent、输入顺序和撤回记录；每条消息身份保持独立 |
| assistant_turn_attempts | A3 增加组织、turn、attempt_sequence、请求来源与固定 run_id；唯一 turn+sequence 和 run_id，只保存尝试关联及必要处置事实，不复制 Run 状态 |

意图、消息、执行所有者、绑定与领域事件在同一事务提交；业务操作失败一起回滚。复用现有服务检查和 GoalRunner 的事务内编排方式，只提取必要的窄 helper。网络发送在事务提交后进行，恢复扫描重发相同身份，不能新建一条 Run 掩盖投递不确定。

现有 `assignTask` 在事务结束后调用 `onRunQueued`，GoalRunner 的 `transactionContext` 会收集此类回调。新入口必须沿用这种延迟 I/O 的语义：事务内服务只积累待处理 Run ID；外层提交成功后再通知节点，回滚时不得发送。进程恰好在提交后退出时，扫描从数据库重建待发送工作，不能只依赖内存回调数组。

幂等查重先限定组织和原始用户，返回历史绑定前仍检查当前读取权限；重复请求不能重启已取消或已完成对象。请求身份的墓碑与绑定保留到所属执行记录的保留期结束，不能短期清理后把旧网络重试当新工作。人工重试是新的操作授权，使用新的请求身份并关联前一次意图；原绑定不可改为一条无关的最新 Run。AssistantTurn 的尝试关联和 GoalRunner 的自动纠正关系以实际持久记录为准，原预算继续有效。

当前 `retryAssistantTurn` 会在同一 Turn 上清空 run_id 并重新排队，因此仅绑定 turn_id 不足以保留意图历史。A3 为 Turn 增加默认 0 的 attempt_sequence，并在重试的 Task/Turn 锁内先固定旧尝试、再增加序号和关联新意图。没有启动的旧尝试记录 superseded_before_start；已启动的旧尝试保持原 Run。Run 分配、回调和取消均匹配尝试序号，迟到的旧回执不能改变新尝试。意图详情读取绑定尝试，Turn 详情展示完整尝试列表；旧历史无法可靠恢复的关联标为未知，不编造过去的 Run。

旧 Assistant API、直接 assign、重试等入口继续有效并调用同一资源授权服务。旧请求保留原幂等规则；不回填会改变历史含义的意图。

### 5.3 合并与取消

只合并尚未创建 Run/ContextPack 的普通对话，要求同组织、项目、房间、线程、原始用户、显式实例与执行策略。自动选实例、审批、规划和评审暂不合并。建议最多 10 条输入、总正文 20,000 字符；超限进入下一轮，不能截断。

ContextPack 创建时冻结有序消息清单与摘要。冻结后新输入进入后续轮次。未冻结时可以撤回本意图的输入，保留原消息与审计；冻结后的取消明确作用于整个轮次并调用已有取消服务。取消或节点断线都不能被当作进程已退出。

实施前检查 Room、Task、AssistantTurn 的现有锁顺序；并发提交、创建 Run、合并与取消必须用真实数据库竞态验证。

合并只合并输入，不合并授权：每个输入的原始用户和策略来源都参与最终准入，任何已撤回或失效输入不能进入冻结上下文。冻结前全数撤回则取消空轮次；原消息仍保留为讨论记录。冻结后修改正文属于新消息，不能覆盖历史输入。

### 5.4 结构化等待

读模型至少返回 reason_code、blocking_object、required_action、next_check_at 和 observed_at。无容量、审批、原始用户撤权、技能未准备、进程退出未确认分别展示；无法计算下次时间时返回 null。

等待不能只是一段不可处理的错误字符串。它应能定位审批、资源设置或运行详情；保留当前所有者和重试身份。恢复由所属 dispatcher/GoalRunner 对账，不能因点击“检查”又创建执行。

### 5.5 启动确认与状态展示

区分业务已排队、已建立 Run、节点确认启动和操作系统进程实际运行。现有 AssistantTurn 在绑定 Run 时即可能标为 running，UI 不能据此声称模型进程已经启动。新读模型同时返回 owner_status 和基于现有节点回执的 execution_observation，附 observed_at；后者是投影，不产生新的运行状态机。

传输重放沿用固定 `run_id:start`、冻结上下文和原节点会话约束。节点 ACK、写入待处理行或收到命令均不是进程创建成功证据。复用现有 managed journal、pending-start-replay 和进程观察能力；必须逐运行模式验证其支持范围。节点重启后不能证明既有进程/启动结果时，进入 `process_exit_unconfirmed` 或 `startup_outcome_unknown`，等待现有恢复或人工处置，不盲目再发启动。真正重新执行建立新 Run 并扣除适用重试预算。

取消通过所属服务持久化 stop intent，继续接收真实进程关闭和终态回执；控制请求超时不抹掉执行历史。批量授权撤销先提交策略变更，再按既有所有者逐个停止，不在策略事务内等待网络或反向持有所有 Run 锁。

## 6 资源使用授权

### 6.1 权限模型

区分 view、manage_metadata、use_agent、use_compute、manage_execution_grants。管理名称、停用或取消危险任务不隐含消耗机器和模型额度的权利。

新增 `resource_access_policies` 和 `resource_access_grants`。Policy 保存组织、受控资源类型、资源 ID、所有者、ownership_state、兼容模式和 revision；首版所有权资源只有 Agent 与 Computer，Runtime 是计算资源 grant 的过滤条件。Grant 保存 user/organization 主体、操作、项目/runtime 范围、过期与撤销时间、授权人。

每个组织内资源最多一个有效 policy；grant 的项目和主体也必须属于该组织。允许只来自当前生效 grant，过期或撤销项不参与；organization 主体只覆盖当前有效成员。resource_type、action 和 ownership_state 都是封闭枚举，数据库保留正常外键与约束。项目管理者可以收紧项目可用范围，但没有资源所有者授权时不能扩大资源共享。

最终允许执行需要同时满足原始用户有效、Agent 使用权、计算资源使用权、实例项目归属、设备信任、runtime 状态、能力容量、AI 数据共享同意、原业务审批、Goal/Task 策略和节点本地边界。手工指定实例执行相同检查；自动 Scheduler 在评分前过滤未授权候选。预览不得泄露无 view 权限的资源详情。

管理员保留管理和紧急停止权，但不能给自己增加 grant 绕过所有者。所有权转移与恢复采用独立、留痕流程。

### 6.2 执行边界与撤销

创建、分配、延迟分发、重试、规划、独立评审、委派和自动化都接入统一授权。system 仅是事件归因，authorizer_user_id 继续指向原始用户；不能换成服务账号绕过撤权。

撤销和发送授权提交通过资源策略锁序列化。撤销先提交则不产生新的发送授权；已经提交的启动可能在途，必须请求停止并等待节点确认。最终发送边界再查会话与当前策略，但不声称消除了网络竞态。停止未确认时保留必要租约和占用。

每次发送授权固定 policy/grant 的 ID 与 revision、原始用户、当前会话、Run 和上下文摘要。修改 grant 同事务增加 policy revision，撤销、过期和成员移除都使旧决定失效；新一轮准入重新判定，不能把旧 dispatch authorization 当长期令牌。撤权后自动取消尚未启动的所有者或置为其原有阻塞状态；重新授予权限不会悄悄复活已取消请求。

所有策略采用稳定资源排序加锁；A0 须记录与现有 Task/AssistantTurn/Goal 锁的兼容顺序。授权决定与关键业务写入共用事务；发送前检查属于最后一道防线，不能代替事务内的权限校验。

### 6.3 历史兼容

新资源从认证的创建或配对流程固定所有者，默认私有。历史资源只有唯一可信 enrollment 证据才能推导所有者；无法确定时标为 unresolved，不能猜为管理员，也不能突然全部改成私有。

显式 `legacy_team` 仅保留历史原组织、项目和操作语义；不扩大到新的周期规则或 Squad 委派。确认所有权后再迁入 enforced；既有授权历史不改写。克隆资源不能继承 legacy 特权。进入 enforced 后，关闭 UI 功能开关不能取消检查。

legacy 兼容资格由服务端记录迁移批次、历史资源 ID 和原允许的入口类别，不能由请求填写。原有入口也不能借 legacy 代表不同用户或跨项目执行。Computer 与 Agent 所有权分别核对，配对管理员不自动等于机器实际所有者；证据不足进入待认领状态。认领必须具有现存受信节点/资源证明或显式转交，组织管理员单方选择“归我”不足以成立。

节点和用户长期凭证不交给模型。未来回写凭证须绑定组织、项目、Goal、Run 和有限操作，短期、可撤销；不能用于授权、接受计划、提交验证证据或发布。

## 7 GitHub PR 与 CI 反馈

首版只支持 github.com GitHub App，只读接入 PR、Check、Review 与安装撤销事件。Task 显示关联 PR、head SHA、CI、评审和同步新鲜度；Board 展示摘要，Release 分别展示代码集成与真实发布。

新增 vcs_connections、project_repositories、vcs_event_receipts、pull_request_snapshots、task_pull_requests。连接保存 provider 与密钥引用，私钥不进入消息、ContextPack 或模型环境。

安装与 repository_id 通过 GitHub API 校验，项目管理员只能连接获准仓库。分支、标题和 Task 字样只产生关联候选；确认关联需要当前仓库范围和可信产物中的提交身份，或有权用户显式确认。

Webhook 先校验原始请求字节的 HMAC、大小和对应连接，再解析 JSON；校验安装与仓库。以 connection+delivery_id 防重，保存有保留期的必要收据。外部调用在事务外，持久工作项与补偿扫描保证回调丢失可恢复。

Webhook 作为更新提示，按 PR 合并重复与乱序提示并重新读取当前状态。快照固定 repository_id、PR number、head_sha；旧 SHA 的 CI 成功不得覆盖新提交。受限退避、stale 状态和手动重查可见。

并发 API 读取也可能乱序返回。每个 PR 持久化 requested_generation、applied_generation 和同步工作项；领取时固定 generation，落库仅接受仍为当前请求的 generation，旧结果丢弃并保留待重查。安装撤销、移除仓库或连接修订同样增加同步代数并停用连接，旧在途响应不能恢复其可用状态。网络失败不把旧成功冒充当前结果。

CI 分别保存 Check Runs 与 commit statuses，展示 pending/failed/passed/unknown 以及数据时间。只有对应当前 head、读取完整且未 stale 的范围才可汇总；若未读取仓库必需检查规则，标签使用“已观察检查通过”，不能宣称“可合并”或“全部必需检查通过”。合并权限、评审和保护规则分别显示。

首版单一 GitHub App 的全局 Webhook 密钥由部署配置选择，先验签再用 installation_id/repository_id 映射连接；不依赖未验签 JSON 选择组织或密钥。安装回调绑定登录用户、一次性 state 和目标组织/项目，服务端证明其有权连接所选安装与仓库。App 只申请 metadata、pull requests、checks、commit statuses 等所需读取权限；不申请内容写入。短期 installation token 只由服务端保管与缓存，撤销后失效；PR 正文和 CI 输出作为不可信外部内容，不成为授权或自动执行指令。

合并只形成 integration_merged 投影。Task done、节点验证和 product publication 沿用原有门槛。首版不发表评论、提交代码、合并 PR 或部署，也不接受任意 API 主机和抓取 URL。

## 8 Skill 使用闭环

界面分别展示已发现、已选定、已准备和可信使用记录。模型自述只标为自述；prepared 证明约定字节已交付，不能证明模型阅读或遵循。

首版 `instruction_only` 包含 SKILL.md、只读参考文件、manifest、来源与规范化文件清单。建议限制 2 MiB、128 文件、路径深度 8；拒绝链接、路径逃逸、重复及大小写碰撞。版本不可变，同版本换内容返回冲突；digest 证明字节相同，可信来源仍需批准。

新增 skill_package_versions、agent_skill_bindings、run_skill_selections、run_skill_preparation_receipts。版本关联既有 skill_installs；绑定先采用 project+agent+version，校验安装范围、批准和运行时兼容性。创建 ContextPack 时冻结版本、摘要和顺序。

同一项目/Agent 的同一个逻辑 skill_id 只能启用一个版本；Run 内也不得出现该技能的两个版本。顺序显式保存，冲突由提交时拒绝解决，不让节点自行猜优先级。组织级安装只是可选范围，不自动绑定到所有项目。

节点将包准备到受保护的 Run 目录，位于受测源码外；通过 ContextPack 分页或受限只读资源接口提供内容。参考文件读取只接受被冻结清单中的逻辑路径。不得覆盖用户 AGENTS.md、CLI 配置、验证 profile 或源码，不安装脚本、hooks 或任意 MCP command/env。

新增可选 `skills.v1` 上下文、`skill-instructions.v1` 节点能力与节点所有的 `run.skills.prepared` 回执。回执绑定 Run、请求、上下文摘要、会话和实测内容摘要，不进入 Adapter 输出白名单。要求技能的任务只有全部准备成功后才启动；缺包、摘要改变或旧节点明确阻塞。

准备在模型子进程启动之前完成，读取令牌和文件清单绑定本次 Run，不能遍历其他 Run。断点下载在临时目录校验完整后原子切换；按清单重新验证路径与摘要，禁止覆盖已有不匹配内容。物化或只读交付失败阻塞，不能拿 native 发现结果代替。

清单路径使用受限相对逻辑路径；禁止绝对路径、盘符、UNC、空组件、点路径、Windows ADS/设备名、尾随点或空格，以及目标文件系统上的归一化碰撞。落盘逐段验证父目录，拒绝符号链接、junction 和其他重解析逃逸。限制同时作用于下载字节与解包后的文件数/总字节；清单摘要按路径和内容字节计算，不能用压缩包大小代替。清理只删除该 Run 的受管目录，保留仍被历史回执引用的版本，不能扫描删除用户原生技能。

准备后启动前再次检查安装启用状态、批准来源与使用授权。版本字节不可变；新绑定只作用于新 Run，撤销批准则阻止后续启动并对在途运行走停止语义。Skill 正文属于不可信指令材料，不能提高工具权限或替代用户授权。超限、未批准来源，以及审核发现索取长期凭证的包明确拒绝；执行权限仍由节点强制，不能依赖正文审核识别所有恶意指令。

未选技能的旧任务保持原语义；native metadata 不自动转为上传包或可信授权。作者与独立评审分别绑定所需只读技能，不继承可执行环境。真实 Codex/Claude 适配是否能在当前受限模式完成交付，需要实施前小范围技术验证。

## 9 Squad 负责人、上下文与有界委派

沿用现有项目实例归属，一个项目先配置一个协调者，不增加重叠的 Squad 组织。新增 project_squad_configs 保存 leader、允许参与者、revision 和委派限制。

首版只在已有、已接受计划的 Goal 中选择已有任务。新增 goal_collaboration_sessions 和 delegation_requests，固定 Goal/Plan、原始用户、配置版本、source_run_id、所选任务、目标实例、父委派与服务端判定。

启动协作前显式保存 collaboration grant，固定计划、可调度任务、协调者、参与者范围、期限和上限。旧 Goal 的一次性授权不自动升级。协调者的只读控制轮次由 GoalRunner 在该 grant 内创建，计入预算和并发；它只观察并提案，不作为产品作者或独立评审。复用现有轮次分发机制时也必须固定其角色和 Goal 来源，不能把任意普通聊天 Run 当协调者。

Leader 输出结构化建议；节点信封固定真实 source_run_id。服务端检查运行、项目、计划、授权、角色、依赖和预算，再由 GoalRunner 接受。模型不能新增写入范围、替换受约束评审人或接受自己的产物。新增范围进入计划修订流程。

委派、拒绝、成员回报和汇总显示在原 Goal 线程，复用 Handoff/Decision；普通 @ 字符串不触发任务。建议新会话最多 8 次成员委派、深度 2；每个任务同一时刻只有一个有效委派。终态按绑定 Run 去重，最多安排一次可合并的重新检查，是否调用模型按 9.6 判定。计划改变或预算耗尽停止委派；原 Goal 重试、时长和并发上限继续有效。

协调建议只影响当前计划允许的任务选择与候选选择，不能覆盖产品流程的固定作者/评审保留。首版不支持的 execution_mode 明确拒绝协作 grant，原 Goal 保持原执行方式。接受新计划使旧协作 grant 失效，必须重新确认范围；协调者退出不表示成员退出，暂停和取消继续追踪所有实际子 Run。

### 9.1 一个负责人，两类职责

用户可以指定 Squad 中的一个 Agent 作为目标负责人，持续承担主规划、分派建议、阻塞处理和进展汇总。身份按 Agent 展示，实际执行固定到已授权的 AgentInstance；每次运行仍是独立 Run。这里的“负责人”是产品角色，Server GoalRunner 继续拥有持久计划、调度、授权和恢复机制。

| 阶段 | 负责人 Agent | Server 与原有流程 |
| --- | --- | --- |
| 接收工作 | 判断是否需要拆分，提出澄清或规划建议 | 普通 Task 保持可执行小任务语义；转换为 Goal 通过显式入口 |
| 规划 | 作为主规划参与者输出任务、依赖、能力、交付物与验收 | 沿用 Discussion/Plan；保留当前自主规划至少两参与者和计划接受规则 |
| 计划接受 | 解释计划和取舍 | 手工接受或原自主授权下的 GoalRunner 接受；模型文本不构成接受操作 |
| 执行跟进 | 在 C1 范围内建议已有任务的负责人、下一步或修订 | GoalRunner 检查最新计划、依赖、预算和授权后落实；无提案时原确定性调度继续 |
| 失败和新增范围 | 解释阻塞、提出修订或重试建议 | 原重试限额、暂停和计划修订流程有效；旧 grant 不跨新计划复用 |
| 完成 | 汇总交付物与未解决事项 | 实际 Task、节点验证和独立评审决定完成；发布使用独立授权 |

先实现 C0：配置/展示主规划负责人偏好，并在创建原有 Discussion 时校验和固定实际参与实例；它不创建额外循环、不增加委派权限。负责人不合格时返回明确原因，由用户重选；不悄悄更换已固定的参与者。后续 C1 才增加计划内的只读跟进轮次，项目默认负责人变更只影响新会话。

同一 Agent 可以先规划再担任协调者，执行角色和只读工具按每个 Run 固定，不能同时兼任其所产内容的独立评审。当前产品模式对作者、评审和工作区的固定要求继续优先；不合格组合保持原流程。负责人离线时显示等待；更换实例由有权操作产生新 revision，停止并结清旧控制 Run，再开启新绑定。迟到提案按旧 revision 拒绝，不启动两个负责人循环。

### 9.2 共享记录与独立上下文

同一个 channel 表示经授权可查询的公共协作记录，不表示所有 Agent 共享模型会话。默认仍按当前 Thread 组装对话；其他 Thread、其他项目和 Agent 历史只能通过显式关联与读取授权进入本次输入。私有推理、凭证和未公开本地会话不传播。

分成三层：原始消息/计划/任务/产物/事件持久保存；角色视图选择本次所需事实和来源；冻结的 ContextPack 记录本次实际输入。负责人不能凭一段长期聊天恢复全部状态，必须重新读取 Goal、当前接受计划、任务和在途 Run。消息摘要是辅助材料，不能覆盖这些权威状态。

| 角色 | 必需输入 | 按需补充 |
| --- | --- | --- |
| 主规划/负责人 | 当前要求与约束、完整目标验收、当前计划引用、任务/依赖及阻塞状态 | 已确认决策、变更摘要与关联 Thread 的来源 |
| 执行者 | 当前子任务要求和验收、适用目标约束、权限、依赖交付契约与固定输入版本 | 相关实现决策、受限源码与产物读取 |
| 独立评审 | 原要求和完整评审范围、被评源码身份、节点验证及完整要求的证据索引 | 可核对的作者说明和历史问题，不继承作者会话或结论 |

角色选择不能删掉适用的全局约束、任务依赖验收或专用产品阶段的必需上下文；现有 goal/dependency/review 等字段保持语义。跨任务交付引用不授予另一个工作区访问权。历史 API 继续提供诊断数据，不能作为模型可任意遍历组织信息的入口。

### 9.3 模型预算与冻结

新增可选版本化 `context_selection.v1`：保存 role、source_snapshot_digest、消息 position 边界与选中 ID、摘要版本、遗漏范围/原因、policy_revision 和预算说明。预算说明固定 runtime/实际 model、已验证窗口、tokenizer/估算器版本、renderer 版本、各类预留与选中输入计数；实际 API usage 另记，估算值不冒充计量值。

H0c 在这个拟建扩展中补齐 `source_entries`，以 kind+source_id 关联本次选中的 message、memory、decision、handoff、artifact 或 summary，固定正文/结构摘要。消息来源带原 actor_type/actor_id、position、可可靠解析的 task_id/run_id/turn 关联与本次角色；请求、规划根消息和普通历史分别标识，无法证明的关联为 null。记录均由 Server 从原始行和关联推导，不能采信模型自报身份。显示名称只是有界标签，稳定 ID 和当次来源快照才用于追溯。

旧 conversation.role 保留其兼容含义；新 renderer 明确将其他 Agent 发言作为带署名的历史材料，不把它当作当前模型此前亲自执行的事实，也不提升为 system 指令。原系统归因的自动化根消息仍须显示实际授权来源，system 标签本身不增加权限。新来源字段只解释已经选中的记录，不增加历史可见范围或引入跨 Thread 广播；旧 Pack 缺少来源时标未知，不用当前 Agent 名称、当前任务文本回填过去。

输入预算为 `B = W - S - T - O - M`：W 是实际模型可用窗口；S 是系统/CLI 固定指令；T 是工具 schema 与后续工具结果的预留；O 是输出预留；M 是误差与包装余量。各预留不能为负，合计达到 W 时不启动。所有 ContextPack 正文、JSON/Markdown 包装、重复呈现、Skill 和必要证据的 token 都计入 B；图像采用目标模型对应的计量或保守上界，不能只数图片链接文字。

1. 运行目标选定后，使用节点受保护配置所确认的实际模型/窗口和 runtime 能力计算。ModelProfile 元数据只作候选信息，不能假设 CLI 没有覆盖 model；最终节点再次匹配模型、renderer 与预算 revision。不一致在启动前拒绝，不在节点暗中裁剪已冻结输入。
2. 先放必需原文和角色必需结构，再放已校验摘要、最近相关消息，最后放可省略的辅助材料。必需集无法容纳返回 `context_required_overflow`，显示所需预算与支持动作：拆任务、显式选择更大窗口的合格实例或修订输入；不得自动换模型、扩权或只保留摘要。
3. 计数应覆盖该模式实际发送/读取的完整渲染文本。优先使用匹配的 tokenizer；无法精确计数时，使用已验收的保守上界并标记 estimated。窗口或安全上界未知返回 `context_capacity_unknown`；新适配路径不可用，普通旧手工路径仍标明其原始限制。
4. Server 在创建 ContextPack 时冻结选择、模型约束和摘要引用；节点渲染后只做确定性校验，失败不创建模型进程。修改选择必须作为原服务允许的新尝试留下记录，不能更改旧 Pack 或重发同一 Run 时换输入。新角色字段依照真实能力协商发送，旧 strict parser 单独验收。
5. 已有分页用于读取固定包，不增加模型窗口。首版预算模式不续接无法核算的 provider 会话；用全新会话及持久状态重建。运行内工具结果仍可能消耗预留，只有支持并验证工具结果限额或受控上下文压缩的 runtime 才宣称支持长程预算；否则只承诺启动输入准入，溢出按原失败/重试流程结清。

来源快照只覆盖选中的上下文依赖与相关任务状态，不能用整个 event_log 的最新位置作为全局失效条件。查询时先确定可见消息集合及 position 边界，冻结选中 ID 和内容摘要，避免组装中混入后续用户请求。授权准入和发送前仍重查，ContextPack 摘要不替代使用权或 AI 数据共享同意。

### 9.4 摘要可追溯与失效

摘要先采用确定性的任务/依赖/状态投影和固定字段的决策摘录；需要模型压缩旧讨论时再引入有界摘要 Run。新增 `context_summaries` 保存组织、项目、Thread/Goal 范围、版本、source message ID/position/content digest 清单、输入范围摘要、生成 Run、生成策略版本、未决事项和被替代版本。摘要生成消耗原授权下的显式预算，不因超长历史自动无限调用。

缓存键绑定可见范围、源内容摘要、角色和摘要策略。源消息被修订/删除/隐藏、授权范围或关联计划改变时，新 Run 不再注入旧摘要；没有合格摘要时先使用允许的原文，放不下则明确阻塞。已冻结 Pack 保持原记录并按既有读取策略保护；摘要重算不改历史输入。增量摘要包含新原文与此前来源引用，定期从原始来源重建，不能无限“摘要的摘要”丢失约束。

当前要求、已确认限制和验收保留原文；摘要明确区分已确认决策、建议、冲突和未知，引用原消息，不得将 Agent 建议提升为用户授权。摘要读取同样过滤组织/项目与当前可见范围；检查范围不完整或源已不可见时，不能为填满上下文从其他 Thread 猜测补齐。

### 9.5 结构化交接，先复用再压缩

H2 先把已有 Goal/Plan、Task/dependency、Handoff/Decision、产物引用和节点回执组合为确定性的工作简报，冻结到可选版本化 `handoff_context.v1`，同时为 UI 提供同源读模型。复用原始记录和 ContextPack，不另建聊天副本、向量库或新的任务状态机，也不需要额外摘要模型调用。

| 简报内容 | 来源与约束 |
| --- | --- |
| 本次做什么 | 当前请求、任务验收与适用目标约束，保留原文；固定 Goal/Plan/Task/Run 引用 |
| 输入与依赖 | 当前计划的依赖边、已接受执行的产物 ID/checksum、批准的读取引用；旧失败 Run 的文件不混入 |
| 已决定什么 | 当前适用 Decision 与原消息引用；accepted 只说明协作记录状态，不等于资源授权或计划接受 |
| 还缺什么 | Blocker、Handoff 的 expected_action/blocking_condition、原文评审意见；模型提出的下一步标为建议 |
| 证据到哪里 | 节点 verification/evidence 身份和实际范围，模型自述另列；缺失或遗留记录标 unknown |
| 相对上次变化 | 在相同角色/计划范围下比较已冻结来源：新增交付、阻塞解除、要求或验收改变；无可靠前序时给完整当前简报 |

现有 Handoff 的 open/accepted/completed 属于沟通流转，不能单独使 Task done、依赖解锁或生成验证通过结论。新投影由 Server 重读关联对象并校验组织、项目、计划和执行身份；不能因模型填写了 task_id、收件人或“已完成”就采信。作者说明与可信状态分开展示，来源不可读时不显示其内容或标题。

简报对每个引用标明版本/摘要和观察时间，冻结前核对相关记录，遇到必需来源变化重新组装或拒绝；可变的 Handoff/Decision 文本不能在运行时被当作原 Pack 的内容。首版只支持同项目、显式绑定且已有权限的对象；不通过扫描整个 channel 推测关联。依赖/产物现有数量上限被触及时保留 truncated 标记，若遗漏必需输入则阻塞，不能拿前 100 项当完整交接。

“变化”只减少可选历史重复，不能代替当前要求、权限、完整适用验收和必需交付契约。接收者仍按实际窗口获得自足输入；只发 diff 再假设它记得上轮会话不合格。执行者需确认读取和报告缺口，不要求复述整份简报来制造第二轮开销。文件读取回执也不证明模型理解。

### 9.6 事件合并与协调调用上限

同 channel 的每条文本、输出 chunk、usage 或进度心跳都不触发负责人。C1 仅在 grant 内对实际成员 Run 结清、任务阻塞变化、明确要求变更或需要决策的事件安排控制轮次；普通聊天仍须显式请求。已有确定性调度能够继续时直接执行，不强制先问一次模型。暂停、停止、撤权和进程关闭处理立即走 Server 路径，不等待模型、合并窗口或协调者可用。

复用 `goal_collaboration_sessions`，增加 binding_revision、control_sequence、pending_event_position、consumed_event_position、active_control_run_id 和本会话调用计数。事件收据按来源 ID 去重，在 Goal 锁内更新待处理边界；一次只允许一个排队或在途控制 Run，批量覆盖多条相关事件。事件位置是重放边界，提案失效检查仍只比较相关业务对象的前置摘要，不因无关日志变化而无限重算。

创建控制 Run、冻结本次事件范围与计数预留同事务提交；其运行期间的新事件只保留待处理事实。控制 Run 结清后，GoalRunner 先重读实际状态，再判断剩余事件是否仍需模型决策；无变化则记录 no-op，不创建模型调用。事件重复或 Server 重启按原控制序号/Run 恢复，不能重复扣额度或创建第二负责人；进程结果不确定时阻塞。来源游标有缺口时先从权威状态做补偿，不能猜测全部事件已处理。

pending 是已发现事件上界，active Run 的 Pack 固定其本批范围，consumed 只在提案落实、明确拒绝/no-op 或有记录的失败处置后推进；创建 Run 本身不表示处理完成。失败后需要人工决策的对象仍保持 blocker，不能推进游标就宣称工作完成。负责人替换也沿用已消费边界与未结清范围，先解决旧进程身份，再由新 revision 重读现状。

新 C1 会话默认最多 8 个控制 Run、2 个模型摘要 Run，人工重试和失败尝试也占用各自额度；计数在创建固定 Run 时预留，投递重放不再增加。达到上限停止这些附加调用并展示原因，原计划确定性执行只在原授权、预算与依赖均满足时继续；确需决策的任务保持阻塞。已有委派 8 次/深度 2 是另一组限制，不能将三类额度互相借用。

这些是拟新增的 session 限额，不是声称当前 GoalBudgets 已有 max_runs。所有规划、协调、摘要、执行和评审 Run 均关联所属 Goal，纳入原时长/并发与各自重试边界；额度扩大需显式授权，计划修订或替换负责人不能静默重置同一授权范围内的已用额度。跨会话累计预留绑定原 collaboration grant，修订只收紧或沿用余额；只有新的授权记录才能增加额度。

### 9.7 复用已有 Memory，区分知识与授权

已有 `memories` 继续保存人工整理并接受的可复用知识；Decision 记录显式协作决策；`context_summaries` 只保存可重建的讨论压缩结果；Goal/Plan/Task 和受保护执行策略仍是任务及权限的权威来源。不建立平行的“Agent 长期记忆”库，不因摘要生成成功或被多个 Agent 引用就自动 accept Memory。

普通旧路径保留当前 selector 的 eligibility 和次序：accepted，且 task 匹配 task_id、project/code 匹配 project_id、organization 匹配 organization_id；排序为 task、project、organization、code，再按 updated_at/created_at 降序和 ID 升序。scope 优先级是检索次序，confidence 是知识元数据，二者都不是指令等级或权限。code 范围始终绑定项目，不扩大到全组织。

H0c 为新 Pack 固定本次实际注入的 Memory ID、scope、内容摘要和可证明的来源引用；source_memory_ids 与实际注入集合保持一致。H0a/H3 不改变选择结果；H0b 才在完整必需集之后按预算选择辅助 Memory，并显示未选原因。不能为节省 token 静默改变旧入口语义，也不能先截断候选再把关键任务记忆挤掉。

Memory、摘要与当前任务要求出现冲突时显示原文及来源；受保护策略始终在可信边界执行，模型不能用知识记录覆盖它。明确的新任务要求可覆盖一般偏好，涉及验收、范围或已接受计划的冲突进入原澄清/修订流程；不按最新时间戳或最高 confidence 自动裁决。要成为必需约束的内容需进入相应任务/计划或受保护策略，不能仅依靠普通 Memory 字符串表达。

Memory 被 supersede 后，新选择和依赖它的摘要缓存转用当前合格版本；历史 Pack 不改写。其来源消息被移除时，来源绑定摘要失效；人工整理的 Memory 是否保留由现有 curation/可见性规则显式决定，不能一律删除，也不能把被移除原文经摘要或引用重新带回。新可见性/替代检查失败时阻塞相关新输入，旧冻结记录按原读取与保留策略保护，不声称已从正在运行的模型中撤回信息。

## 10 定时与事件唤醒

自动化只产生重新检查已授权工作的入口，由 GoalRunner 执行。周期或事件触发需要明确授权；一次性权限不能自动升级。C2 首版只提供 reconcile_goal，不直接指派 Task，不重开暂停、完成、取消或归档 Goal。直接任务动作、新建 Goal 和外部 Webhook 留到 C3 另行定义授权与验收。

支持顺序：指定时间、带 IANA 时区的周期/cron、内部事件，再到外部 Webhook。新增 automation_rules、automation_occurrences、automation_occurrence_runs、automation_health。规则只存结构化动作与 grant，不存远程任意命令或验证 argv。

Occurrence 以 rule+revision+UTC slot 或 source_event_id 唯一；持有 state、lease_owner、epoch、expires_at 和 intent 绑定。重启可重新领取，旧 epoch 不得写回。租约仅协调处理者，外部副作用仍靠固定意图和 Run 身份防重。

领取、配额预留、意图创建与 occurrence 绑定在同一数据库事务完成；外部执行仍在提交后。事务重放复用固定请求身份，不能重复扣额度。规则编辑采用 expected_revision，并记录生效切点 effective_from；新版本只覆盖切点之后的槽位，切点前已接受的槽位不因 revision 改变而再次执行。DST 重复时间按本地日历槽位去重后映射一次 UTC，不能仅依靠两个不同 UTC 时间去重。

一次唤醒的完成协议如下：

1. 扫描器插入 pending occurrence；准入、额度预留与固定意图一起提交后进入 ready_for_reconcile。意图绑定这条 occurrence，source 和原始用户由受信服务推导。
2. GoalRunner 读取该持久事实，在自身事务中再次检查规则 revision、原始 grant、Goal 人工状态与接受计划，复用现有 advance/事务回调机制。只在本次准入允许的范围推进。
3. 无需执行、已经由既有 Run 推进或 Goal 不可唤醒时，记录 completed_noop/skipped 和原因；不能因为 Goal 尚未 done 就让这条 occurrence 永久未完成。
4. 本次确实创建 Run 时，以 automation_occurrence_runs 固定这些 Run，进入 waiting_runs。它只等待本次产生的 Run 结清；后续自然推进沿用原 Goal 授权，不把整个 Goal 生命周期复制给 occurrence。
5. 终态由实际 Run 和闭包回执派生后结清。终态事件重复、进程重启和 pump 重扫均不重新执行同一 occurrence；进程状态不确定时保持等待。

同一规则已有未终态 occurrence 时，后续到期检查合并为一次可见的忙碌/合并记录，不继续创建执行意图。不同规则指向同一 Goal 时，仍由 GoalRunner 的现有 Goal 锁与在途事实去重。人工触发也使用相同 occurrence、额度和授权流程。

使用成熟的时区库；秋季重复本地时刻选择较早的 UTC 映射执行一次，春季缺失时刻跳过；编辑器展示未来三次本地与 UTC 时间。错过多次计划合并为最近一次检查，不补发积压。修改或暂停规则使未提交意图的旧 occurrence 失效；已提交请求按真实状态显示并显式取消。

事件只订阅同项目允许类型，游标与 occurrence 原子提交。事件保留期形成缺口时标明补偿扫描，不能静默跳过。人工暂停优先，不因规则重启自动解除。

建议默认每天 10 次触发、最多一个非终态 occurrence、连续 3 次实际执行失败后暂停。网络错误有界退避；鉴权、配额和配置问题等待人工；容量不足等待；进程关闭不确定阻塞冲突执行；产品验证失败走既有纠正策略。没有可靠费用数据时显示未知，以运行次数、时长、重试和并发实施硬限制。

每日上限首版固定按 UTC 日计已接受意图，UI 标明统计窗口；扫描、投递重放和同 occurrence 的重领不增加计数。组织、原始用户、Goal 和规则共同实施上限，拆多条规则不能绕过上级限额。规则 owner、原始 authorizer、授权事件和授权范围分别持久化；修改目标、动作、参与者范围或扩大额度需要原始授权人重新授权，转移 owner 不转移使用权。

无变化保持安静；只在完成、有意义变化、失败暂停或需要用户操作时通知。

## 11 API 事件与代码落点

以下均为提议，路径使用 `/api/v1` 前缀及现有认证、错误信封、幂等和版本前置条件。

| 领域 | 主要接口 |
| --- | --- |
| 执行入口 | POST /execution-intents/preview、POST /execution-intents、GET /execution-intents/:id、POST /execution-intents/:id/cancel、POST /execution-intents/:id/retry |
| 资源使用权 | GET /resources/:type/:id/access、POST/DELETE /resources/:type/:id/grants |
| GitHub | POST/GET /projects/:id/repositories、POST/GET /tasks/:id/pull-requests；独立签名入口 /integrations/github/webhooks（不带 /api/v1） |
| Skills | POST /skills/:id/versions、PUT /projects/:id/agents/:agentId/skills、GET /runs/:id/skills |
| Squad | GET/PUT /projects/:id/squad、POST /goals/:id/collaboration、GET /goals/:id/delegations |
| 上下文 | 在现有 Run 详情补充经过权限过滤的选择/预算说明与来源引用；不公开整个 Pack、内部指令或凭证 |
| 自动化 | POST/GET /projects/:id/automations、PATCH /automations/:id、POST /automations/:id/trigger |

新增事件族 execution.intent、resource.access.changed、skill.binding.changed、run.skills.prepared、vcs.pull_request.updated、squad.delegation、automation.triggered/paused。事件只含标识、版本和必要摘要，不带密钥、技能正文或无权查看的资源元数据。读模型事件接入 event_log 和查询失效，关键副作用由持久化事实恢复。

重试接口接收新的 client_request_id，并由服务端推导重试来源与前序意图；仅在原所有者允许、原进程已结清且当前权限满足时调用现有重试服务。新用户操作产生新意图，旧意图保持原始用户身份。自动纠正不调用此人工入口，继续由 GoalRunner 在原 grant 内处理。所有列表按组织/项目权限过滤并分页；跨租户对象不泄露其存在。

首版重试 AssistantTurn 只允许该 Turn 的原始用户，避免重新利用其他人的会话、同意和输入；其他有权用户可以显式发起自己的新请求。已有重试入口对进入新意图体系的 Turn 同样维护尝试关联并检查原始用户，不能通过旧接口跳过。对尚未建立 Run 的等待请求，可直接读取最新等待和授权结果；读取不改变队列、不创建新意图或重置预算。

| 代码位置 | 实施内容 |
| --- | --- |
| packages/domain | execution-intent、resource-access、skill-delivery、squad-delegation、scheduled-automation、vcs 契约与纯判定 |
| 上下文实现 | domain 的可选版本选择/来源/简报契约与原 Memory selector；server 的 context-pack-service、memory-service、批量读取、简报与摘要投影；artood 的来源展示、模型确认、实际 renderer 计数及校验 |
| packages/protocol | 可选版本上下文、节点能力、准备回执和委派提案；验证权威保持节点所有 |
| packages/db | 新表、外键、唯一键、索引、schema 与新追加迁移 |
| apps/server/src/services | 资源授权、入口绑定、GitHub 同步、技能交付、委派、自动化；在现有执行边界接入 |
| apps/artood | 内容准备、只读交付与可信节点事件；保持进程关闭和验证逻辑 |
| apps/web | Thread 预览、共享设置、PR 状态、技能准备记录、Squad 和规则编辑 |
| packages/client 与原生客户端 | 共享读取契约；旧客户端准确读取状态并保留手工路径，新编辑单独验收 |

未知展示枚举可显示“未知”；未知授权模式、必需能力和协议组合必须拒绝执行。可选新字段也要验证旧 strict parser，通过真实能力协商决定发送，不能假设 optional 天然兼容。

## 12 实施拆分

| 增量 | 可独立审查交付 | 依赖 | 完成标志 |
| --- | --- | --- | --- |
| A0 | 固定最新 main 的 Squad、生命周期、技能发现、Goal/Plan 基线 | 当前 main | 事实与拟建能力分清 |
| H0a | 现有路径上的选择说明、来源/遗漏标识与 usage 覆盖统计 | A0 | 不改变执行语义，不把字符计数或估算当容量保证 |
| H0b | 角色视图、输入预算与节点渲染校验；H0 的容量准入部分 | H0a；T3 模型/renderer 能力确认 | 必需信息完整，溢出/未知容量可解释，不增加执行权限 |
| H0c | 逐条发言/Memory 来源、上下文与 UI 的同源解释 | H0a；来源字段能力协商 | 其他 Agent 发言有署名，来源未知不猜测，不扩大历史范围 |
| H1 | 来源绑定的讨论摘要、缓存失效与生成限额 | H0 | 摘要可回溯、当前原文约束保留、撤回来源不再注入 |
| H2 | 确定性工作简报、交付引用和变化投影 | A0；复用冻结 Pack 与原有授权 | 无额外模型调用，必需输入自足，Handoff 不替代任务状态 |
| H3 | Memory 候选 SQL 过滤与依赖批量读取 | A0；与旧 selector/交接的结果等价验证 | 消除随依赖数逐项查询，减少无关候选，不改 Pack 内容及顺序 |
| C0 | 复用原规划入口的负责人偏好、实例固定和统一展示 | A0；沿用原授权与参与者要求 | 单一负责人入口，不新增调度循环 |
| A1 | 资源策略、grant、迁移与查询 | A0 | 历史语义兼容，新资源默认私有 |
| A2 | 所有执行边界接入授权、撤销与恢复竞态 | A1 | 旧入口、规划、评审和恢复均不可绕过 |
| A3 | 预览、意图、原子绑定、Thread 入口、等待展示 | A2 | 可解释、可恢复、幂等身份唯一 |
| A4 | 未启动输入合并与取消 | A3 | 不丢输入、不改写冻结上下文 |
| B1 | GitHub App、仓库绑定、精确提交投影与补偿 | A0；访问控制接 A1 | 新提交使旧 CI 失效，安装撤销有效 |
| B2 | 不可变指令技能、绑定与节点回执 | A2、A3；能力协商 | 指定字节交付可核验，缺失阻塞 |
| C1 | 已接受计划内 Squad 委派 | A2、A3 | 有界且公开，GoalRunner 仍为所有者 |
| C2 | 指定时间、周期与内部事件的 reconcile_goal | A2、A3 | 重启、暂停、no-op 和本次 Run 结清正确 |
| C3 | 外部 Webhook、独立任务动作、更多运行时、原生编辑 | C2 真实验收 | 按独立支持范围扩展 |

H0 指 H0a+H0b+H0c。先以 H0a+H2+C0 改善现有手工/规划路径；H3 可独立改善原路径，H0c 随来源展示模式验收上线，再通过 T3 开启 H0b；H1 在确有超长历史需求且节省超过生成开销时接入。不必等待完整的新意图和自动化系统。新增执行入口的候选仍为 A0–A3+B1，其后 A4+B2，再到 C1+C2；C1 还须通过 H0b 的协调者模式验收、接入 H0c/C0 负责人来源绑定和 9.6 的持久调用计数。每个增量按 schema/迁移、服务/协议、UI、验证审查；规模过大继续拆 PR。这里定义依赖和验收范围，不作未估算的工期承诺。

### 12.1 数据库实现约束

| 领域 | 最低约束与查询索引 |
| --- | --- |
| 意图 | 组织+原始用户+client_request_id 唯一；binding 的 intent_id 唯一；Turn/attempt 和 run_id 关联唯一；owner 和项目查询带组织；历史引用保留墓碑 |
| 资源 | 组织+资源类型+资源 ID 唯一 policy；grant 按 policy/subject/action 查询，revision 条件更新；项目和主体归属校验 |
| GitHub | connection+delivery_id 唯一收据；仓库/PR/head SHA 快照唯一；PR generation 条件写入；重查工作项和退避时间索引 |
| Skills | 逻辑技能+版本唯一；项目/Agent/skill 唯一有效版本；Run/skill 唯一选择；回执绑定请求与会话 |
| Squad | source Run+proposal identity、session+binding revision+control sequence 唯一；同计划/任务最多一个有效委派；一个活动控制 Run；累计额度预留与固定 Run/委派接受同事务 |
| 上下文 | 摘要按组织/范围/来源摘要/策略版本检索；Run 选择绑定固定 ContextPack；旧版本不可覆盖，来源可见性失效影响新选择 |
| 自动化 | revision 槽位、事件与 DST 日历槽位唯一；due/state 索引；每规则最多一个活动 occurrence；occurrence/Run 关联唯一 |

所有外部可见行都带 organization_id，关联使用可实现的外键或受控类型加服务校验，不能因多态引用放弃租户校验。活跃唯一约束使用稳定状态字段，不把 now() 等动态时间放进索引谓词。过期在准入时明确计算。

### 12.2 实施 PR 的审查材料

每个功能 PR 应给出变更契约与兼容对象、追加迁移与回填样例、状态/等待的权威来源、事务和提交后 I/O 边界、失败与恢复案例、UI 入口、实际检查结果及尚未覆盖的平台。A1/A2 必须先证明旧入口不会绕过，再启用 A3；B2/C1/C2 仅对已合格的支持矩阵开放。

上述限额作为新功能的首版默认值写入创建时快照：合并 10 条/20,000 字符，技能 2 MiB/128 文件/深度 8，委派 8 次/深度 2，规则每日 10 次/一个活动 occurrence/连续 3 次实际失败暂停。用户确认前展示；更严格的组织/Goal/节点限制优先，历史授权不补写这些新默认值。时长与重试沿用原 Goal 或本地受保护上限，缺少可靠上限时不开放无人值守模式。

C1 另固定控制 Run 8 次、模型摘要 Run 2 次；这里的“创建时快照”同时保存原 grant 和累计预留引用，不能新建 session 就清零。普通手工讨论的 H1 摘要须在其显式操作中展示并授权生成限额，不借用 C1 grant。默认数值是保守产品起点，需经真实任务测量后调整，不是性能或成本承诺。

模型摘要若是本次选择的必要前置，须在消费者 Run 创建前完成并取得独立的有界配额，不能让一个占满并发的在途 Run 等待自己的摘要 Run。无摘要也能放下必需集时直接使用原文/确定性简报；否则返回明确阻塞，不用摘要重试循环掩盖容量或配额不足。

### 12.3 高 ROI 顺序与暂缓项

下表是基于复用程度、日常触达面和新增可信边界的定性排序，尚无实测收益或工期。P0 先获得直接使用价值与测量依据；授权等基础工作不因收益不易量化而省略。

| 优先级 | 增量 | 预期收益与已有复用 | 范围边界 |
| --- | --- | --- | --- |
| P0 | H0a+H2 | 用原 ContextPack/历史/事件解释“读了什么、缺什么、上游交付是什么”，避免先引入模型记忆服务 | 只做确定性投影；旧日志不足时标未知 |
| P0 | H3、H0c | 批量读取减少数据库往返；来源署名帮助区分多人发言，复用现有消息/Memory/Run | H3 不改结果；H0c 不授予额外读取或执行权，性能收益须测量 |
| P0 | C0 | 用户明确把任务交给一个负责人，直接复用现有规划参与者与计划流程 | 不新增模型循环，不降低原作者/评审要求 |
| P0 门槛 | A1/A2、T1/T3 | 扩展执行前先补齐权限与原子边界；容量准入必须知道实际模型 | 在原手工路径内做独立技术验证，新入口未就绪不开放 |
| P1 | H0b，按需 H1 | 不同窗口可执行同一协作任务，长历史减少重复传输与溢出 | 必需原文完整；摘要净收益为正后才扩大 |
| P1 | A3 的触发预览/等待、B1 的精确提交状态 | 减少无效启动、人工查状态和误判旧 CI，复用原执行所有者 | 完成授权与持久绑定后上线；GitHub 仍只读 |
| P2 | C1 的有界委派与事件合并 | 多 Agent 分工有记录，多个变化合并为一次必要决策 | 先证明任务质量和协调开销，再扩参与者与并发 |
| 按真实需求 | A4/B2/C2/C3 | 高频追问、技能复用或无人值守才承担额外状态和兼容成本 | 不作为基本协作体验的前置；独立支持矩阵逐项验收 |

暂缓全频道逐条广播给所有模型、无限长会话、向量数据库、通用多层 Agent 递归、模型决定每次调度、自动换模型和无上限“自我优化”。只有来源选择与简报无法解决的检索需求被实际任务证明后，才单独评估检索设施；不以新增组件数量衡量方案完整度。

### 12.4 H3：不改变语义的上下文读取优化

该增量只优化查询，先于模型压缩；兼容现有手工请求，不要求启用新授权或协调模式。先从当前四个 Memory scope 和依赖选择语义构造结果对照，再替换读法。

1. Memory 在同组织、accepted 条件下，把 task_id 匹配、project/code 的 project_id 匹配和 organization scope 的原筛选条件下推到 SQL，再使用原 `selectInjectableMemories` 复核 eligibility、排序和 source_memory_ids。不能给所有 scope 加同一个 project_id 条件而丢失组织记忆，也不能统一加一个数量上限改变旧结果。`GET /memories/context` 与 Pack 组装共用该窄读取 helper，避免两份选择规则漂移。
2. 依赖边仍按原顺序取最多 101 条，以前 100 条构建结果及截断标记；提取其中已 done 的唯一任务 ID，批量选每任务最新 Run，保持 created_at 降序、ID 降序的原并列规则。先取最新、再检查 completed；不能改成“最新 completed Run”而跳过更晚失败或未完成的执行。
3. 仅对上述合格 Run，按 task_id+run_id 批量读产物；每组仍按产物 ID 取最多 101 项，输出前 100 项及 artifacts_truncated。使用窗口查询/受限分组而非全局 LIMIT，不能让一个任务占满结果导致其他任务丢输入。重复依赖类型可复用同一只读结果，但输出边的类型与顺序不变；跨组织/项目过滤和禁止注入原始 URI/metadata 的规则保持。
4. 依赖阶段目标从随边数增加的逐项查询变成边、最新 Run、产物三类有界批量查询；若受数据库参数上限分块，记录块数并固定上限。不要在同一事务连接上盲目并行上百个查询来替代批量读取。空集合不发无意义查询，必需输入截断仍按 9.5 阻塞。

所有读取沿用原事务和相关锁边界；“在同一事务”本身不证明多条查询是同一快照，冻结前仍按 T1/H2 校验相关读集。结果变更需拒绝或重新组装，不用进程级缓存绕过新授权、Memory supersede 或产物身份检查。先记录查询计划和读行数，再决定是否追加索引迁移；已有 runs、memories 索引不能仅凭命名认定足够，也不预先添加一批未经测量的索引。

## 13 验证与验收

| 边界 | 必须覆盖的反例 |
| --- | --- |
| 预览/提交 | 预览后撤权、目标变更、任务状态或接受计划变更；旧摘要不授权 |
| 幂等/事务 | 同身份并发、同键不同内容、绑定回滚、提交后回调丢失、Turn 重试不改写前次意图、旧回执迟到 |
| 资源 | 跨组织/项目、手工指定、管理员无使用权、原始用户移除、设备撤销 |
| 恢复 | Server 重启、节点重连、在途启动、停止不回应；不得重复启动或提前放锁 |
| 合并 | 创建 Run 并发、跨线程/目标、超限、撤回、冻结后取消 |
| GitHub | 错签名、重复乱序、安装撤销、旧 SHA 成功、限流、同步重启 |
| Skills | 同版本换内容、篡改、路径逃逸/链接/碰撞、超限、旧节点、模型伪造回执 |
| Squad | 伪造来源、计划变更、循环、自评审、重复终态、重复委派 |
| 负责人 | 主规划偏好不满足两参与者要求、权限变更、实例更换、旧 revision 迟到提案；不能覆盖固定评审 |
| 上下文 | 多模型窗口、实际模型覆盖、包装重复计数、中英文/代码、图像上界、必需集溢出、未知容量、旧节点、摘要源隐藏与跨 Thread 泄漏 |
| 交接/协调 | 可变 Handoff 被旧 Pack 引用、模型伪造完成、依赖截断、只给 diff 丢当前要求、输出事件风暴、控制 Run 在途新事件、游标提前消费、换负责人/新 session 绕过累计限额 |
| 来源/Memory | 同名不同 Agent、同 Agent 不同实例、system 根消息、无来源旧 Pack、新摘要误变 accepted、Memory supersede、知识偏好与当前验收冲突 |
| 批量读取 | 最新 Run 失败却回退旧成功、created_at 并列、重复依赖、每任务 100/101 产物边界、全局 LIMIT 饿死其他任务、无 project_id 的组织 Memory 丢失 |
| 自动化 | epoch 失效、DST、错过计划、重复事件、规则编辑、人工暂停、游标缺口 |
| 多端 | 旧 strict parser、能力未开、重连缓存、原生状态准确性 |

数据库约束与竞态使用真实 PostgreSQL/PGlite 事务验证；节点进程与文件边界用实际节点验证。

额外故障注入必须覆盖：内部事务回滚后没有节点发送；提交后丢回调仍绑定同 Run；ACK 后节点重启且状态未知时阻塞；旧 GitHub 读取晚返回；安装撤销后旧响应抵达；Skill 准备后撤销批准；规则修改切点与配额并发。检查真实进程退出和读取结果，不能只断言 mock 函数调用次数。

涉及执行的代码增量集成后运行仓库四项检查：

~~~text
npm run typecheck
npm run build
npm test -- --maxWorkers=2
npm run test:e2e --workspace @artoo/web
~~~

POSIX、Windows、本机客户端和发布路径使用相应平台门禁。触及存储超时或清理时，另跑仓库规定的 preview-storage-timeout 父夹具，区分其故意失败的子案例和父验证结果。

真实使用验收应分别记录不可变源码、配置和证据：两个人两台机器的授权/撤销；连续对话在重启后身份唯一；真实测试仓库 PR 新提交与安装撤销；固定 Skill 的真实受限读取和篡改阻塞；已有计划内委派与独立评审；周期规则重复触发、暂停和安静通知。受控模型夹具、真实 provider、平台签名和产品发布分别记账，不能互相代替。

### 13.1 发布候选退出条件

| 候选 | 必须保留的证据 | 不得以什么替代 |
| --- | --- | --- |
| 第一批 A0–A3+B1 | 跨用户/机器的资源授权，撤权与在途停止，丢响应/重启仍同一执行身份，真实 GitHub 新 head 与撤销，旧客户端回归 | 预览文本、ACK、模型自述或旧提交上的绿灯 |
| 现有路径 H0+C0，后续 H1 | 两种不同窗口的真实运行模式、完整约束和预算快照、未知模型/溢出阻塞、来源失效、负责人固定与原评审回归 | 80,000 字符上限、分页成功、模型声称记住历史或只测试纯计数函数 |
| 第二批 A4+B2 | 数据库合并竞态与取消，实际节点包校验/只读读取，两种主要 runtime 的合格模式清单，篡改和缺失阻塞 | native 元数据发现、manifest、仅 prepared 或单一 runtime 夹具 |
| 第三批 C1+C2 | 当前计划/角色下的公开委派与限额，no-op occurrence 结清，DST/规则更新/配额重放，暂停后不再启动 | 评论文本、计时器日志或仅一次成功的运行 |

每个证据关联验收项、源码 SHA、环境、命令、实际 exit/close、必要节点回执和诊断范围。文档只定义应收集的证据，不预先填写“通过”。

本次只有文档变更，检查文本、引用和范围；上面的代码门禁属于后续功能实现，不在文档中宣称已执行。

### 13.2 收益验证和扩展条件

先用 H0a 记录原路径的代表任务基线，保持源码、需求、模型/版本、授权、角色和验收范围可比；再比较 H2、H0b、H1、C1 的相应候选。普通短任务、长中英文讨论、代码/工具输出密集、不同窗口、重启恢复、依赖交接和独立评审分别记录，不能只选长聊天宣称全局提升。夹具验证不变量，真实 provider 任务验证使用效果，两类结果分开。

| 观察项 | 统计口径与扩展条件 |
| --- | --- |
| 质量前提 | 适用约束/验收无遗漏，权限/引用不越界，原验证与独立评审标准保持；关键约束违反即停止扩大候选 |
| 输入与生成开销 | 每个固定 Run 的完整 renderer token/上界、最终 provider usage、输出和 cached 字段分列；同时统计负责人、规划、摘要、执行、评审和失败尝试 |
| 实际收益 | 可比任务的端到端时长、重复读取、澄清轮次、返工/人工修正和模型调用数；同时保留失败/阻塞样本，样本不足只报告案例 |
| H2 | 不新增模型调用；完整简报能定位上游交付和阻塞，重启后可重建；先证明读取路径可用再宣称减少重复劳动 |
| H0c/H3 | 来源与真实绑定相符；批量读取与原 selector/Pack 结果等价，查询数、读行数和组装耗时单独比较，不把模型响应时间差归因于 SQL |
| H0b/H1 | 窗口准入与溢出可解释；长历史在质量前提下减少重复输入；将摘要生成、重算和额外输出计入总开销，未节省则保留 H2 而停用模型摘要 |
| C1 | 事件重复/无状态变化时无新增模型调用，事件批次最多一个控制 Run，附加调用严格受限；协调开销高于收益时收窄触发或保留原确定性调度 |

复用 `run.usage`/runUsage 的每 Run 最终已知快照汇总，不能对重放/累计 usage 事件逐条求和。缺失 usage 显示覆盖率和 unknown，不按 0 处理；provider 的 cached token 与 input token 包含关系按语义展示，不能重复扣减。估算 token、已报告 usage、货币费用分开；费用只有来源和币种可靠时汇总，不同模型/计价口径不得仅比较 token 就承诺省钱，更不能作为美元硬限额。

附加调用与任务主流程共享时长和并发，不能为摘要/负责人另开不受 Goal 约束的后台循环。C1 限额耗尽、摘要失效或缺少容量信息时要展示可操作原因；恢复读取、人工查看历史和 Server 的停止对账不消耗模型调用额度。发布时给出实测样本与完整限制，再决定是否默认开启；本文不预填收益百分比。

H3 实施前后用相同数据库夹具覆盖 0、1、10、100 条依赖，并保留第 101 条触发的截断结果；加入大量无关项目 Memory、多次执行和不同数量产物。比较完整有序 payload/source_memory_ids、实际 SQL 数与读行数，检查跨租户及 URI/metadata 隔离。PGlite 和 PostgreSQL 分别测量组装耗时与事务持有时间；不在单测里用脆弱的毫秒阈值代替结果等价和查询数断言。

## 14 迁移与发布

新增 schema 与追加 SQL 迁移同批交付，实施时使用最新迁移号之后的编号，不预占编号或修改历史迁移。采用 expand-first，保持旧入口和旧普通任务兼容。

历史所有权回填可重复、可审计，未知保持未知。先部署识别新能力的节点和服务端；旧节点可继续普通手工路径，要求新技能等能力的请求阻塞。各功能使用服务端开关，enforced 授权检查不能随 UI 关闭。

回退以关闭新入口、暂停新规则和排空/保留在途请求为主，保留审计记录。升级后不直接启动不理解新授权的旧 Server。需要旧版本恢复时，使用匹配备份恢复到独立数据库或目录，并核对迁移后写入，不能只回退镜像。

实际发布遵循既有不可变版本、加密备份、独立恢复验证、单所有者切换和健康检查流程；本方案不增加部署授权。

观察指标包括预览差异、等待原因、意图到启动延迟、幂等命中、发送补偿、授权拒绝、停止未确认、GitHub 同步年龄、技能准备失败、委派耗尽和规则暂停。另记录上下文溢出/未知容量、必需输入完整性、摘要失效/命中、usage 覆盖、协调 no-op 和附加调用占比，按 13.2 评估净收益。标签使用低基数原因码，不放正文、凭证或任意文件路径。

## 15 设计收敛标准

本版完成了以下设计复核：现状与所列 main 基线一致；请求、原始授权与执行所有者分离；事务、投递、同步、技能准备和自动化的失败路径有明确处理；等待、取消、撤权和 no-op 有权威来源；负责人、模型容量、摘要、结构化交接和事件合并有实施路径；已有 Memory 复用、发言来源和批量读取保持兼容；高 ROI 顺序、额外调用限额和净收益测量相互对应。此处“完成”指方案静态复核，不是运行或验收结果。

实施时保留三个必须先完成的技术门槛，处理方式已确定：

- T1：在 A0/A2 验证现有事务与锁顺序。不能保证原子绑定或无网络 I/O 泄漏时阻塞 A3，继续修正 helper 和锁顺序；不得以先建 Run 再补意图代替。
- T2：在 B2 验证 Codex/Claude 对每种目标执行模式的源码外只读交付。只开启实际合格的组合，其余请求明确拒绝；不放宽验证 profile、增加 Shell 权限或覆盖用户配置来获得表面兼容。
- T3：在 H0 验证实际模型身份、窗口上界、完整 renderer 的计数与节点启动前校验。不能证明边界时不宣称容量适配，不发送已知无法容纳的必需集；保留并准确标注旧手工路径的支持范围。长程工具预算另行资格验证。

上述技术门槛是实施验收任务，失败时已有明确的阻塞和支持范围决策。后续根据新代码事实、验收反馈和本次确认的产品需求修订；每轮形成可实施的实质增量再合并，不为措辞调整持续扩大设计范围。

## 16 依据

竞品依据为已有《Multica 技术架构方案》《Paperclip 技术架构方案》及 Codex、Claude Code 架构图。它们是指定时点的分析资料；本文不复述未独立复核的星数、默认工具数或最新版本结论。

- [Multica 仓库](https://github.com/multica-ai/multica)与[官方文档](https://multica.ai/docs)。
- [Paperclip 仓库](https://github.com/paperclipai/paperclip)；分析资料重点涉及 durable continuation、heartbeat protocol 和 execution policy。
- [项目开发约定](../AGENTS.md)、[项目 Squad](project-squads.md)、[Skill 发现](skills-discovery.md)、[资源生命周期](resource-lifecycle.md)。
- [Agent Team 与验证边界](agent-team-development.md)、[Goal/Plan Web 入口](../apps/web/src/components/GoalsPage.tsx)。
- [Assistant 服务](../apps/server/src/services/assistant-service.ts)、[任务生命周期](../apps/server/src/services/lifecycle-service.ts)、[GoalRunner](../apps/server/src/services/goal-automation-service.ts)。
- [Scheduler](../apps/server/src/services/scheduler.ts)、[任务策略](../apps/server/src/services/task-execution-policy.ts)、[节点验证判定](../apps/server/src/services/verification-service.ts)。
- [费用支持边界](../apps/server/src/services/budget-policy.ts)、[PostgreSQL 单所有者约束](../packages/storage/src/db/postgres-db-client.ts)、[数据库 schema](../packages/db/src/schema.ts)。
- [节点协议](../packages/protocol/src/node-messages.ts)、[Web 查询键](../apps/web/src/app/queryKeys.ts)、[生产发布流程](github-actions-production-release.md)。
- [节点执行与启动恢复](../apps/artood/src/node-client.ts)、[启动重放](../apps/artood/src/pending-start-replay.ts)、[Server 节点绑定](../apps/server/src/node-binding.ts)。
- [Agent 历史](agent-history.md)、[上下文契约](../packages/domain/src/context-pack.ts)、[上下文组装](../apps/server/src/services/context-pack-service.ts)、[实际渲染](../apps/artood/src/process-adapter.ts)、[分页读取提示](../apps/artood/src/runtimes.ts)。
- [现有协作记录](../apps/server/src/services/collaboration-service.ts)、[usage 与运行事件](../apps/server/src/services/run-service.ts)。
- [Memory 选择契约](../packages/domain/src/memory.ts)、[Memory 服务](../apps/server/src/services/memory-service.ts)、[上下文回归](../apps/server/src/context-pack.test.ts)、[依赖交接回归](../apps/server/src/context-pack-handoff.test.ts)、[对话时序回归](../apps/server/src/services/assistant-service.test.ts)。
