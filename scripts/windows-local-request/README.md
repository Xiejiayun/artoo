# Windows 本机单需求入口

本入口把一次产品需求交给 Artoo GoalRunner，执行调研、设计、实现、测试、独立审核和配置内的交付。模型使用已配置的 Aerial `127.0.0.1:18181` / `gpt-6.1-sol`，其上游是 GitHub Copilot。无需 WSL。维护者在安装时选择静态 Web、应用开发或有界本机应用发布；最终用户仍只提交一次需求。

省略新增应用配置时保持原静态 Web 路径：两个独立原生 Windows 监督节点、四个逻辑 Codex agents，以及下述源端与目标端工作区池。应用模式使用同一电脑的一项普通原生 daemon、其原始 IPC owner 和两个独立 agents；每次执行仍受原 native ownership 管理。它不启用静态源交接、shared supervisor 或 source recovery。

## 维护者配置应用模式

本节是新增的安装接口，不表示当前安装已经通过真实使用验收。维护者须将完整工具链、匹配的 daemon/Web/server 和这些入口文件作为同一版本交付；用户不填写以下 JSON。

`LOCAL-INSTALLATION.json` 可增加可选 `product` 对象：`version: 1`、`kind: "local-application"`、`delivery: "development"` 或 `"publication"`、`verification_profile_id` 和固定 `origin`。`origin` 必须是精确的 `http://127.0.0.1:<port>`，不自动变更端口。开发模式禁止发布字段；发布模式还须指定 `publication_profile_id` 与完整 `limits`。这些字段不来自 Objective 或模型输出。

`limits` 使用原 `ApplicationPublicationLimitsV1` 契约：`root_lifetime_ms`、`startup_timeout_ms`、`health_timeout_ms`、`normal_drain_reserve_ms`、`health_interval_ms`、`health_freshness_ms`、`maximum_service_generations: 2`、`maximum_requests_per_generation: 256`、`maximum_concurrent: 1`、`maximum_health_rounds`。应用验证固定 operation timeout 为 30 秒，正常排空配置至少须留 47.5 秒，原节点还会做完整校验；总租期必须覆盖初始化、两代服务、健康检查和排空，不延长或重置已有预算。

安装清单还须增加 `application: { version: 1, tools, trees }`。`tools` 包含原生产配置所需的 `compiler: { helper, helperManifest, node, entry, configuration }`、`runtime: { helper, helperManifest, entry, vendorManifest, guestBootstrap }`、`broker`、`hostManifest`。每项使用安装清单既有的 `{ path, bytes, sha256 }` 裸十六进制摘要，compiler 的 Node 必须等于 `programs.node`。`trees` 是完整工具目录数组，每项 `{ root, tree }`，包括所有嵌套模块、vendor、host 和 compiler 依赖；目录不得重叠，每个工具 pin 必须被一个完整目录覆盖。入口会转换为生产 profile 所需的 `sha256:` 格式，保留原嵌套配置的生产校验。

每次请求创建新工作区、验证存储、独立发布存储与配置目录。真实 pairing/claim/enroll 返回 computer ID 后，入口通过已绑定 daemon bundle 的 `describeWindowsApplicationEntryVerifier` 读取本地 verifier 的完整准入描述，再写本机发布配置。此描述不返回进程或候选权限；discovery 和实际 daemon 各自重新完成 ACL、hash、工具、原生能力及完整写入根检查。安装清单不允许任意运行命令或未绑定 `apps/artood/dist` 导入。

应用发布使用既有 prepared `app_publication` 请求，应用开发使用单独的 `app_delivery`，两者都不携带静态 `release_profile_id` 或 `source_handoff`。Console 和 Browser 的唯一提交者、原用户授权、稳定请求 ID、GoalRunner 与验收/独立审核路径相同。

`development` 完成后输出 `local-request.delivered` 和验证工作区，随后正常关闭；`product_published` 为 false，也没有产品 URL。`publication` 完成后才输出真实 URL、原租期截止时间和剩余请求数。`healthy` 表示新鲜的节点 HTTP/数据库健康测量，`live` 仅表示原服务 owner 和预算仍有效，不将历史健康记录显示为当前健康。`draining` 显示不可用并等待实际关闭；缺失、过期、unknown 或不匹配的原发布事实保留为失败。

