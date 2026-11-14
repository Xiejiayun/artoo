# Opportunities 产品验收准备（E4）

## 2026-11-15 集成验证快照

以下是已完成运行的版本范围，后续章节保留各次历史记录；不是最终 main 全流程通过声明。

- main `c3923ad` 的 [Preview run 43618099700](https://github.com/Xiejiayun/artoo/actions/runs/43618099700) 已结束，整体失败。根 typecheck、preview build 通过，完整 Vitest 独立核验为 611 文件、8,848 通过、90 条既有条件跳过，全部 8,938 项用例身份及六份空浏览器缓存记录保持。
- 同一 main 的 iOS job 完整通过：30 项业务门禁、200 项单元 XCTest、原十一项业务 UI 用例，以及 iPhone/iPad 各一项独立 publisher 用例。73 张业务 PNG、八张 publisher PNG、精确用例身份、源码稳定、所有实际进程关闭和两个新建模拟器的删除均已核验。大字体标题高度 72.33→341.33 点，同一 Run 的新认证刷新完成次数 2→3，原请求/响应及验收制品绑定保持。证据 `.git/opt-main-c392-43618099700/verified-{ios-completed,large-text}.json`；Windows 安装 UI 仍按原条件未运行。
- main 的共享门禁在 Web E2E 为 54 通过/1 失败：自然交付用例重载后，原 15 秒内没有出现 `Current goal progress` 区域。后续认证、依赖审计和 whitespace 检查未运行。PR #121 的独立候选共享 39 项（Web 55、认证 6）、完整 Vitest、Mac 安装/恢复及 Azure 验证通过；该差异不证明原失败根因，也不覆盖 main 失败。PR #121 仅增加保留失败现场与 trace，不修改原断言/期限，已普通合并为 `542be11`。
- PR #121 的原生运行独立失败：200 项单元通过，core 六通过/一失败，后四套未执行；失败发生在配对页 Done 后，原十秒内九次完整快照都仍有键盘，层级明确显示配对码仍有键盘焦点。实际触摸位于 Done 范围内，但无法据此确定未结束编辑的原因。iPhone publisher 通过，iPad 在启动后的自身进程组查询超时，UI 未运行、关闭与新模拟器删除未确认。原失败、原始 xcresult 及非替代性核验保留 `.git/opt-pr121-43622756618/verified-ios-failures.json`，不能用前一条 main 原生通过覆盖。
- 本机 `8923e23` 的完整四门禁仍保留失败：typecheck/build 通过，Vitest 611 文件为 8,827 通过/23 失败/88 条件跳过。原七个失败文件在单 worker、无文件并行的完整聚焦诊断为 408 通过/7 失败；这是诊断，不能替换完整失败。恢复普通 Web workflow 环境后的完整 Web 55 项通过。新构建 daemon bundle 的两个 Windows worker 用例也独立通过；它们不代表已安装 Electron UI 验收。

P2/P3 的独立 PostgreSQL 计划、当前完整用例和有界写入成本已补测，见 [P2](presence-indexes-2026-11-13.md) 与 [P3](evidence-query-batching-2026-11-13.md)。F2 按操作者决定延期，继续拒绝成本预算。E4 的外部模型共享授权仍未收到；本轮没有读取 Provider 凭据、调用模型或发布产品。所有优化合并后的冻结 main 四门禁及 CI 结果仍须单独记录。

## 操作者范围确认（2026-11-14）

F2 已由操作者明确延期：保留精确计量要求，暂不启用成本预算。精确计量、事务账本、全部阶段准入和预算 UI 尚未实现；当前拒绝 `max_cost_usd`，相关启用条件保留在 [计量决议](cost-metering-contract.md)。E4 的真实 Provider 共享授权和完整产品验收仍需独立完成。

## 当前状态

2026-11-13 的只读盘点基于 main `235133c6eba345831f78339bcb87e1d84ab1bc8f`。这是优化过程中的环境盘点，**不是最终验收版本，也不是产品发布或恢复成功记录**。所有优化合并后须重新冻结源码、构建、工具链和受保护 Profile；不得沿用此前版本的成功结果为新版本背书。

| 范围 | 已有依据 | 本轮状态 |
| --- | --- | --- |
| 源码正确性 | [实施记录](opportunities-progress.md) 逐项记录回归及冻结版本 | main `3ecb0e4` 本机 typecheck/build 通过；此前 `ea75afe` 本机完整 Vitest 8,841 通过/9 失败/88 条件跳过，同提交 CI 三 lane 8,848 通过/90 条件跳过。新 main 的完整 CI lane 仍运行，旧 CI 不能覆盖本机失败 |
| Web 控制面 E2E | 仓库 `npm run test:e2e --workspace @artoo/web` | main `3ecb0e4` 本机完整 54 通过/1 连接请求时序断言失败；单文件同步修复后原场景三次及完整 55 项通过，尚待合并后复核。同 main 的远程 Web 55 项、认证 6 项已通过 |
| 真实 Provider 静态产品闭环 | [Agent Team 指南](agent-team-development.md)、[live 验收入口](../apps/server/src/agent-team-live.test.ts) | 尚未启动新的完整运行，不能以组件/受控夹具通过替代 |
| Windows 单需求安装入口 | [现有运行与停止约定](../scripts/windows-local-request/README.md) | 默认单需求安装清单未发现；已发现 rc.8 daemon 并通过下述 helper/浏览器边界验证，不等同该入口产品验收 |
| 原生 iOS UI | [Apple 客户端 E2E](apple-client-e2e.md) | 旧 main `ea75afe` 的 workflow 因后续 main 更新取消，四套件十项已完成结果单列于实施记录；main `3ecb0e4` 的 iOS job 仍运行，已扩展 core 的真实发布入口与 Agent 历史导航断言，尚未宣称新路径原生通过 |
| 后端/数据库部署与数据恢复 | 指南明确保留的未完成范围 | 不属于已合格的静态站点发布能力，不能据静态发布结果宣称通过 |

指南顶部保留了较早静态流程的成功与后续失败/待验证增量；它们属于各自冻结版本。研究修订/两节点尝试 r18 未进入设计并超时；r20/r21 分别保留停止行为、凭据等失败；r22 未提交 Goal，因目标节点准备超过原 300 秒期限而失败。具体历史证据和更早失败均以指南原记录为准，不被本轮源码回归覆盖。两个逻辑节点在同一 Windows 电脑运行也不证明实体多电脑验收。

## 本机前置条件盘点

- 约定位置 `%LOCALAPPDATA%/Artoo/windows-local-request/LOCAL-INSTALLATION.json` 在本次检查时不存在；这仅证明该路径缺失。
- 当前进程未配置 `ARTOO_AGENT_TEAM_LIVE`、`ARTOO_AGENT_TEAM_RUNTIME`、`ARTOO_CODEX_BINARY`、`ARTOO_CODEX_MODEL`、`ARTOO_CODEX_PROVIDER_URL`、`ARTOO_CODEX_PROVIDER_KEY`、`ARTOO_AGENT_TEAM_BROWSER_EXECUTABLE`、`ARTOO_WINDOWS_PROCESS_BUNDLE`、`ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256`。这不代表其他应用或目录没有凭据；盘点未读取或输出密钥。
- 原 live 入口需要真实 CLI/Provider、原生 Chromium、已构建 daemon，以及 Windows 上精确绑定的受保护 helper bundle 与摘要。未配置时继续 fail closed，不伪造能力或自动降低验收标准。
- 已向操作者询问可沿用的已授权测试安装/配置目录，回复为“不清楚”。随后只读补查 `C:/workspace/artoo/artifacts` 及 `%LOCALAPPDATA%/Artoo`，未发现 `LOCAL-INSTALLATION.json`、`LOCAL-INSTALLATION-*.json` 或 `CANDIDATE.json`。此结论仅限已检查目录；不推断其他位置是否存在配置，也未读取密钥。
- E4 暂记环境未就绪，继续其他独立优化及本机源码/E2E 验证；真实模型数据共享和发布仍须使用已授权的实际测试环境，不能以受控夹具补成产品验收通过。

## 最终版本的执行与证据要求

2026-11-14 补查了此前未覆盖的 `%USERPROFILE%/.artoo`，发现已有 rc.8 daemon 安装及其独立 Provider 配置、Codex CLI 和已安装 Chromium。只读预检通过当前编译模块的 Windows helper 清单绑定、文件和 ACL 准入；凭据仅检查配置引用的文件存在，没有读取或输出内容。另用已安装 Chromium 156.0.8078.80 打开纯本地 data 页面，断言内容并观察到浏览器进程实际 close（exit 0，无 signal）。证据 `.git/opt-e4-installation-preflight.{json,log}`、`.git/opt-e4-browser-preflight.{json,log}`。这些预检不是 Provider 连通、原生 Job 全链或产品闭环验收。

当前实际配置为本机 Aerial 代理和 `gpt-6-astra`；项目声明该代理上游为 GitHub Copilot。真实验收入口要求显式外部接收方策略及 `ARTOO_LIVE_AI_SHARING_CONSENT=1`。已就一次最长 45 分钟、隔离测试工作区及临时本机 HTTP 发布的运行向操作者请求单独共享授权，目前仍等待回复。不得从安装存在、旧文档授权或原来的“不清楚”推断同意。本轮尚未调用 Provider、读取凭据、更改运行中的 daemon 或执行产品发布。授权及最终冻结版本的源码/Web 门禁均就绪后，才可启动该实际运行。

### 本机原生边界补充验证（2026-11-14）

从安装移除合并后的 `061335e750274783e46a4a5871d77d401870e10b` 单独修正原生夹具的过期断言。现有 pinned helper（清单 `sha256:b4795e66e961091d1b0f8b435bcbe7f2c4f29d5e151e9f2feced1c98dda6959a`）、Node 24.22.1 和 Chromium 156.0.8078.80 的正常/中止/外层取消三个真实嵌套 Job 案例全部通过。节点→受保护 CLI→浏览器密封存储的完整 native 夹具最终 1 项通过，内含十个真实拒绝场景，零跳过；原始进程回执、实际关闭、EOF、密封存储观测及源码不变均核验。没有模型调用或产品发布。

早期失败分别包括：安装准入错误文字过期；默认 TEMP 中其他本地 principal 的权限导致派发前拒绝；CLI 已按现行安全诊断约定省略 Zod message getter，而夹具仍要求旧文字。修正只涉及夹具断言和节点失败诊断；所有原截止时间、关闭和拒绝场景保留，生产权限/日志检查未放宽。最终实际使用已保存并通过准入的私有 `temporary_directory`，未修改全局 TEMP、配置或 ACL。未来真实 Provider 运行同样须使用该已准入的临时目录设置；仅继承默认 TEMP 不足以通过私有上下文边界。

证据 `.git/opt-native-recheck-2026-11-13T22-57-50.015Z/{summary.json,input-hashes.json,source.patch,fixture.log}` 绑定基线及完整候选 patch，子进程实际 close 0/null，输入摘要和 patch 前后相同。按夹具原有约定，最终 native records/workspace 保留于已配置私有临时根；先前失败及目录亦保留。该结果不证明真实 Provider、实体多电脑、iOS/Electron 客户端、发布或重启恢复验收完成，仍须执行最终冻结版本的四门禁与单独授权的产品闭环。

### iOS 失败诊断补充（2026-11-14）

[PR #111 的原生门禁](https://github.com/Xiejiayun/artoo/actions/runs/43542284017) 最终失败。core 的六项通过，任务执行/验收用例在已完成任务、打开精确 Agent Run 和原始请求后，展开响应并以完整响应作为 XCTest 字符串标识符查询。原始 xcresult 诊断明确说明响应超过 128 字符上限，测试进程因此 SIGABRT；不是应用进程退出。后续四套原生 suite 及 publisher 检查未执行，不能推断通过。失败工件保留 `.git/opt-f3-pr111-43542284017/`，父进程退出 1，资源关闭、原生进程组关闭和临时目录清理完成。

候选修正使用精确 label 谓词，并核对完整 label 等于同一真实响应；没有截断文字或修改测试期限/用例集合。本机语法和静态契约通过只证明前置条件，修正后的 Swift 编译、真实原生交互及全部 suite 仍以新的 macOS 门禁为准。

### 当前集成证据补充（2026-11-14）

上表的早期结果保留其版本范围。后续 main `cb2a128` 本机 typecheck、完整 workspace build 和真实 Chromium Web 55 项通过；同提交 CI 完整 611 文件、8,848 通过、零失败、90 条既有条件跳过，文件/用例集合及六份前后空缓存记录已核验。原本机九项失败未被此结果覆盖。该 main 的 iOS 因旧响应标识符查询失败；修正 PR #113 已基于实际编译与七项完整 core XCTest 通过普通合并，当前 main 为 `b779006`。PR 的整个 iOS gate 尚未结束，Vitest 首轮仍有两项未修改 WebSocket 重试测试失败，最终重验尚未完成。完整原生/统一 E2E 状态继续为未完成。

[跨平台 daemon run 43524088335](https://github.com/Xiejiayun/artoo/actions/runs/43524088335) 在 `ea75afe` 全部八个 job 成功，五个 OS/架构使用相同 tarball 摘要，各自正常安装并实际执行四个受控 CLI 成功/失败任务，daemon 正常关闭/重启、身份保持、未授权停止拒绝和进程缺席均已核验。四个平台的 POSIX 验证各 17 项（共 68）通过，Ubuntu 沙箱浏览器 8 项通过且正常关闭/安全清理；未关闭浏览器沙箱。174 份证据文件摘要保留 `.git/opt-final-cross-platform-43524088335/verified-cross-platform.json`。该运行的合格 daemon/服务端/共享包/打包脚本输入到 `b779006` 未修改；这是限定输入的受控运行证据，不是新版本 live Provider、原生 supervisor、Windows 安装 UI、npm 发布或生产恢复验收。完整 tarball 未在本机重新下载/哈希。

仓库 self-hosted runners 只读查询为零，Windows Electron 安装 UI 的条件跳过继续记为未运行。未在个人电脑代替隔离交互 runner 执行 NSIS 安装/卸载。F2 当前仍只有计量契约设计，可信金额来源、精确账本及成本准入未实现；E4 的实际 Provider 共享授权仍待操作者回复。

### 最终验收步骤

1. 在全部优化合并后记录完整 Git SHA、干净工作区/构建输入清单与摘要、Node/npm/CLI/浏览器/helper 版本及受保护验证/发布 Profile 指纹，固定一次调用的目标、期限和预算。
2. 先完成源码门禁与完整 Web E2E，分别保留命令、实际退出状态、测试数、失败和条件跳过。聚焦重跑不替换失败的完整运行。
3. 确认现有测试安装、AI sharing 授权、测试发布目标、不可变输入版本、健康标准和恢复安排。按既有 live 或本机入口执行空工作区 → 规划 → 独立审核 → 节点验证 → 实际端点发布；本地静态、应用发布和生产部署分别按各自已实现的契约验收。
4. 按承诺范围验证失败、重启/重连和恢复；保留节点独占 `run.verification`、审核绑定、发布/健康/恢复回执、真实进程 exit/close、输出 EOF、清理结果及未覆盖范围。原生关闭未知时保留失败和现场，不删除未确认安全的工作目录。
5. 更新本记录为实际结果并链接原证据。只有完整、版本绑定且可复现的证据才可将 E4 标记完成；本准备文档不改变能力或验收状态。
