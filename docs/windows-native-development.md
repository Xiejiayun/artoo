# Windows 原生执行与多电脑协作

截至 2026-11-08，`97b3779` 的新构建、打包和 Windows 原生启动关闭检查通过。标准双节点验收 r13 从一次需求完成调研、节点验证和独立审核，源节点上传成功，但目标节点导入在 Git 初始化前失败。关闭后的数据库副本取证确认服务端已收到上传成功和导入不确定两个结果，纠正了此前使用较早快照作出的“仍卡在上传”判断。该轮由操作者暂停，两个节点均在正常停止超时后完成原生进程清理，CLI 和外层验收均失败退出；不是无人介入的成功验收。

已定位到导入时 Git 的工作目录位于 Guardian 允许的产品工作区之外。修复将启动目录改为原工作区，并显式指定受保护的暂存目标，不扩大执行边界。67 项相关回归及类型检查已通过；这些回归使用受控原生边界。完整产品流程、日常入口和产品重新打开仍待验收，目前不能据此认定可日常使用。最新状态见 [Agent Team 开发说明](agent-team-development.md)。安装版签名分发、外网生产托管和实体两电脑完整流程仍未验收。此前 `083dce3` 启动 r14 和 `007b7a1` 打包失败的记录仍保留，后续通过结果不证明其原始原因已被定位。

后续诊断版本 `007b7a1` 的工作区构建通过，正式候选打包却因新复制程序的读取稳定性检查失败而中止，失败包已保留。新增诊断的 18 项读取回归、15 项打包回归（另 1 项既有平台跳过）及三次独立打包观察通过；原始失败仍未定位，不能以这些后续结果认定完整使用流程已通过。

2026-11-06 的隔离 Aerial 历史验收中，四个阶段均经独立审核接受，发布回执为 `published`，健康检查 HTTP 200；设计期间发生两轮自动修复。原始进程 exit/close 0、双 EOF、29,123 项输入未变，清理通过、临时工作区已删除、TEMP 为空。见[本次完整记录](../artifacts/windows-agent-team-live-revision-2026-11-06-r2/native-live-revision-r2/README.md)。使用真实模型、原生进程和浏览器，但传输／授权环境是隔离测试配置；发布站点及制品存储随测试清理，没有永久导出产品。此次没有覆盖已接受设计的追加返修分支。此前 45 分钟超时失败的[历史记录](../artifacts/windows-agent-team-live-job-2026-11-06/native-live-job-r1/README.md)仍保留。

本次已将 137 个候选文件集成到主项目，包含原生 Windows 标准节点接入、跨电脑调研传输／审核／一次设计续写、启动错误诊断，以及本地自动设计返修。组合构建通过，返修测试 **121/121**、兼容测试 **109 通过／11 个既有 POSIX 用例跳过**；真实 Windows Job → 私有 CLI → Chrome 的作者侧和只读审核侧验证均通过，三个不合格输入在执行前被拒绝。见 [组合及原生记录](../artifacts/windows-design-revision-candidate-2026-11-06/validation/combined-r2/README.md)。集成后主树四项检查另见 [本次集成记录](../artifacts/windows-agent-team-native-integration-2026-11-06/README.md)，不能以候选结果代替主树结果。

自动设计返修只接受实施阶段独立审核员提出的结构化追加回归请求：保留已接受设计的全部原字段和旧用例，只向已有工作区验收条件追加用例；沿用原重试预算，重跑全部用例并经另一身份审核后，才更新下游输入。它要求本机原生 Job、policy-v2、v3 全设计用例验证配置及真实制品存储，不支持任意重写需求或跨电脑导入设计的返修。跨节点代码已包含调研传输、独立审核、设计续写及审核、实现及审核、最终验证和发布接力；当前标准完整流程仍待通过验收，也尚无实体两电脑全流程验收。配置见 [原生来源节点说明](windows-native-source-nodes.md)。