应用停止先同步关闭本次 prepared session 的提交入口，等待已准入的原始提交事务完成，再从原用户、session 和 request key 找回已提交的 goal。即使浏览器或 Console 尚未收到提交响应，也会对同一 goal 调用正式 cancel（尚未完成时）或 application publication stop；不会补发需求。此关闭操作仅供原本机 Server owner 调用，不增加 HTTP 权限或暴露 Console request key。停止后本次 session 不再接受提交，普通项目的手动请求不受影响。

停止时复用并核验已有的原始 `GOAL.json`；记录缺失时才独占创建。已知 goal ID 但尚未保存记录也可正常补齐。现有记录内容冲突会保留为失败，不覆盖原记录，也不会因为正常路径已经保存过记录而重复创建失败。

随后入口把原 stdin shutdown 转换为同一 `ARTOO_WORKER_LAUNCH_ID` 的既有 IPC shutdown。入口检查原 `worker.ready`/`worker.stopped`、IPC 断开、exit/close、stdout/stderr EOF 和实际发布 normal closure；已经在途的唯一原始 ready 可以在 shutdown 之后、stopped 之前被记录，但不会重新启动工作。重复 ready、身份不匹配、stopped 之后的 ready 和强制终止都不算成功。已完成的应用发布若缺少原始发布记录，也不能标记为正常未发布。静态路径继续使用下述原监督 CLI。应用 session 不支持 `-OpenProduct`；已验证的一次同 URL、同数据库重开属于原发布过程，不能当作停机后的第三次启动或永久托管。

静态 Web 入口为 `max_retries=3` 在启动时准备一个源工作区和四个独立目标工作区。源端作者、审核者各一个实例；目标端同一逻辑作者、审核者各有四个实例，共四个逻辑 agents、十个执行实例。每个目标工作区分别绑定验证配置、证据目录、发布存储和端口，slot 0 保持原路径和配置 ID。所有节点声明和完整写入根范围均在提交前确定，执行中不会按模型输出创建新配置或扩大目录权限。

入口显式请求 `source_handoff.research_revision.strategy=configured_pool`，并在 READY/提交前检查真实源节点是否声明 `product-research-revision.v1`。仅有新 schema 或配置文件不能满足此条件；旧安装或尚未实现基线保留的节点会停止启动，不会提交一个无法完成的需求。该检查和下面的配置测试不代替最终版本的原生修订、发布验收。

源码存在不表示当前电脑已安装或验收。维护者须先准备与最终提交、成功候选和成功 normal 运行一致的安装元数据，再分别验证启动器、实际页面、完整产品运行、发布保持和停止。不得把 fixture、元数据生成或 Web build 当作完整日常使用验收。

## 一次安装后使用

安装由维护者完成。默认本机配置为 `%LOCALAPPDATA%\Artoo\windows-local-request\LOCAL-INSTALLATION.json`，不应要求用户填写 profile、JSON、Node 路径或密钥。启动器使用安装清单指定并校验过的 Node，详见 [启动器说明](LAUNCHER.md)。

在 Windows PowerShell 7.5 或更高版本启动：

```powershell
& .\scripts\windows-local-request\Start-ArtooDaily.ps1
```

控制台只询问一次需求，也可用 `-Objective` 或 `-ObjectiveFile`。该模式中 CLI 是唯一提交者，可选 Web 只用于观察同一请求，不能再从页面提交第二次。

安装包含单独验收的本地开发 Web 构建时，可以使用浏览器输入：

```powershell
& .\scripts\windows-local-request\Start-ArtooDaily.ps1 -BrowserInput
```

打开启动后输出的本机页面，只填写 Objective 并启动产品。这个模式不在控制台询问需求，CLI 不提交任何 goal。`-BrowserInput` 与 `-Objective`、`-ObjectiveFile` 互斥。页面自动使用安装配置的验收、发布和节点交接设置；用户不需要选择 agents 或逐步确认阶段。

服务端为本次 session 绑定发起账号、项目、完整配置及稳定请求 ID。控制台模式还绑定原需求正文。页面刷新或网络响应丢失会重用本次请求；修改 key、已提交正文或配置不会创建替代 goal。普通项目的手动工作流和多 goal 能力保持不变；新的 daily session 使用新的 ID。这里的页面恢复不代表旧 native session/store 可以安全重启。

## 本地身份与安装绑定

