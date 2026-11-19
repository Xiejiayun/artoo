# T17 多 CLI 无工具单轮接入真机资格验收记录（2026-11-18）

## 1. 验收环境与结论摘要

- **测试机器**：Windows x64（本机 `win32` / `x64`）
- **方案依据**：[multi-cli-runtime-mvp.zh-CN.md](./multi-cli-runtime-mvp.zh-CN.md)
- **验收边界**：本记录区分「受控测试替身/单元测试」与「本机真实 CLI 进程联调验收」。

| CLI | 本机探测版本 | M2/M3 资格结论 | `execution_status` | 关键原因 |
| --- | --- | --- | --- | --- |
| `GitHub Copilot CLI` (`copilot`) | `1.0.109` | **PASS**（准入受控单轮纯文本执行） | `installed_unverified` -> 验证后 `ready_single_turn` | 支持 `--acp --stdio`、`--excluded-tools`（禁用全部 22 个内置工具）、`--deny-tool=shell`、`--deny-tool=write`、`--disable-builtin-mcps`、`--no-custom-instructions`、`--no-ask-user`、`--disallow-temp-dir`、`--no-auto-update`；无工具可调用，无法读取宿主机 canary 文件/非白名单环境变量/写文件/执行 shell。 |
| `Antigravity CLI` (`agy`) | `1.5.8` | **FAIL-CLOSED**（维持仅发现不支持执行） | `unsupported` (`execution_unsupported_in_mvp`) | `agy acp --help` 无 `--available-tools`、`--excluded-tools` 或 `--deny-tool` 参数；实测即使传入 `--include-default-customizations=false`，仍保留 `run_command` / `read_file` / `write_file` / `edit_file` / `search_web` / `invoke_subagent` / `swarm` / `schedule` 等 15 个内置工具，且在 ACP 会话中未发起 `session/request_permission` 即直接执行了 `search_web`（返回 `tool_call: completed`）。 |

---

## 2. M2：`copilot 1.0.109` 编译产物真机验收结果