现有 `local-team-2026-11-06-job-r1` 环境已完成备份、恢复副本迁移验证及 0033–0038 迁移指纹升级，并通过普通启动验收，可使用本次构建。原数据库和 Builder／Reviewer 身份已保留，不能重复 `prepare` 或 `--smoke`。旧源码、构建文件和非秘密配置已保存；升级与普通启动的实际结果见[本次集成记录](../artifacts/windows-agent-team-native-integration-2026-11-06/README.md)。

此前浏览器 Job 集成已将原生 Job 与节点到 CLI 的私有配置链路整合到本地代码。真实 Chrome 的正常关闭、外部中止、外层取消三项均通过；另一次真实节点 → 私有 CLI → Job 浏览器 → v3 存储测量封存通过，10 项缺失或错配授权被实际 CLI 拒绝。原始进程 exit/close 0、双 EOF 和输入不变均已确认，见 [组件记录](../artifacts/windows-browser-job-validation-2026-11-06/checks/native-component-1/README.md) 与 [完整验证器链路记录](../artifacts/windows-browser-job-validation-2026-11-06/checks/native-integration-r2-1/README.md)。这两项使用受控产品，不是模型开发或发布验收。整合后主树的四项检查全部通过：类型检查、构建、**3,698 项源码测试通过／88 项跳过／0 失败**（348 个文件通过、11 个文件跳过），以及 **Web 27/27**。每项均确认实际 exit/close 0、双 EOF 和 977 项已列明输入不变，见 [该轮主树验证记录](../artifacts/windows-browser-job-integration-2026-11-06/README.md)。下文此前结果仍属各自基线。

新路径由节点保护的浏览器配置显式启用：`"windows_browser_process": { "version": 1 }`。节点要求已通过安装检查的原生后端，私有文件必须在全部 Agent 可写目录之外，并通过 Windows ACL、原始文件身份和独立环境摘要检查；子进程重新检查安装后才启动浏览器。未启用的普通执行保留原行为。旧本机 r2 配置不自动改写。

普通浏览器路径在未来的 `descendant_precedes_parent` 初始观察失败中，可随原私有错误帧记录 `ancestry_failure` v1：原 root／parent／child PID、精确 FILETIME 十进制字符串、Int64 类型、负差值及 attempt／census。该有限负证据只用于诊断，保留原拒绝、退出历史、清理条件和时间预算；连接关闭失败另以 `connection_close` 标记阶段。它不能解释或修复此前未保存失败边的事故，也不授权忽略旧 PPID、终止额外进程或发布产品。无扩展的旧帧继续按原规则处理；脚本与消费者必须同版交付，旧消费者会严格拒绝新扩展。

当前本机入口是 [Windows Job 本地使用说明](../artifacts/windows-local-use-preparation-job-2026-11-06/USE.md)。新环境 `local-team-2026-11-06-job-r1` 已完成唯一一次准备和启动 smoke：server、worker、Web 均成功就绪并正常 exit/close 0，双 EOF、无强制终止；2,125 项启动输入未变。全部目录与旧环境保护检查通过，数据库和 Builder／Reviewer 身份保留，服务目前已停止。后续只使用普通 `start`，不要重复准备或 smoke。该启动检查没有调用模型、提交需求或验收真实设备配对；完整模型流程由文首所链接的独立 Aerial 验收覆盖。

此前主树完整源码回归已通过：**3,474 通过、88 跳过、0 失败，334 个文件通过、11 个文件跳过**。原始进程实际 exit/close 0、stdout/stderr EOF 已确认，949 项已列明输入保持不变，见 [最终源码记录](../artifacts/windows-storage-budget-integration-2026-11-05/final-source-1/source.json) 和 [存储测试预算集成说明](../artifacts/windows-storage-budget-integration-2026-11-05/README.md)。原生 Aerial 完整验收 `native-live-2` 已在原 45 分钟时限到期后失败并关闭，见 [最终失败记录](../artifacts/windows-agent-team-live-2026-11-05/native-live-2/README.md)。只有调研阶段被接受（1/4）；设计多次通过 52 组浏览器用例/视口执行，但三次独立设计审核均因缺少真实 malformed localStorage 恢复测量而拒绝。实现、最终验证和发布未执行。实际 exit/close 为 1，2,045 项已列明输入不变；清理通过、工作目录已删除、测试 TEMP 为空，独立 Codex home 保留。源码回归通过不能替代这次失败的完整产品验收。

