# 脚本地图

所有示例从仓库根执行，使用 Node.js 24+ / npm 11+。
[package.json](../package.json)是 npm 入口清单，
[GitHub Actions](../.github/workflows/)是 CI 调用与平台范围的依据。
[文档地图](../docs/INDEX.md)提供架构、部署和历史记录入口。

## 日常开发和检查

| 命令 / 入口 | 用途与前置 |
| --- | --- |
| `npm run typecheck`、`npm run build` | 全工作区类型检查与构建；构建串行执行，避免并发写入 TypeScript 构建信息 |
| `npm test -- --maxWorkers=2` | 默认完整 Vitest；保留原平台/显式 opt-in 条件 |
| `npm run test:unit -- --maxWorkers=2` | domain/protocol 与 Web 单元/组件，不包含 server、DB、artood、desktop，也不是真实浏览器 |
| `npm run test:server -- --maxWorkers=2` | 完整 server 测试；部分入口/子进程测试需要先构建 |
| `npm run test:e2e --workspace @artoo/web` | Web Playwright E2E，需要已安装的 Chromium 与构建前置，见 [Web 配置](../apps/web/package.json) |
| `npm run check:staged`、[check-changed.mjs](check-changed.mjs) | 暂存与提交差异的渐进质量门禁；[使用方法](../docs/code-quality.md) |
| [ci-vitest-coverage.mjs](ci-vitest-coverage.mjs) | Windows CI 的 discovery/实际 JSON reporter 文件覆盖聚合，不替代测试执行 |

`npm test` 不自动发现 `scripts/*.test.mjs` 或独立 fixture harness。
按门禁入口和相应指南运行这些检查；POSIX 真实验证与 Windows native helper 验收有各自的平台前置。
不要把测试 fixture 的故意失败当成普通套件失败或成功，按其父 harness 的证据解释结果。

## 构建、预览与门禁主入口

| 入口 | 说明 |
| --- | --- |
| `npm run build:preview` → [build-preview.mjs](build-preview.mjs) | 构建预览所需的服务端、Web、daemon/桌面相关输入 |
| `npm run start:preview` → [start-preview.mjs](start-preview.mjs) | 启动预览；先按[共享服务](../docs/shared-server.md)和[预览运维](../docs/preview-operations.md)配置 |
| `npm run verify:preview -- --list` → [preview-gate.mjs](preview-gate.mjs) | 只列出默认 shared 门禁；`--suite=shared-checks|ios|mac|desktop` 选择对应入口，去掉 `--list` 才执行 |
| `npm run verify:v1` → [v1-gate.mjs](v1-gate.mjs) | 历史 v1 自动门禁；完整发布条件见 [v1 release gates](../docs/v1-release-gates.md) |
| `npm run e2e:auth` → [auth-e2e.mjs](auth-e2e.mjs) | 认证浏览器工作流 |
| `npm run demo:v1` → [v1-demo.mjs](v1-demo.mjs) | v1 演示流程，不能替代真实 Provider 产品验收 |
| `npm run verify:recovery` → [recovery-e2e.mjs](recovery-e2e.mjs) | 构建、父 harness 回归与受控恢复演练；[运维范围](../docs/preview-operations.md) |

CI 的 `preview.yml` 将完整 Vitest 分为两个 parallel 分片和一个串行 windows-process 分区，
并在 shared 聚合实际文件覆盖；`shared-checks` 单独运行实际 Web/认证浏览器等检查。
不能用任一子入口的成功代表全部发布门禁通过。

## Apple 与桌面验收

主入口是 [ios-ui-suites-e2e.mjs](ios-ui-suites-e2e.mjs)。
例如 `npm run verify:ios:suites -- --suites=core,mentions` 一次构建后依次执行所选 suite，
统一准备 Xcode 工程；各 suite 仍保留独立构建、证据与清理。
独立 `verify:ios:core|assistant|mentions|correction|retention` 入口仍可用。
原生执行需要 macOS/Xcode/Simulator，详见 [Apple E2E](../docs/apple-client-e2e.md)。

