# Windows 本机单需求入口

本入口用两个独立的原生 Windows 监督节点和四个 Codex agents，把一次静态 Web 产品需求交给 Artoo GoalRunner，执行调研、设计、实现、测试、独立审核和配置内的本机发布。模型使用已配置的 Aerial `127.0.0.1:18181` / `gpt-6.1-sol`，其上游是 GitHub Copilot。无需 WSL。

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

成功发布后，控制台输出实际产品地址，入口继续保持两个节点和本机 publisher，并观察发布状态与实际 HTTP 身份。验收、独立审核或发布失败会保留失败记录，不会改成通过。

保持原控制台开启。停止时在同一标准输入发送下面完整的一行并换行：

```json
{"version":1,"kind":"shutdown"}
```

入口向两个原始 CLI 发送正式 shutdown，检查实际 exit/close、stdout/stderr EOF、cleanupConfirmed、节点断开和 Server 关闭。原 75 秒正常停止边界保留；紧急终止或未知关闭记为失败。Ctrl+C、关闭窗口和无限后台服务不在此处宣称通过。

流程仍采用配置的发布前运行预算；browser 模式等用户输入另有同样长度的等待上限，完整产品预算从真实提交后开始。发布后保持受原监督进程 lifetime/output 上限约束。停止后本机产品地址失效，因此这不是永久或公网托管。

每次调用使用 fresh session 目录并保留数据库、workspace、来源与恢复信息、验证证据、发布存储及最终结果；不删除成功或失败历史。`goal_posts` 记录 launcher 实际发送次数（Console 为 1，Browser 为 0），`logical_goals_created` 记录实际数据库核对的一项需求。浏览器网络重试次数不能冒充多个逻辑需求，也不能用 launcher POST=0 声称页面已经提交。

## 重新打开已完成的本机产品

新版入口成功发布并从原 stdin 正常停止后，输出中的 `open_product` 是可选择的原 session 路径。重新使用产品时运行：

```powershell
& .\scripts\windows-local-request\Start-ArtooDaily.ps1 -OpenProduct '<原 session 的绝对路径>'
```

也可选择该目录中的 `RESULT.json` 或 `PUBLISHED.json`。入口自动校验并使用原安装配置，不再次询问需求，不读取 Aerial 密钥，不启动模型、agents 或原数据库。`-OpenProduct` 与 `-Objective`、`-ObjectiveFile`、`-BrowserInput` 互斥。重开后访问输出的原产品 URL；地址与端口保持不变，因此浏览器仍使用原 origin。若原端口已被占用，会明确失败，不自动改地址。

保留原控制台，停止时仍向同一 stdin 发送一次 `{"version":1,"kind":"shutdown"}` 并换行。`local-product.ready` 表示既有发布器已启动且 HTTP 身份检查通过；`local-product.stopped` 与新观察目录中的 `RESULT.json` 记录本次真实关闭。每次重开写新的 `reopen-*` 观察目录，原目标、审核、制品和发布证据保留。

重开沿用原受保护发布配置授权的健康监控和撤回策略。这些监控动作可能更新健康 journal 与 `current.json`。若原选定版本被撤回或当前版本发生变化，本次重开必须记为失败并保留变化前后的证据；不能将监控动作视为保持原产品身份的成功证明。重开不会启动旧 goal、agents、source-recovery 或 clean 工作流。

原 daily 与重开入口在任何发布器初始化前共享同一独占锁。原两个节点、Server 与输入校验全部正常结束后才释放；重开也仅在发布器明确关闭和输入复核通过后释放。并发运行或异常遗留的锁会拒绝启动，不按 PID 猜测删除。旧版本缺少共享锁释放记录、原 stdin 关闭记录或完整发布 request/receipt 的 session 不支持重开；有 recovery/clean publisher fence 的记录也保留原拒绝规则。这不是旧任务恢复、crash 恢复、后台服务或公网托管。

当前范围为同一物理电脑的两个独立节点、静态 Web 产品和前台 loopback 发布。任意远程电脑/agent 自动接入、后端或数据库产品、旧任务安全恢复、签名安装与公网生产发布仍需各自实现和验收。

## 维护者检查

入口和 Web/server 必须在同一版本集成；不能把仅实现 `-BrowserInput` 参数的启动器配给旧 Console 草案。先运行项目规定检查以及：

```powershell
node --test scripts/windows-local-request/launcher.test.mjs scripts/windows-local-request/entry-preflight.test.mjs scripts/windows-local-request/reopen-inputs.test.mjs
```

启动器套件使用真实 PowerShell/Node 与明确标注的假 entry，只验证参数、环境、stdin 和退出行为。预检套件使用真实 entry 和明确不存在的配置，验证输入模式在应用启动前被正确处理。随后仍需通过实际交付入口提交一次非固定产品需求，验证真实模型、native、独立审核、HTTP 发布、保持及原 stdin 关闭。结果应明确区分这些证据范围。

重开元数据测试拒绝不完整关闭、错配记录和变更的发布身份；它不替代发布器的实际 HTTP/端口/独占/停止测试。交付前还须用同一最终安装完成真实产品“正常停止 → 重开原 URL → 操作产品 → 原 stdin 停止”的验收，不能以源码、fixture 或一次 HTTP 可访问宣称完成。