新的受保护 `storage_precondition` 能力与有界 87 观察修复已完成 r4 隔离构建、类型检查和 **712 项回归，1 项 POSIX 跳过**，见 [r4 检查选择](../artifacts/windows-storage-precondition-development-2026-11-05/validation-r4/core-check-selection.json)。随后 `native-r3` 的八项真实 Windows 浏览器测试 **8/8 通过**：实际 exit/close 0、stdout/stderr EOF、1,880 项输入不变及空 TEMP 均已确认，见 [原生验收说明](../artifacts/windows-storage-precondition-development-2026-11-05/native-r3/README.md)。28 文件组合已集成主树，其中 27 项更新、1 项保持原样，见 [集成记录](../artifacts/windows-storage-precondition-integration-2026-11-05/applied-r1/result.json)。集成后的主树四项完整检查全部通过：类型检查、构建、**3,555 项源码测试通过／88 项跳过／0 失败**（340 个文件通过、11 个文件跳过），以及 **Web 27/27**。实际 exit/close 均为 0，双 EOF 和 959 项已列明输入不变已确认，见 [主树验证记录](../artifacts/windows-storage-precondition-integration-2026-11-05/README.md)。文中此前源码结果属于较早基线。

随后第三次原生 Aerial 完整产品验收 `native-live-3` 因重试预算将被超出而失败，并非 45 分钟超时。调研被接受；设计重试通过 60 组最终浏览器测量，但停在审核，最终审核意见未被报告保留，不能推断已接受。实现、最终验证和发布未执行。期间记录了 CLI/provider 流断开和独立的 `descendant_precedes_parent` 进程观察错误。实际 exit/close 1，2,071 项已列明输入不变，测试清理通过、TEMP 为空，独立 Codex home 保留；见 [第三次完整验收记录](../artifacts/windows-agent-team-live-2026-11-05/native-live-3/README.md)。[只读诊断](../artifacts/windows-browser-parent-pid-audit-2026-11-05/DIAGNOSIS.md) 确认原始 PPID 候选在身份关系校验前进入退出历史；事后旧 Git 进程的父 PID 复用线索尚不足以证明原始报错的具体坏边。诊断候选未集成，不能宣称此故障已修复。

此前 `native-r2` 的 7 通过、1 失败记录仍保留：`invalid-schema` 用例因 `process_open_invalid_parameter` 未能确认浏览器退出，见 [原失败记录](../artifacts/windows-storage-precondition-development-2026-11-05/native-r2/execution/result.json)。此次八项通过证明受控浏览器存储恢复与拒绝错误实现的能力，不是模型从需求到发布的验收，也不改变上述 `native-live-2` 的失败结论。

## 当前使用范围

| 能力 | 状态与边界 |
| --- | --- |
| Windows 控制端与普通执行 | 已有桌面应用、设备配对、运行时配置与普通任务路径。实际可执行性还取决于该电脑的 CLI、模型鉴权和权限配置。 |
| 多电脑、多 Agent | 每台电脑可以配对到同一服务端，注册多个绑定不同 runtime/workspace 的 Agent 实例。普通任务和讨论可以路由到不同电脑。CLI 被发现只表示程序存在，不代表模型鉴权成功。 |
| 自治团队阶段与独立审核 | 本地完整阶段流程使用同一电脑、同一普通工作目录，审核者必须是另一 Agent 身份。已集成跨节点调研传输、测量映射、独立审核、设计、实现、验证和发布接力；当前标准完整流程及实体两电脑验收仍待通过。 |
| Windows 原生自治执行 | 已实现 Job Object 后端、受保护安装准入及启动时的验证 profile 绑定。只有本地资格检查通过才宣告能力。真实 Aerial 从空工作区到健康本地静态网站发布的完整流程已通过一次隔离验收。 |
| Windows 桌面自动验证配置 | 已接入开关、本地 JSON 文件选择和打包 helper 的固定清单绑定；控制器与界面回归通过。保存设置不代表节点已通过资格检查，尚无安装版全流程或签名分发验收。 |
| Windows 浏览器产品验收 | 已集成明确错误分类和原时限内的完整观察重试，192 项重点回归、受控原生正反例及 44 项工作量通过；该历史主树版本的完整 Web 为 27/27 通过；当前候选的 Web 回归另行验收。此前 26 通过、1 失败的句柄打开故障记录仍保留，其精确原生原因没有被追溯证实。 |
| Windows 自动发布产品 | 原生静态网站发布器与桌面独立开关已集成，最终主树的 4 项真实发布测试通过。仅显式本地配置、已合格的本地固定 NTFS 存储，以及与验证器相同的已准备原生进程后端共同满足时才启用。候选原生测试不能替代最终集成或完整模型产品验收。 |

