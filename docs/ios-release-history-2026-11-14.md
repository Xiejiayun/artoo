# iOS 发布管控、Agent 历史和 Goals 入口

F3 从 main `8068041` 开始，复用现有 GoalDetailView、认证资源客户端、组织边界和服务端发布/历史契约。

- Tasks 工具栏增加 Goals 入口，保留 More → Goals 和现有计划操作。Goal 详情增加发布状态入口；More → Release 按当前项目列出 Goal。
- 发布详情分别查询静态站点 `GET /goals/:id/release` 与本地应用 `GET /goals/:id/application-publication`。两个分区独立加载/报错、每 5 秒刷新，可查看发布记录、健康、原因和原始证据。完成 Goal 不会被显示为发布完成。
- 本地应用停止先确认，再调用其专属 `/application-publication/stop`。沿用服务端 active-member/组织检查，静态站点无此停止操作。失败保留错误和逻辑幂等键；停止不等待悬挂 GET，旧 GET 不得覆盖停止响应。历史发布和当前可用性分别显示；断线、样本过期、租期到期、未来时间与停止前旧样本均不能保留“健康运行”。每秒重算可用性，避免下一次 GET 前旧证据持续有效。
- 本地应用在发布电脑的 loopback 地址运行，手机不提供错误指向自身的打开链接。静态站点只在确认发布、无同步错误且健康记录允许时显示无凭据 HTTP(S) 远程链接，排除 loopback。发布和健康语义不变，没有新增产品发布操作。
- Team → Agent history 按 Agent 和当前项目读取所有实例的执行记录，20 条一页；进入某次执行后才加载原始请求和事件，50 条一页，按 position 从新到旧。工具请求/响应、截断、退出码、最终回答和原始事件按需展开。明确区分未记录、空列表和加载失败，失败保留已加载页及重试游标；显式刷新回到最新页。校验版本、Agent/Run 身份、分页形状、正整数位置、记录身份与游标推进，防止畸形响应被解释为完整空历史。

验证记录：

- 根 `npm run typecheck` 通过（`.git/opt-f3-typecheck.log`），只证明 TypeScript 工程状态。
- Windows 静态契约：22 个请求样本、58 个端点及共享 AgentHistoryPage/Detail/RunActivity 夹具通过（`.git/opt-f3-contracts.log`）。
- Node 22.23.4/tree-sitter 对本项新增/修改的 12 个 Swift 文件解析无诊断（`.git/opt-f3-syntax.log`），不是 Swift 类型检查。P7 已记录的两个未修改文件的全仓诊断未在本项消除。
- 服务端 Agent History/静态发布 2 文件、16 项回归通过（`.git/opt-f3-server-tests.log`）。
- 本地应用发布/停止聚焦回归 1 项通过（`.git/opt-f3-application-tests.log`），实际验证停止后保留发布回执与 Goal 结果；同文件另 53 项由名称过滤未运行，不属于全文件通过。staged 代码质量检查 3 文件通过（`.git/opt-f3-quality.log`）。
- 新增 8 个 XCTest：远程链接/健康条件，观测与租期过期，确认/未知关闭，专属停止路由与失败重试键，Agent/项目请求和错误身份，position 分页及工具载荷，畸形/不推进页，停止不被旧 GET 覆盖。**尚未执行**；此 Windows 环境无 Xcode，需由 macOS gate 补齐。

原生验收仍需在最终冻结版本运行 `npm run verify:ios`，并实际检查 Tasks → Goals、Goal/More → Release 和 Team → History 的小屏/大字体布局、分页、断线重试、停止确认/失败/最终关闭。现有 11 个 UI 用例清单保持，不能将其既有覆盖当作新增页面 UI 通过。当前静态检查、服务端回归不等于 iOS E2E 或真实 Provider/产品发布验收。

2026-11-14 补充：`cb2a128` 原生单元测试实际 199 项全部通过，含上述八项 F3；新增 core 导航已在 PR #113 的原生运行中通过七项完整 core 套件。真实 Agent History 原始请求、完整响应和未发布 Goal 的独立发布分区已实际操作；已发布健康、停止失败/最终关闭及断网重试页面仍需独立原生交互验收，不能用 ViewModel 单元测试替代。

从 PR #113 合并后的 `b779006` 再修正静态链接的回环识别：整个 127/8、localhost 根点/子域、数字 IPv4 别名、IPv6 回环及映射的 127/8 都指向手机自身，不能展示打开入口。识别使用 Foundation 解码后的 host 与系统地址解析，不做 DNS，也保留正常域名、局域网和其他 IPv6。新增 XCTest 同时覆盖拒绝与可用地址；当前仍待真实 Foundation/XCTest 复核。
