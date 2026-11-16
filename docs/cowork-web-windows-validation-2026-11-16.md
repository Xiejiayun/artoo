# Web 与 Windows daemon 收口验证

日期：2026-11-16。此记录区分实现、受控进程、浏览器集成与真实模型验收。

## 范围与版本

仅 Web、服务端和 Windows daemon 活跃。Windows 桌面客户端、iOS、macOS 及其他平台
开发和专项验收暂停。新增 Provider、发布目标与平台资格不进入本次交付。

- 功能冻结：`ed4b7c00fdd89c14af54bec2820fdd7448b44b3d`。
- 类型修复：#196，main `25a3552cff238e6bdbdcec056736c4cc3c070b25`。
- 运行修复：#197，main `0bcf0de2caf88c2217a9ea65fdbac51f799373e6`。
- 范围格式门禁：#198，main `41e3c55bdb3ffe3e4f5997bbf94adbb64e7633a9`。
- 冻结产物只读 MCP：#199，main `c8daf16f18a672458ce3729b2e874cfe1c068218`。
- 浏览器验证对齐：#200，main `ebd84c0ef339de106ce287101bc9d1eb4d86d3c3`。
  完整浏览器 r2 冻结 `ec95a99d05604886e07e645d22d4385c048cb0c3`，相同 source tree
  `9651cf2aac881ea4432a3acfb660760badef74be`。
- 最后工作区测试修复：`f805dec1079a371b223672373f487a5f458d8eef`，相同 source tree
  `a0450ae1dcda08e75f518d8a531ac9d3ae213835`；只改 E2E 的明确项目/任务路由和定位，
  后续报告提交只改文档，运行时代码仍为 #199 的已验证版本。

## 已取得证据