普通多电脑使用需要一次环境配置：每台电脑连接同一 Artoo 服务端并完成配对，在桌面设置中选择本机 runtime 和允许工作目录，再注册对应 Agent 实例。各电脑独立保留模型凭据。电脑之间不会自动共享 `C:\...` 路径或产品源文件。配对与服务端配置见 [preview operations](preview-operations.md) 和 [shared server](shared-server.md)。Aerial 设置及现有安装版测试步骤见 [Windows provider verification](windows-copilot-verification.md)。

本地源码使用入口见 [Windows 配置审计](../artifacts/windows-local-entry-audit-2026-11-05/README.md)。开发 server 的 import-only 启动回归已修复并集成，主树类型检查、构建及两项真实启动/退出回归通过，见 [入口集成](../artifacts/windows-dev-launcher-integration-2026-11-05/README.md)。这修复了服务启动，不代表配置模板已部署或完整产品流程已通过。

此前本机入口是 [Windows 本地开发预览 r2](../artifacts/windows-local-use-preparation-storage-2026-11-05/README.md)，已在新目录中准备包含 `storage_precondition` 的配置，通过唯一一次启动 smoke（2,080 项输入不变）和随后一次普通启动、身份复用及正常关闭验收（各记录步骤 2,081 项输入不变）。原始启动进程及 server、worker、Web 均实际 exit/close 0、双 EOF、无强制终止；现有数据库和双 Agent 身份一致，工作及授权表前后为空。环境目前已停止，数据库目录和双 Agent 绑定保留，启动锁已移除，4400/5178/4174 无监听，见 [普通启动关闭后审计](../artifacts/windows-local-use-preparation-storage-2026-11-05/validation-normal-r1/post-run-audit.json)。文档提供 r2 普通 `start` 命令；首次模型使用仍需在 Settings 审阅 AI data sharing。此次未提交目标、调用模型或验收真实配对，不能替代完整产品与安装版验收。已有 r2 环境不能再次执行 `prepare` 或 `--smoke`。

[旧 r1 入口](../artifacts/windows-local-use-preparation-2026-11-05/README.md) 及其 [正常启动与重开验收](../artifacts/windows-local-use-preparation-2026-11-05/NORMAL-VALIDATION.md) 作为历史记录保留。原生命周期套件仍为 2 通过、1 失败：父进程手动 IPC disconnect 未收到原始 ChildProcess 的 close，失败记录不变；本次 r2 普通启动通过私有 IPC 正常关闭，未重跑该故障场景。

跨电脑自治交接的独立候选已完成隔离节点编译、类型检查和 195 项重点回归（1 项既有平台跳过），并修复开启调研导出后影响后续阶段的问题，见 [r1 验证记录](../artifacts/windows-cross-computer-integration-2026-11-05/VALIDATION-r1.md)。该早期候选当时未集成，仅支持 research／measurement policy v1 首跳；本次 policy-v2、browser-v3 的接力范围与限制见本文开头。

## 本次原生验证