Server 只监听 `127.0.0.1`，使用项目已有的 loopback development identity；节点通过实际 pairing/claim/enroll API 取得设备 token，dev node token 和 dev routes 关闭。浏览器模式使用同一最终源码另外构建并绑定的 local-development Web，保留原 AuthGate 的既有构建语义，不创建 Google session。这不是生产登录、远程网络或签名桌面包验收。

普通 candidate 的 auth-on Web 产物不能直接改名为开发版。安装元数据必须绑定新的 dev Web 输出、实际构建进程结果、最终 candidate 身份和完整文件树，且不能覆盖候选的原 `apps/web/dist`。页面能打开后仍须完成真实需求验收。

本机页面使用 HTTP 自动刷新，阶段、任务、独立审核和发布结果每 5–10 秒更新。连接状态显示 `Automatic progress refresh`；普通在线会话仍使用原实时连接。当前本机模式不提供逐块 stdout/stderr 实时流，任务运行状态、失败原因和持久化审核记录仍可查看。

`inputs.mjs` 只检查本地元数据、物理路径、程序与依赖文件身份；不会启动模型或提交需求。Console 的 `capture({ objective, configuration_file })` 保持兼容。Browser 显式使用 `submission_owner: 'browser'`，禁止同时传入 objective，并要求安装中已有 Web。

API key 仅来自启动进程环境或现有 Aerial 本地文件，经 `ARTOO_CODEX_PROVIDER_KEY` 传给子进程；不进 argv、日志、Git 或安装清单。启动器在 `finally` 恢复原进程环境。实际 Server 的 AI sharing policy 必须与已授权本机配置精确匹配；不自动切换 provider 或接受不同政策版本。

## 发布、保持与停止

静态 Web 成功发布后，控制台输出实际产品地址，入口继续保持两个节点和本机 publisher，并观察发布状态与实际 HTTP 身份。应用模式按上文保持其单个原始 daemon 和有界服务。验收、独立审核或发布失败会保留失败记录，不会改成通过。

保持原控制台开启。停止时在同一标准输入发送下面完整的一行并换行：

```json
{"version":1,"kind":"shutdown"}
```

静态 Web 入口向两个原始 CLI 发送正式 shutdown，检查实际 exit/close、stdout/stderr EOF、cleanupConfirmed、节点断开和 Server 关闭。应用模式采用上文的提交排空、正式 API 停止和原始 IPC 关闭。原 75 秒 CLI 正常停止边界保留；紧急终止或未知关闭记为失败。Ctrl+C、关闭窗口和无限后台服务不在此处宣称通过。

流程仍采用配置的发布前运行预算；browser 模式等用户输入另有同样长度的等待上限，完整产品预算从真实提交后开始。静态 Web 发布后保持受原监督进程 lifetime/output 上限约束；应用发布采用其原始租期和请求预算。停止后本机产品地址失效，因此这不是永久或公网托管。

每次调用使用 fresh session 目录并保留数据库、workspace、来源与恢复信息、验证证据、发布存储及最终结果；不删除成功或失败历史。`goal_posts` 记录 launcher 实际发送次数（Console 为 1，Browser 为 0），`logical_goals_created` 记录实际数据库核对的一项需求。浏览器网络重试次数不能冒充多个逻辑需求，也不能用 launcher POST=0 声称页面已经提交。

## 重新打开已完成的本机产品

静态 Web 模式成功发布并从原 stdin 正常停止后，输出中的 `open_product` 是可选择的原 session 路径。应用模式不输出此入口，配置与保留结果检查也会拒绝静态重开。重新使用静态产品时运行：

```powershell
& .\scripts\windows-local-request\Start-ArtooDaily.ps1 -OpenProduct '<原 session 的绝对路径>'
```

也可选择该目录中的 `RESULT.json` 或 `PUBLISHED.json`。入口自动校验并使用原安装配置，不再次询问需求，不读取 Aerial 密钥，不启动模型、agents 或原数据库。`-OpenProduct` 与 `-Objective`、`-ObjectiveFile`、`-BrowserInput` 互斥。重开后访问输出的原产品 URL；地址与端口保持不变，因此浏览器仍使用原 origin。若原端口已被占用，会明确失败，不自动改地址。

保留原控制台，停止时仍向同一 stdin 发送一次 `{"version":1,"kind":"shutdown"}` 并换行。`local-product.ready` 表示既有发布器已启动且 HTTP 身份检查通过；`local-product.stopped` 与新观察目录中的 `RESULT.json` 记录本次真实关闭。每次重开写新的 `reopen-*` 观察目录，原目标、审核、制品和发布证据保留。