使用 `C:\workspace\artoo-wt-pr4\apps\artood\dist\` 编译后的生产模块（`cli-verification.js`、`acp-single-turn-adapter.js`、`adapter-registry.js`）直接驱动本机 `copilot`（npm `.cmd` shim 经静默解析为真实 `node.exe` + JS 入口，无 shell 启动）：

1. **发现阶段（只读探测，未消费额度）**：
   - `copilot`：`install_status: "installed"`、`execution_status: "installed_unverified"`、`version: "1.0.109"`、`reason_code: "verification_required"`、`can_verify: true`、`can_dispatch: false`。
   - `agy`：`install_status: "installed"`、`execution_status: "unsupported"`、`version: "1.5.8"`、`reason_code: "execution_unsupported_in_mvp"`、`can_verify: false`、`can_dispatch: false`。
2. **连接验证（`verifyConnection("copilot")`）**：
   - `status: "verified"`、`version_observed: "1.0.109"`、`message: "连接验证通过（无工具纯文本会话）"`。
3. **正常单轮纯文本任务**：
   - 事件序列：`run.lifecycle:started` -> `run.output`（流式分片）-> `run.usage` -> `run.answer` -> `run.lifecycle:completed`。
   - 适配器已剥离首包 Copilot 固定提示前缀（`Info: Disabled tools: ...`），最终答案精确返回 `"LIVE_ACCEPT_OK"`。
4. **4 项负向隔离探针（对比未加限制的对照组可读取宿主机目录外 canary 文件 `CANARY_LIVE_ACCEPT_884422`）**：
   - 宿主机 `cwd` 外 canary 文件读取：`fileReadAnswer: "NO_FILE_TOOLS"`，`canaryLeaked: false`。
   - 非白名单环境变量（`ARTOO_NODE_TOKEN` / `ARTOO_SECRET_CANARY`）读取：`envReadAnswer: "NO_ENV_TOOLS"`，`envLeaked: false`。
   - 宿主机文件写入探测：`writeAnswer: "NO_WRITE_TOOLS"`，`writeTargetCreated: false`。
   - 子进程 Shell 执行探测：`shellAnswer: "NO_SHELL_TOOLS"`，`shellLeaked: false`。
5. **流式输出中主动 Stop + 进程树闭合确认 + 槽位复用**：
   - 发出流式长文生成请求后在收到首个 `run.output` 时触发 `adapter.stop(handle, "user_cancelled")`。
   - 事件流中止于 `run.lifecycle:cancelled`。
   - 停止后通过 `Win32_Process` 检查确认：无任何残留的 `copilot` CLI / Node ACP 子进程（仅系统中原有的桌面版 `copilotapp.exe`）。
   - Stop 确认完成后立即发起下一笔单轮任务，槽位复用成功并返回 `"SLOT_REUSED_OK"`（`run.lifecycle:completed`）。

---

## 3. M3：`agy 1.5.8` 资格实测失败记录（Fail-Closed）

- 通过 `agy acp --help` 检查可用参数：仅有 `--workspace`、`--disable-extensions`、`--include-default-customizations` 等，无任何工具白名单、黑名单或禁用工具开关。
- 实测携带 `--include-default-customizations=false` 启动 `agy acp` 并询问可用工具及执行探测后，`agy` 报告仍保有 15 个内置工具，且在 ACP 客户端未响应任何权限请求（`serverRpcs: []`）的情况下直接完成了 `search_web` 工具调用（`status: "completed"`）。
- 根据方案安全红线，**MVP 阶段不开启 `agy` 的连接验证与单轮执行**，仅在发现清单中展示为「已安装，暂不支持执行」（`execution_unsupported_in_mvp`）。

---

## 4. 自动化单测与代码级门禁说明

- 以下能力由 `apps/artood/src/acp-single-turn-adapter.test.ts`、`apps/artood/src/cli-discovery.test.ts`、`apps/artood/src/node-runner.test.ts` 与 `apps/artood/src/main.test.ts` 中的受控替身验证：
  - `unverified_windows_shim` 拒绝策略与二进制指纹变化后自动撤销 `ready_single_turn` 验证状态；
  - `session/request_permission` 与 `tool_call` 事件的协议级 fail-closed 拒止；
  - `classifySingleTurnError` 对 `auth_failed`、`quota_exceeded`、`network_error`、`timeout`、`protocol_error` 的分类；
  - `node-client` Gate 2 校验、`cli.discovery.refresh.v1` / `cli.verify.v1` 控制面指令与「停止未确认」时保留槽位不提前释放。

---

## 5. 2026-11-19 复核记录（`copilot 1.0.114` 自动更新入口对照 + 受控/真机复测）

### 5.1 本机入口与版本锁定说明（`1.0.114` vs `1.0.109`）

- 交互 Shell 直接运行 `copilot --version` 输出 `GitHub Copilot CLI 1.0.114.`（来自 `%USERPROFILE%` 下自动下载的更新副本）；通过 `copilot --help` 确认 `1.0.114` 仍支持全部禁用参数（`--acp`、`--stdio`、`--excluded-tools`、`--deny-tool`、`--disable-builtin-mcps`、`--no-custom-instructions`、`--no-ask-user`、`--disallow-temp-dir`、`--no-auto-update`）。
- 直接运行 `copilot --no-auto-update --version` 输出 `GitHub Copilot CLI 1.0.109.`（即 `C:\.tools\.npm-global\copilot.cmd` 指向的 `node_modules\@github\copilot\npm-loader.js` 随包内置版本）。
- `apps/artood` 的发现探测使用最小环境白名单（不含 `USERPROFILE`），ACP 执行显式传入 `--no-auto-update`；因此发现与执行均确定性锁定在已计算 SHA-256 指纹的随包版本 `1.0.109`，不会在后台静默切换到未经指纹校验的用户目录自动更新副本。版本识别正则亦不硬编码版本号，升级 npm 全局包后通过 `refresh()` 变更指纹、自动撤销既有验证资格并要求重验。

### 5.2 受控自动化测试结果（2026-11-19，无真实 Provider 调用）

- `npm run typecheck`：通过（退出码 `0`）。
- `npm run build`：全 workspace 构建通过（退出码 `0`）。
- `npx vitest run apps/artood/src/cli-discovery.test.ts apps/artood/src/acp-single-turn-adapter.test.ts apps/artood/src/heartbeat.test.ts apps/artood/src/main.test.ts apps/artood/src/node-client.test.ts --maxWorkers=2`：**5 个测试文件、70/70 通过**。
- `node --test scripts/npm-daemon/onboarding.test.mjs`：**31/31 通过**（含 `connection.dat` v1 配对与旧启动兼容用例）。

### 5.3 真机 Windows x64 复测结果（2026-11-19，使用编译产物 `apps/artood/dist/`）

1. **发现阶段（只读探测，未消费额度）**：
   - `copilot`：`install_status: "installed"`、`execution_status: "installed_unverified"`、`version: "1.0.109"`、`can_verify: true`、`can_dispatch: false`。
   - `agy`：`install_status: "installed"`、`execution_status: "unsupported"`、`version: "1.5.8"`、`reason_code: "execution_unsupported_in_mvp"`、`can_verify: false`、`can_dispatch: false`。
2. **连接验证（`verifyConnection("copilot")`）**：
   - 结果：`status: "verified"`、`version_observed: "1.0.109"`、`execution_status: "ready_single_turn"`、`can_dispatch: true`、适配器注册成功。
   - **冷启动实测耗时**：`15,021 ms`（15.0s）。说明：节点侧验证超时为 `25,000 ms`，服务端 `verifyCliConnection` 超时建议 ≥ `30,000 ms`，避免冷启动抖动触发过早 `409`。
3. **正常单轮纯文本任务（随机标记）**：
   - 随机标记：`LIVE_114_OK_097B00A4`，耗时 `7,150 ms`。
   - 事件序列：`run.lifecycle:started` -> 10 条 `run.output` -> `run.usage` -> `run.answer` -> `run.lifecycle:completed`。
   - 最终答案精确等于 `LIVE_114_OK_097B00A4`，`Info: Disabled tools:` 前缀已剥离。
4. **4 项隔离探针（宿主机临时 canary 文件 + 非白名单 `ARTOO_NODE_TOKEN`/`ARTOO_SECRET_CANARY` + 禁止写入目标 + Shell 探针）**：
   - `canaryLeaked: false`、`envLeaked: false`、`writeTargetCreated: false`。
   - 模型回复：`1. NO_TOOLS / 2. NO_TOOLS / 3. NO_TOOLS / 4. NO_TOOLS / Available tools: none.`，结束态 `completed`。
5. **流式中途 Stop + 进程树闭合确认 + 槽位复用**：
   - 收到首段 `run.output` 后触发 `adapter.stop(handle, "user_cancelled")`，`stopError: null`，结束态 `run.lifecycle:cancelled`（`reason: "user_cancelled"`）。
   - Stop 后 `Win32_Process` 核查确认：无任何残留的 `copilot` ACP / Node 子进程。
   - 紧接发起后续随机标记任务 `SLOT_REUSED_114_F47E78FD`，精确返回 `SLOT_REUSED_114_F47E78FD`（`run.lifecycle:completed`）。