| 脚本组 | 定位 |
| --- | --- |
| [ios-ui-e2e.mjs](ios-ui-e2e.mjs)、[assistant](ios-ui-assistant-e2e.mjs)、[mentions](ios-ui-mentions-e2e.mjs)、[correction](ios-ui-correction-e2e.mjs)、[retention](ios-ui-retention-e2e.mjs) | suite 包装入口，由聚合器按选择调用 |
| `ios-ui-*-fixture.mjs`、`ios-ui-*-evidence.mjs`、[ios-ui-suite-evidence.mjs](ios-ui-suite-evidence.mjs) | 受控场景及证据支持模块，不能一概当作独立 CLI 或真实 Provider |
| [ios-ui-simulator.mjs](ios-ui-simulator.mjs)、[ios-simulator-clipboard.mjs](ios-simulator-clipboard.mjs)、[ios-ui-session.test.mjs](ios-ui-session.test.mjs) | Simulator 所有权、剪贴板及认证边界回归 |
| [ios-ai-data-sharing-e2e.mjs](ios-ai-data-sharing-e2e.mjs)、[ios-content-moderation-e2e.mjs](ios-content-moderation-e2e.mjs) | 专项原生 harness，按各自配置运行 |
| [ai-data-sharing-e2e.mjs](ai-data-sharing-e2e.mjs)、[content-moderation-e2e.mjs](content-moderation-e2e.mjs) | 对应专项 Web/服务端流程 |
| [apps/ios/scripts/](../apps/ios/scripts/) | 原生契约检查、工具链、归档、XCTest 和分发脚本 |
| [apps/desktop/scripts/](../apps/desktop/scripts/) | 打包、安装与桌面验收；`verify:mac` / `verify:desktop` 由 preview gate 调用 |

## 运维、发布与离线工具

- [storage.mjs](storage.mjs)：`npm run storage -- backup|restore|adopt-legacy|unlock ...`，
  会读取当前数据路径和可选 `.env`；先遵循[备份/恢复 Runbook](../docs/preview-operations.md)。
- [audit-verify.mjs](audit-verify.mjs)：对下载 envelope 与独立可信公钥环离线验签；
  先构建 server 及工作区依赖，见[密钥与格式说明](../docs/audit-signing.md)。
- [npm-daemon/](npm-daemon/)：[打包、注册表验证与连接指南](npm-daemon/README.md)，
  CI 范围以 `npm-daemon-*.yml` 为准。
- [windows-local-request/](windows-local-request/)：[安装清单、启动、重开与停止](windows-local-request/README.md)。
- [azure-release/](azure-release/)：门禁、制品发布和受约束的 prepare/deploy/recover/cleanup；
  由 Azure/GitHub release 工作流调用，遵循[发布指南](../docs/github-actions-production-release.md)。
  它们不是通用本地开发命令。

## 基准与内部支持

[benchmarks/](benchmarks/) 包含 presence 索引、消息对账、搜索与预算扫描的可复现测量入口；
方法、基线和局限见[文档测量记录](../docs/INDEX.md#版本化验证与测量记录)。
[fixtures/](fixtures/)是受控场景、协议与结果断言模块。
[owned-browser.mjs](owned-browser.mjs)、[owned-process-group.mjs](owned-process-group.mjs)、
[workflow-cleanup.mjs](workflow-cleanup.mjs)、[e2e-report.mjs](e2e-report.mjs)、
[png-evidence.mjs](png-evidence.mjs)和[native-single-case.mjs](native-single-case.mjs)是所有权、报告和证据支持层。

新增脚本先选择职责目录：门禁放 `scripts/gates/`，iOS 编排放 `scripts/ios/`，
受控场景放 `scripts/fixtures/`，测量放现有 `scripts/benchmarks/`。
按实际需要创建目录，不创建空目录。已有文件保持路径，避免破坏 npm、CI、指南与相对导入；
迁移时须单独更新全部调用并验证。新增 CLI 应有明确参数契约和平台条件，支持模块与测试不要伪装成用户入口。