| 检查 | 结果与实际范围 |
| --- | --- |
| `npm run typecheck` | 在 `9574c55c8b0f055a81e7a100d9608689ecee1798` 通过，随后合入 #196 |
| `npm run build` | 同一版本全 workspace 构建通过；包含 Web、server、artood |
| 最终集成类型与构建 | #199 相同 source tree 通过；包含 #200 的 `6e9601e0044f983f439e41a25ae304e433a4ae5d` 再次整仓 `npm run typecheck`、`npm run build` 均通过 |
| 服务关系与输入 | #197 的 4 套 DB/HTTP 回归 19/19 通过，含评审、配对输入、团队与成员资格 |
| Web 已发现失败修复 | #197 的 5 个受影响文件 65/65 聚焦回归通过；完整 Web 复跑另计 |
| Web/domain/protocol 完整单元 | 与 main `0bcf0de` 相同 source tree，160 文件、1640 测试全部通过，557.32 秒 |
| 核心协作浏览器集成 | `cowork-collaboration.spec.ts` 在同版本通过，25.7 秒；覆盖两个受控 WS 节点并行、固定字节的 Agent 意见、返修、最新输入、持久交接与人工接受 |
| delivery/closure 错误保留 | #197 的 7/7 回归通过，保留原执行失败和原 owner 关闭失败 |
| 真实 MCP 输入 | #199 的 4 套回归 94 通过、11 既有 POSIX 路径测试在 Windows 跳过；MCP 回归未跳过。实际子进程重建 UTF-8/二进制、8 类越权拒绝、close 0 与快照清理均有断言；缺命令/快照时拒绝启动 |
| 本轮完整质量范围 | 包含最后工作区测试修复的 `79c233032276a285ef4141c0d12f1f979c23f37a` 对原基线 `80c43bb` 执行 `check:changed`，207 文件通过；#198 纯格式修改另做 TS AST/CSS 结构比较无差异 |
| 浏览器首轮 UI/fixture 修复 | 仅修改 8 个 E2E 文件，保持业务断言，适配 Cowork 的定位、Drawer URL、项目作用域与实际消息准备；`ec95a99d05604886e07e645d22d4385c048cb0c3` 的 17/17 聚焦浏览器用例通过，3.2 分钟 |
| 完整浏览器 r2 | 57/58 通过，9.0 分钟，命令 exit 1；唯一失败是响应式评审 fixture 未固定路由，落到 Board drawer 后仍等待 workspace 容器 |
| 最后工作区 fixture 回归 | `f805dec` 的 trusted-preview 全文件 5/5 通过，1.2 分钟；主动创建并选择其他项目，再明确进入 Artoo Task room，验证 1280/1024/390 布局、消息与最终接受，未删除断言 |
| Scheduler E2E | 最终 `f805dec` tree 的 4/4 通过，47.4 秒；真实本地浏览器/server/DB 与受控 mock 执行，覆盖显式委派、树导航/限制、统一入队去重、迟到评论、task mirror、人审与单 child/slot；不证明原生 protected scheduler 资格 |
| Capacity E2E | 同一最终 tree 的 1/1 通过，33.0 秒；真实 reservation capacity 路由/浏览器与受控 mock 执行 |
| 旧全量已报错两项的最新代码复现 | 在 #199 相同 source tree、私有 TEMP、单 worker 下重跑 workspace allocation 升级与 skill configuration drift，2/2 通过，86.04 秒；同文件的 20 项因显式 testNamePattern 未选中，不计为通过或平台跳过 |
| Windows 新原生 helper | 实际 .NET 10.0.404 构建通过；新摘要见下 |
| Windows 原生矩阵 | 启动窗口 2/2、target input 7/7、target control 18/18、ordinary node 1/1 通过；外层观察均为 exit/close 0、双 EOF、无超时 |
| 独立安装 daemon 联调 | 在 main `25a3552` 构建测试包并通过真实 HTTP 配对、enroll、WebSocket 注册/心跳和四个真实受控 CLI 子进程任务；正常 IPC shutdown、exit/close 0、双 EOF、server disconnect 通过 |
| 最终集成安装复跑 | 在 #199 相同 source tree 构建新包 `0.1.0-cowork-final.2`，再次完整通过上述配对/注册/心跳、四个受控 CLI、租约释放与实际关闭检查；此轮子进程 TEMP 使用隔离私有目录 |

原生 helper 摘要：
`sha256:47dbe40517c8dc01dbb306ff230cb6c96e624972c374af2bdc360cf7916a3e00`。
测试包：`@jiayunxie/artood@0.1.0-cowork-final.1`，runtime manifest
`sha256:d2768f8b8c4e49f77c18dee7bbcdb658330a269174252d6f53f8ba0e036f941e`。
测试包未发布到 npm，用户现有 daemon 配置和运行实例未被覆盖或停止。

最终复跑包有 177 个文件、99,774,996 字节，runtime manifest 为
`sha256:87aa99dde76467f42f02089d496df36ba639ee35d58bab5edcb7c86a24ca4ff6`。
原始结果为 `connection-evidence-r2/result.json`，保留首轮包与结果。

四项任务为 Codex/Claude 各一次成功和一次预期失败。检查了真实任务进程 PID 消失、
日志与最终回答持久化、patch 实际字节摘要及写租约释放。CLI 是明确标注的本地测试程序，
没有调用模型。此结果不证明浏览器与 daemon 同次联调、运行中任务 Stop、真实 Provider、
两台物理电脑或 Windows protected scheduler 已通过。

## 验收结果与缺口

- 完整浏览器首轮为 49 通过、9 失败，保留原始日志；UI 定位/项目作用域等 8 处已修复，
  17/17 聚焦回归通过；完整 r2 为 57/58，最后一项路由 fixture 修复后全文件 5/5 通过。
  **没有把不同轮次相加成同一轮 58/58；最终完整命令仍无全绿结果。**
  其中一个既有产品浏览器负例触发 Windows `observer_retry_exhausted@ancestry_confirmation`，
  原 `assert_value failed` 完整保留，清理观测不足不能计为成功。`final_audit` 重抛同一锁存错误；
  完整 r2 原样通过该负例及实际 Windows 父进程/helper 关闭用例，但尚未确认首轮系统原因。
  未放宽期限、修改 native 实现或忽略清理失败。
