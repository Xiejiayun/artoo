# F2 成本预算的计量契约与启用门槛

状态：设计决议，尚未启用。基线 `7aff640a01b3d1cb429f5deed274b8dd45c0c58a`。保留现有手动 Goal/Run 行为；`max_cost_usd` 继续在创建、恢复与调度边界拒绝。本文不是已有 wire schema，不给旧 `run.usage` 新语义，也不表示任何 Runtime 已具备可信计费能力。

## 当前证据

- `apps/artood/src/structured-output.ts`：Codex `turn.completed` 提取 Token，未上报美元费用；Claude `result.total_cost_usd` 可以展示，但通常到进程结束才有最终费用，错误/中断可能缺报。plain 自定义适配器也能输出 `run.usage`。
- `packages/domain/src/node-payloads.ts`：旧 RunUsagePayload 字段均可选，没有完整性、修订、计量范围或价格来源声明。字段缺失代表 unknown，不代表 0。
- `apps/server/src/services/run-service.ts`：旧 Usage 是按 Run upsert 的当前快照，部分字段缺失会保留已有数据库值；事件是快照，不是可累加账单。协议 receipt 去重只确认传输身份，不能证明供应商账单准确或完整。
- `goals.elapsed_cost_usd` 为 nullable real，目前不能作为精确金额账本；已有 UI 费用是 Provider 报告的观测，不是预算权威。
- Goal 可能触发规划/评审/研究/导入/验证/修复/发布等专用执行路径。只聚合 tasks→runs 会漏掉不走普通 Run Usage 的费用，不能宣称覆盖整个 Goal。

因此，仅把 `max_cost_usd` 加入 PAUSE_BUDGETS、累加旧 usage 或允许 Claude 类型均不成立。当前未得到覆盖全部相关执行的已验证计量 Profile/Provider 集成，不能以模型回答、Token 估算、fixture 价格或 Runtime 名称替代。

## 选定的 v1 语义

采用独立、可选的版本化节点计量扩展，不修改旧 payload 的含义，也不把计量字段放进模型输出 schema。范围是**当前执行绑定的一个供应商计费会话的累计金额**，不是事件增量。一个计费会话只属于一个组织/Goal/执行；若 Provider 允许继续同一会话，必须保留原执行身份与账本，不得把累计金额再次作为新 Run 成本。

未来正式实现的最小记录需包含：

| 字段 | 规则 |
| --- | --- |
| version / kind | 固定 v1、session_cumulative；未知版本拒绝，不能退回旧 Usage 记账 |
| organization、goal、execution kind/id、run（适用时）、computer、node session generation | 从受信服务端分派与节点会话解析，不能让 payload 选择归属 |
| provider / provider account reference / billing session ID | Profile 绑定来源；account 使用非密钥、不泄密引用；同组织计费身份唯一 |
| meter profile ID/version/fingerprint | 受保护节点本地配置与已验证 Provider 采集器；用户任务文本、远程 argv 和模型输出不能选择或覆盖 |
| revision | 每计费会话持久化、严格递增的正整数；重启不归零 |
| amount_microusd / currency | 规范十进制整数串、非负、精确百万分之一美元；USD 固定；不使用浮点累加，不执行隐式汇率转换 |
| completeness | partial 或 final；final 是供应商计费范围的结算声明，不代表进程关闭；缺失不是 final 0 |
| correction_of_revision / source receipt digest | 费用减少或 final 后修正必须显式引用当前已知修订，并保留原始来源证据摘要；禁止无归因倒退 |
| observed_at | 仅用于审计和新鲜度，不能用时钟先后替代 revision 顺序 |

费用包括输入、输出、缓存、额外工具/检索等 Profile 承诺的可计费项。Profile 必须明确 Provider 报告是实际金额还是估算、订阅/促销/退款如何表示，以及金额精度与舍入规则。若只能估算，单独展示 estimate，不进入预算账本；不把缺失费用乘以当前公开单价补成“实际支出”。更细精度来源必须先定义受审计舍入，不能静默截断。

## 幂等、乱序与修正

正式实现需要追加有序迁移：不可变 receipt 表 + 每计费会话当前投影 + Goal 精确汇总/unknown 状态。schema 与 SQL 一致，旧事件保持原样且预算资格为 unknown。receipt 唯一键绑定组织、计费身份和 revision，不能只依赖传输 sequence。

在同一事务中先锁 Goal，再按稳定顺序锁计费会话：验证执行/节点世代/Profile/来源绑定 → 插入 receipt → 更新会话投影 → 按新旧累计差额更新 Goal 汇总和 unknown 状态 → 生成审计事件。所有金额使用整数/数据库 numeric，投影和汇总一起提交。整个 Goal 的并发准入也锁同一 Goal，不能在事务外先读费用再启动。