- 37 项控制协议回归通过，并已纳入常规 `npm test`。这些是模拟 helper/pipe 事件的协议测试。
- 真实 Windows 子进程测试验证了后代清理、超时、取消、父输入断开、无效可执行文件和输出流处理。无效 PE 首次返回 Windows 错误 216，而用例原先只接受 193；用例现限定接受这两种具体 loader 拒绝，修正后的单项实际通过。
- 独立原生观察器分别强制结束本次创建的 helper 和 daemon，确认各自进程 HANDLE 与后代 HANDLE 已退出。helper 丢失时，生产封装仍报告清理未确认；观察器不会补造成功回执。
- `windows-verified-node-real.test.mjs` 使用真实 Git、Node 进程和新构建的 helper，已通过初始化、作者写入、验证、另一身份审核及再次验证的完整串联。源码摘要、验证 profile 和请求绑定一致。作者/审核者是受控测试程序，不是模型生成产品的验收。
- 修复了本机 NTFS 首次读取刚写入文件会更新 `ctime` 的误判。验证器固定文件句柄、限制读取字节数，并检查句柄与命名路径的文件身份、链接数、大小和修改时间；Windows 的两遍内容摘要必须一致，且第二遍前后句柄和路径的 `ctime` 必须稳定，拒绝读完后的改写。POSIX 保留原 `ctime` 检查。新增 15 项回归通过，其中 1 项使用未模拟的 Windows 文件系统。
- 本地 Aerial `http://127.0.0.1:18181/v1`、原生 Codex、`gpt-6.1-sol` 已完成实际 `artoo_workspace.context` 调用并返回准确内容，随后确认 CLI/helper/后代清理。只复用了本地 Aerial 凭据，没有把密钥写入参数或测试日志。
- 另一项真实 Codex 文件读取测试未通过：只读 PowerShell 命令被自动审批以 `blocked by policy` 拒绝。上下文工具的通过不能替代这项文件读取验收；没有关闭沙箱或绕过审批。
- 后续新增受限只读 MCP 接口：规划只能读绑定上下文；独立审核只能读当前请求绑定的已测量源码。新的 Aerial 实测通过规划 `context`、审核 `context` 和 `read`，准确返回随机标记，源码不变且审核后的节点验证通过。它没有调用通用 shell，也不改变上述 PowerShell 拒绝记录。测试源码仍是明确的受控 fixture。
- 真正的 helper 安装准入已在用户目录下的独立 `.artoo/native-development` 路径通过，核验完整清单、物理路径、NTFS、所有者和 DACL，并在使用前重查。本机 MSIX 重定向的 AppData 候选被拒绝，未放宽权限或改动 ACL；该结果不能代表任意桌面安装位置均可用。
- 桌面启动、只读工具、安装准入与全部可写目录边界已集成。主树类型检查、构建、221 项重点回归、原生受控节点、Aerial 只读调用及桌面打包回归已通过；全量源码检查为 3,266 通过、1 失败、88 跳过，唯一失败是旧数据库升级测试超过 30 秒，Web 检查另有上述 5 项失败。记录见 [Windows 启动集成检查](../artifacts/windows-native-activation-integration-2026-11-05/)；旧基线的 3,132 通过、88 跳过不能替代后续改动的完整检查。

本次证据保存在 [Windows 集成记录](../artifacts/windows-native-runtime-integration-2026-11-05/)。其中历史 `typecheck.json` 是修复测试类型之前的失败记录；后续结果见该目录的 `RESULTS.md`，不要把旧记录覆盖为成功。所有结果均为本地验证，不是 CI、合并、签名安装包或产品生产发布。