重开沿用原受保护发布配置授权的健康监控和撤回策略。这些监控动作可能更新健康 journal 与 `current.json`。若原选定版本被撤回或当前版本发生变化，本次重开必须记为失败并保留变化前后的证据；不能将监控动作视为保持原产品身份的成功证明。重开不会启动旧 goal、agents、source-recovery 或 clean 工作流。

多工作区 session 的重开按已成功发布 request 中的配置 ID、完整 capability binding 和 digest 精确选择原 slot，并交叉检查原 RESULT、CONFIG-BINDING 和所有配置文件。成功的是后续 slot 时使用它自己的原 URL、工作区和发布存储，同时保留全部目标写入根的隔离检查。不会按端口相似、目录前缀或最新修改时间猜测产品。旧单工作区记录保留原语义。

后续 slot 的普通 publisher-only 重开目前由受控 native 准入、真实本地 HTTP 和文件 journal 测试覆盖；这不代表真实 native 安装或模型产品流程已验收。交付仍须用最终安装完成实际产品停止、重开与原 stdin 再停止的验证。

当前 source-recovery/clean 授权仍精确绑定节点原始主工作区注册；额外目标 slot 的准备不等于给它们授予恢复权限。后续 slot 的异常重启恢复尚需独立实现和验证，现有保护会拒绝没有对应注册的恢复操作。

原 daily 与重开入口在任何发布器初始化前共享同一独占锁。原两个节点、Server 与输入校验全部正常结束后才释放；重开也仅在发布器明确关闭和输入复核通过后释放。并发运行或异常遗留的锁会拒绝启动，不按 PID 猜测删除。旧版本缺少共享锁释放记录、原 stdin 关闭记录或完整发布 request/receipt 的 session 不支持重开；有 recovery/clean publisher fence 的记录也保留原拒绝规则。这不是旧任务恢复、crash 恢复、后台服务或公网托管。

静态模式范围为同一物理电脑的两个独立节点和前台 loopback 发布；新增应用模式连接既有受约束的应用编译、服务器、SQLite broker 与两代本机发布流程。新增入口仍需最终安装上的真实模型、浏览器、应用操作与正常停止验收。任意远程电脑/agent 自动接入、任意后端技术栈、旧任务安全恢复、签名安装与公网生产发布不由此入口证明。

## 维护者检查

入口和 Web/server 必须在同一版本集成；不能把仅实现 `-BrowserInput` 参数的启动器配给旧 Console 草案。先运行项目规定检查以及：

```powershell
node --test scripts/windows-local-request/launcher.test.mjs scripts/windows-local-request/entry-preflight.test.mjs scripts/windows-local-request/reopen-inputs.test.mjs scripts/windows-local-request/slots.test.mjs scripts/windows-local-request/application.test.mjs
```

启动器套件使用真实 PowerShell/Node 与明确标注的假 entry，只验证参数、环境、stdin 和退出行为。预检套件使用真实 entry 和明确不存在的配置，验证输入模式在应用启动前被正确处理。随后仍需通过实际交付入口提交一次非固定产品需求，验证真实模型、native、独立审核、HTTP 发布、保持及原 stdin 关闭。结果应明确区分这些证据范围。

`application.test.mjs` 使用实际编译后的 domain schema、受控元数据/发布记录与 Fastify injection，验证请求模式、完整工具树、原用户/会话/发布身份、可用状态、正式停止路径、提交响应丢失后的原始 goal 找回和 IPC 消息交错；它不启动模型或 native 服务，不是应用产品验收。`apps/server/src/goal-entry.test.ts` 使用真实路由和数据库事务屏障，覆盖关闭提交入口时原始提交的 commit/rollback、Console key 保密以及随后取消原 goal。另须运行 `windows-application-entry.test.ts` 与 `windows-daemon-launcher.test.ts` 的相应源码回归。

重开元数据测试拒绝不完整关闭、错配记录和变更的发布身份；它不替代发布器的实际 HTTP/端口/独占/停止测试。交付前还须用同一最终安装完成真实产品“正常停止 → 重开原 URL → 操作产品 → 原 stdin 停止”的验收，不能以源码、fixture 或一次 HTTP 可访问宣称完成。