- 相同 revision、相同规范化内容：无变化；原传输重放或新 sequence 重发都不重复记账。
- 相同 revision、不同内容：拒绝冲突，保留证据，不覆盖当前值。
- 更旧 revision：保留可审计的迟到 receipt，不修改投影/汇总；若是冲突同样拒绝。
- 更高 revision、金额不减：累计差额入账；允许遗漏中间 revision，因为记录是累计值。
- 更高 revision、金额减少或 final 后修改：仅接受绑定当前 revision 的显式 correction，差额可负；历史不可变，汇总仍精确。退款不自动恢复已暂停 Goal。
- final 后 partial、错币种、错会话、错执行、错组织/节点世代、缺失/失配 Profile：拒绝并维持 unknown/暂停后续准入，不把计量错误误判为进程已停。

节点需先持久化绑定及待发送 receipt，再发送；服务端应答丢失可用原 revision 重放。重新连接保留执行/计费身份，授权撤销和会话世代检查沿用原可信边界。服务端重启从 receipt 恢复并核对投影/汇总，不从可覆盖的旧 Usage 猜账。数据库备份必须包含 journal、receipt 与投影；恢复后先对账、重新确认 Provider 会话与 Profile，才能继续成本受限调度。

## Unknown 与超额策略

选定语义是“停止后续调度”，不承诺硬性支出上限。Provider 延迟和一个已启动执行自身可能超额，多个在途执行也可能造成更大超额。暂停不授权杀进程、撤销写租约或宣称真实关闭；这些仍走现有停止确认流程。未来 UI 必须明确显示该语义与已结算/在途/未知金额。

启用成本预算前，所有可达执行路径都要有明确的支持能力。未知 Runtime、动态更换到无计量 Profile、未覆盖的工具/阶段和未知旧执行一律拒绝新的成本受限执行，普通无限费用 Goal 保留现有行为。迁移不能把旧 Goal 的 unknown 当作 0 后自动开始执行。

- 尚未执行且没有既有计费会话：已知累计 0，可准入第一个已验证、已绑定的执行。
- 在途会话只有 partial：展示已报告金额和未结算状态；如要允许并发新执行，必须存在另外已验证的预留/上界机制。v1 没有该机制，因此等待该会话结算后才准入下一项。
- 终态执行缺 final、进程/节点失联、来源超出 Profile 时限、未知专用阶段：标记 unknown，暂停后续调度；保留原执行恢复/停止与证据。
- 已知累计达到（含等于）limit：事务内阻止新准入，并通过现有幂等暂停/Checkpoint 记录原因；在途费用后续报告仍入账。
- 修正降到 limit 以下或补齐 unknown：不自动恢复，沿用操作者的显式恢复与事务内重新验证。

规划、独立评审和失败重试本身也必须计费。不能先让这些阶段执行，再声称执行准入已覆盖整个 Goal；无法绑定其成本时，相关 Goal 模式继续拒绝成本预算。实现不依赖独立数据库轮询的及时性来建立准入 fence。

## 启用前验收清单

1. 针对每个宣称支持的 Provider/版本和全部 Goal 可达路径，证明真实计费范围、终态/中断/失败来源、同会话继续语义与修正行为；绑定受保护 Profile 和工具链指纹。当前尚无这套证据。
2. 契约兼容：旧节点/旧 Usage 仍可执行并展示观测，不能获得成本资格；未知扩展版本失败；模型/自定义 plain frames 不能获得受保护计量身份。
3. 事务回归：相同/新传输重放、乱序、冲突、补报、退款修正、并发上报、并发准入、跨组织/Goal/Run/会话拒绝；在每个提交边界重启后精确金额与未知状态一致。
4. 持久化回归：旧库新迁移、升级失败回滚、备份恢复、receipt 重放重建、数据量增长及 PostgreSQL/PGlite 兼容；不可修改旧迁移。
5. 行为验收：达到边界、单项超额、终态缺报、断连恢复、错误 Profile、专用阶段、显式恢复；只暂停后续调度，在途停止/关闭语义不变。UI 不显示硬限额承诺。
6. 完成这些后，才修改 supportedGoalPolicy、PAUSE_BUDGETS、所有专用阶段准入及 UI。启用时须重新冻结版本并进行真实 Provider 产品验收，不能引用本设计或受控夹具宣称完成。

F2 当前完成的是该前置决议；生产计量、事务账本、成本准入和 UI 启用均未完成。继续推进独立的代码/客户端优化，最终交付必须单列此缺口。