浏览器修复的候选 76 项回归、原生正反例和主树类型检查/构建已通过，具体证据与历史失败见 [Windows 浏览器集成记录](../artifacts/windows-browser-integration-2026-11-05/README.md)。本次完整 Web 27/27 通过。随后真实 Aerial 完整产品验收超出 45 分钟：调研被接受，设计的三次最终验证遇到初始进程查询超时，第四次通过 44 项浏览器测量，但独立审核在时限处被取消；实现、最终验证和发布未执行。进程停止、工作目录删除及空 TEMP 已确认，2,012 项已列明输入不变。失败记录见 [原生完整验收](../artifacts/windows-agent-team-live-2026-11-05/native-live-1/README.md)。Toolhelp 独立候选的类型检查、构建、84 项回归、原生身份观察及浏览器正反例通过，但首次 44 项受控工作量仍因初始观察 deadline 与退出确认失败；候选未集成，不能宣称稳定性已修复，见 [冻结结果](../artifacts/windows-native-browser-verification-2026-11-05/toolhelp-observer-candidate/qualification-3.json)。后续常驻观察器的 11 个文件已通过独立审核和受控原生验收后集成：最小 Chrome、观察器取消故障、产品正反例及 44 项工作量均通过。主树类型检查、构建和 117 项重点测试通过，但最新完整 Web 为 26 通过、1 失败，发生在原型关闭时打开已枚举的后代进程句柄（process_open_failed），尚不能确认是进程消失还是访问失败。随后该边界的受限重采集与历史 PID 检查已集成，主树类型检查、构建、192 项重点回归和最新完整 Web 27/27 通过，见 [受限观察集成](../artifacts/windows-bounded-browser-integration-2026-11-05/README.md)；见 [常驻观察器集成](../artifacts/windows-persistent-browser-integration-2026-11-05/README.md)。这些阶段之后，最终全量源码检查已通过；后续 `native-live-2` 在设计阶段因未测 malformed 存储恢复而持续被独立审核拒绝，并在原时限到期后失败关闭。当前状态及最终记录见文首。

## 原生 helper 构建

在 Windows x64 安装 .NET 10 SDK 后，从仓库根执行：

```powershell
npm run build:windows-process-host --workspace @artoo/artood
```

输出 `apps/artood/native-dist/windows-process-host`，内含完整自包含程序和版本 1 哈希清单；最终用户无需安装 .NET SDK/runtime。命令拒绝覆盖已有目录，可通过 `-- --out-dir <新目录>` 指定新构建位置。清单在成功构建及完整文件校验后生成。构建已实际通过；重复使用同一目录会拒绝且不改变现有包。

构建规则见 [native helper guidance](../apps/artood/native/windows-process-host/AGENTS.md)。该命令不会启用生产节点、安装桌面包或开启发布能力。

## 为受保护执行准备独立 Node 运行时

