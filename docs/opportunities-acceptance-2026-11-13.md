# Opportunities 产品验收准备（E4）

## 当前状态

2026-11-13 的只读盘点基于 main `235133c6eba345831f78339bcb87e1d84ab1bc8f`。这是优化过程中的环境盘点，**不是最终验收版本，也不是产品发布或恢复成功记录**。所有优化合并后须重新冻结源码、构建、工具链和受保护 Profile；不得沿用此前版本的成功结果为新版本背书。

| 范围 | 已有依据 | 本轮状态 |
| --- | --- | --- |
| 源码正确性 | [实施记录](opportunities-progress.md) 逐项记录聚焦回归 | 最终 typecheck/build/完整 Vitest 尚未运行 |
| Web 控制面 E2E | 仓库 `npm run test:e2e --workspace @artoo/web` | 按请求在全部优化整合后统一运行 |
| 真实 Provider 静态产品闭环 | [Agent Team 指南](agent-team-development.md)、[live 验收入口](../apps/server/src/agent-team-live.test.ts) | 尚未启动新的完整运行，不能以组件/受控夹具通过替代 |
| Windows 单需求安装入口 | [现有运行与停止约定](../scripts/windows-local-request/README.md) | 默认安装清单未发现；其他目录是否已有合格安装尚未知 |
| 原生 iOS UI | [Apple 客户端 E2E](apple-client-e2e.md) | 当前宿主 Windows，原生 Xcode/Simulator 验收需 macOS 环境 |
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

1. 在全部优化合并后记录完整 Git SHA、干净工作区/构建输入清单与摘要、Node/npm/CLI/浏览器/helper 版本及受保护验证/发布 Profile 指纹，固定一次调用的目标、期限和预算。
2. 先完成源码门禁与完整 Web E2E，分别保留命令、实际退出状态、测试数、失败和条件跳过。聚焦重跑不替换失败的完整运行。
3. 确认现有测试安装、AI sharing 授权、测试发布目标、不可变输入版本、健康标准和恢复安排。按既有 live 或本机入口执行空工作区 → 规划 → 独立审核 → 节点验证 → 实际端点发布；本地静态、应用发布和生产部署分别按各自已实现的契约验收。
4. 按承诺范围验证失败、重启/重连和恢复；保留节点独占 `run.verification`、审核绑定、发布/健康/恢复回执、真实进程 exit/close、输出 EOF、清理结果及未覆盖范围。原生关闭未知时保留失败和现场，不删除未确认安全的工作目录。
5. 更新本记录为实际结果并链接原证据。只有完整、版本绑定且可复现的证据才可将 E4 标记完成；本准备文档不改变能力或验收状态。