- `npm test -- --maxWorkers=2` 在旧冻结 `25a3552` 运行近半小时，记录到
  workspace-allocation 和 scheduler execution-request 用例失败；imported-design-continuation
  仍在执行时主动停止了这次已被后续修复替代的旧版本长跑，保留目录、日志及
  `unit-r1-stop.json`（3 个所属测试进程均确认消失）。此轮为 **未完成、未通过**，
  不输出虚构的全量计数，也不用后续两项聚焦通过代替全量结论。该次未完成的
  imported-design-continuation 也没有完整套件结果，不能据此宣称已关闭其历史问题。
- 最终工作区、调度与容量聚焦检查已结束，所属服务退出。完整 r2 的最后 fixture 修复后
  没有再次运行整套 58 项；本次只交付明确范围的结果，仍需最终同版本全量门禁。
- 未取得真实 Provider 和两台物理电脑的产品验收证据。Windows journal 的目录刷新和
  新调度资格仍单独计，失败或未知时保持关闭，不阻塞普通配对任务路径的验证。

## Windows 输入目录条件

真实 MCP 回归使用新建隔离的私有 TEMP；未修改用户的现存安装。只读审计确认本机
默认 `AppData` 的外部 capability SID 有祖先替换权限，默认 TEMP 及新子目录还继承
两个外部用户 SID 的读取/替换权限，因此原私有输入边界会明确拒绝该目录。
这同样影响未配置受保护目录的普通 daemon，不是 MCP 测试专属条件。

测试目录为 `mcp-private-temp`，仅对新建目录关闭继承并授予当前用户、SYSTEM、
Administrators 可继承 FullControl；只在测试进程设置 TMP/TEMP/TMPDIR。

安装应使用既有 `team-config.temporary_directory` / `ARTOO_MANAGED_TEMPORARY_DIRECTORY`
机制指定合格目录，实际进程由既有启动器设置 TMP/TEMP/TMPDIR。没有加入隐式回退、
放宽 NTFS 检查或修改用户目录 ACL；本次回归不证明用户当前安装已具备此条件。
配置与 ACL 验证见 `scripts/npm-daemon/team-config.mjs`；实际环境应用见
`scripts/npm-daemon/cli.mjs`，使用说明见 `docs/npm-daemon-setup.zh-CN.md`。

## 本地原始证据

主工作树 `.artoo/final-validation-20261116/` 保留初次失败及后续类型、构建、质量、
全量回归、测试包构建与 daemon connection 日志。Windows 实际进程证据位于：

`C:/Users/jiaxie/.artoo/native-development/cowork-final-20261116/`

其中 `connection-evidence/result.json` 记录四个任务的实际结果和关闭事实。
这些本地证据含测试状态和路径，不作为生产部署或正式发行验收。

server 工作树 `.artifacts/cowork-quality-validation/` 保存最终质量、类型/构建、
两项旧全量失败复现和最终安装包/connection 日志；Web 工作树
`artifacts/cowork-final-validation/` 保存完整单元、两轮完整 E2E 与最后聚焦回归，
相应 `apps/web/playwright-report/`、`apps/web/test-results/` 保存 HTML 与截图。
最后工作区的 6 张截图已目视检查：桌面保留任务列表/会话/详情，手机消息与评审控件
可见，无横向溢出。对应目录为
`workflows-2026-11-16T09-23-59-101Z/trusted-preview-review-con-8e83d-top-tablet-and-phone-widths-chromium/`。
截至 17:18，#200 main 的 Preview gates 仍为 queued，不计作通过；Azure deployment
validation 的通过不等于目标产品已部署或通过真实模型验收。