执行器可以使用 Node 官方为目标版本和架构发布的 standalone 工件，安装到独立、完整且受保护的目录。例如，Node v26.13.0 提供 [Windows x64 的 node.exe](https://nodejs.org/dist/v26.13.0/win-x64/node.exe) 和对应的 [官方 SHA-256 清单](https://nodejs.org/dist/v26.13.0/SHASUMS256.txt)。选择其他版本或自定义构建时，应重新验证该完整安装与运行边界，包括其配套文件、原生依赖及 ICU 支持，并使用该版本自己的发布摘要和签名要求；本机对某一固定工件的验证不能外推到其他发行物。

将所选发行物需要的全部文件安装到新的本地固定 NTFS 物理目录，与 Agent 可写工作区分离。准入仍以这个安装目录为完整单位，执行原有路径、所有者、DACL、内容清单和前后文件身份检查。本次验证的官方固定工件，其独立安装目录只含 `node.exe`；这描述的是安装边界，不能据此认定进程只加载该文件或 Windows 系统 DLL。保留原有完整 Node/npm 安装及配套工具，依赖安装、构建和需要相邻 npm 的打包脚本继续使用原工具链。

首次建立生产准入基线之前，完成复制与文件刷新，核对安装后文件的预期长度和官方发布 SHA-256，并验证 Authenticode 状态、预期发布者身份及要求的时间戳；使用检查子进程时，应确认其实际正常退出、关闭及 stdout/stderr 双 EOF。完成这些安装检查后，再执行原有生产准入与后续审计。签名校验用于确认工件来源，不保证后续元数据不变；准入或审计失败时保留该次证据，不能把重新建立基线当作通过。

执行和验证配置中的 `programs.node`、`compiler.node`、相关清单及封存摘要必须选中同一安装后的可执行文件。实际封存、预检、节点和日常入口进程的 `process.execPath` 也必须与各自配置选定的 Node 一致，避免配置指向独立运行时、实际仍由构建用 Node 启动。更换安装目录后，重新建立该目录的清单和配置绑定；旧目录绑定的回执不能用于新安装。

同宿主重定位检查用于验证同一官方 Node 工件从原路径移到独立目录后的兼容性。两次检查使用相同工作目录、同一组已列明的环境约束、ICU/SQLite 操作和固定模块导入步骤；仅 Node 本身的两条固定路径映射为同一工件，其他已观察模块必须保持完整规范路径集合、内容哈希和文件身份一致。宿主注入模块可能同时出现在新旧进程中，应单列其来源及未纳入 Node 安装目录 ACL 的边界，并保持宿主设置不变。比较一致与有效签名不等于 OS-only 环境、第三方模块信任证明、未来不可变保证或全部延迟加载依赖已覆盖。

安装检查、同宿主重定位、组件预检、节点实际就绪、真实模型产品流程和日常入口验收应分别记录结果。前几项通过不能替代后几项；模型开发、独立审核、发布健康检查、正常关闭以及配置支持的产品重新打开，仍须以各自完成的实际验收为准。本节提供运行时安装与绑定方法，不更新本文其他阶段的通过或失败结论。

## 启用本地原生验证

这是开发配置入口，需要先准备一次运行环境。所有允许 Agent 写入的目录都必须与 helper 安装、验证 JSON、验证器程序及浏览器证据目录分离；不要把包含这些文件的共同父目录设为允许工作目录。该边界对普通任务也生效。缺少原生设置的普通 Windows 执行仍保留原行为。

命令行节点使用以下两个成对的本地变量，另按 [验证配置说明](autonomous-development.md) 设置 `ARTOO_VERIFICATION_PROFILES_FILE`：

```powershell
$env:ARTOO_WINDOWS_PROCESS_BUNDLE = 'C:\ArtooControl\windows-process-host'
$env:ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256 = 'sha256:<实际 manifest.json 的 SHA-256>'
$env:ARTOO_VERIFICATION_PROFILES_FILE = 'C:\ArtooControl\verification-profiles.json'
```

以上路径和摘要是示例，必须换成实际已准备的本机资源；这些设置不自动创建配置、注册节点或授权发布。仅支持原生 Windows 10+ x64、本地固定 NTFS、无重解析别名的物理路径。准入检查信任运行节点的当前用户、SYSTEM、Administrators 和 TrustedInstaller，不是抵御同用户任意原生代码的沙箱。原生验证与 managed 独立任务工作区不能混用。

桌面版先按 [daemon 打包说明](../apps/desktop/scripts/bundle-daemon.md) 把真实 helper 放入安装包，再在 Worker configuration 中勾选 **Enable automatic task verification**，选择工作目录外的验证 JSON，保存并启动 worker。桌面从安装包清单读取固定 helper 位置和摘要；界面不接受任务或 renderer 提供的 helper 权限。worker 启动后才执行完整安装与 profile 资格检查。缺少 helper 或安装位置未通过检查会拒绝启动。

桌面打包已补齐规划、研究和浏览器验证的可执行入口及固定版本 Playwright 依赖；浏览器本身仍需在本机准备。打包回归实际执行了 MCP 初始化和模块加载，但不代表 Electron 安装版、模型产品开发或发布验收。

## 配置 Windows 原生静态网站发布

发布器与桌面设置共 21 个文件已按哈希核对后集成，记录见 [发布集成清单](../artifacts/windows-publisher-integration-2026-11-05/integration.json)。主树类型检查、构建、325 项重点回归、4 项真实发布测试和 3 项实际 TCP 测试已通过，记录见 [主树验证](../artifacts/windows-publisher-integration-2026-11-05/README.md)。这些是发布器集成时的历史结果；后续完整主树检查及一次真实 Aerial 产品验收已通过，当前范围见文首。真实模型验收使用隔离认证传输和临时本地静态站点，安装版与生产托管仍未验收。

先完成上述原生验证配置，再按 [产品发布配置](product-publication.md) 准备独立发布 JSON 和已存在的存储目录。命令行节点显式设置：

```powershell
$env:ARTOO_RELEASE_PROFILES_FILE = 'C:\ArtooControl\release-profiles.json'
```

这是示例路径。发布配置和存储必须位于全部 Agent 可写目录之外；存储必须通过本机固定 NTFS、物理路径、所有者、DACL 和目录身份检查。发布 profile 还必须绑定该验证器实际准备的同一原生进程后端。模型、远程请求或序列化配置不能自行声明这些资格。存储审计失败会停止服务、中止进行中的操作并禁止后续状态写入，须修复后重新启动并通过准入。

桌面版先启用 **Enable automatic task verification**，再单独勾选 **Enable automatic product publication**，选择 **Publication profiles file** 并保存、启动 worker。发布默认关闭；关闭自动验证也会关闭发布。桌面重新检查启动配置，只向 worker 传递显式选定的本地文件，不继承 Windows 环境中隐含的发布设置。worker 负责完整 profile、存储和原生后端资格检查；保存开关本身不是验收或授权回执。

发布存储边界信任当前节点用户、SYSTEM、Administrators 和 TrustedInstaller，不是抵御同用户任意原生代码的沙箱。已测恢复范围是合格本地固定 NTFS 上的**进程终止与重启**；文件刷新和重命名不构成操作系统崩溃或断电持久性保证。保持节点服务运行，并为实际部署另行配置可访问端点、健康检查和恢复安排。

现有证据范围如下，详细记录见 [发布器交付说明](../artifacts/windows-release-storage-2026-11-05/DELIVERY.md)：

- 原生快照 7 的修正场景为 3/3，后续场景为 17/17，覆盖实际发布、回滚、取消、监控、非法日志及六个强制终止边界；实际 TCP 故障测试为 3/3。均有进程退出/关闭与输入不变记录。
- 最终快照 9 编译通过，七组定向测试为 116 通过、4 个 POSIX 条件跳过。原生快照 7 之后唯一生产代码变更，是把健康成功表达式的信号与 deadline 检查移到摘要、响应头、文本校验之后；最后这一行修复由受控 HTTP 回归覆盖，尚不能套用快照 7 的原生结果。
- 桌面候选六组测试为 62 通过、18 个平台条件跳过，Web 类型检查通过，见 [定向报告](../artifacts/windows-desktop-publication-2026-11-05/focused.json) 和 [类型检查报告](../artifacts/windows-desktop-publication-2026-11-05/typecheck.json)。这些测试未执行 Electron 原生文件对话框或安装版发布。

主树的 4 项真实发布测试已覆盖最终健康 deadline 修复后的代码，包括不可变发布、回滚、拒绝变更源码、首次发布时强制终止及存储故障；3 项实际 TCP 测试也已通过。首次原生完整 Aerial 验收因上述浏览器查询问题失败的记录保留；后续 `native-live-2` 也已失败关闭，仅调研被接受，设计的 malformed 存储恢复要求仍未通过独立审核，实现、最终验证和发布未执行，见 [第二次完整验收记录](../artifacts/windows-agent-team-live-2026-11-05/native-live-2/README.md)。最终全量源码检查已通过，签名分发和外网生产发布尚未完成。跨电脑集成范围限于调研传输、独立调研审核和一次设计续写，后续接力未集成，实体双机全流程尚未验收。

## 剩余工作

1. 完成实际桌面安装路径及分发验收。最新主树完整源码回归已通过；本地准入和桌面配置不能替代签名安装包验证。
2. 补充已接受设计追加返修（`design_revision`）分支的真实 Aerial 验收；本次完整产品流程已通过，但未触发该分支。
3. 补充安装版发布器和持久端点的验收；本次真实模型验收只证明临时本地静态发布及其点时健康检查。
4. 完成监督模式下跨节点完整链路的真实验收；调研传输、独立调研审核、设计及其审核、实现及其审核、最终验证与发布续接均已集成源码，仍需证明实际运行保留各电脑的路径和权限边界并正常关闭。
