# 审计与交接查询批量化（P3）

## 实现与边界

基线为 main `fa2deb835844d859e01c6e9495f1e16ca8a51b7c`。生产 `PostgresDbClient` 为保持会话锁和事务串行化，刻意使用单会话（连接池 `max: 1`）。本项选择批量化，未放宽该存储不变量，也不宣称 Promise.all 可以增加生产查询并行度。

ContextPack 仍先授权依赖两端的组织和项目，取最多 101 条有序边、处理前 100 条。一次 `DISTINCT ON` 按任务读取最新 Run（`created_at DESC, id DESC`），随后在内存判断 completed；失败、运行中、取消或暂停的新尝试都不会回退旧成功。第二次查询用 LATERAL 为每个接受的 Run 分别取最多 101 个制品，保持每任务 100 条及截断标记，且同时核对制品组织、任务与 Run。只选择交接需要的列，继续输出受控 content API 路径。

Goal 审计先读取组织内有序子任务，每 20 个任务顺序执行一批关联查询。每批最多 10 次关联读取，空 room 集合跳过查询；没有无界子任务并发。单任务审计复用同一装配与脱敏路径。查询结果按 task_id 分组，并按 task_id/correlation_id 的并集分配事件，同一事件在同一任务内只出现一次；一个事件可以属于两个不同任务。保持各表排序、工作区保留证据和现有脱敏。没有新增事务快照保障；审计读取一致性级别沿用现有实现。

## 本地测量

Windows、Node 26.13.0、内存 PGlite，真实 SQL、一次预热后 10 次串行样本，nearest-rank p95。未控制宿主负载，优化后测量时还有其他回归运行，因此时间仅供诊断；查询次数和返回行数由真实客户端调用记录并纳入回归断言。

| 夹具 | 查询次数（前→后） | 返回行数（前→后） | 本地 p95（前→后） |
| --- | ---: | ---: | ---: |
| 101 条可见依赖边，取前 100；其中 4 个最新 Run 非成功；首任务 105 条制品 | 204→10 | 398→398 | 289.4984→92.2030 ms |
| 45 个子任务，每个有 room 和消息，含 task/correlation 关联事件 | 501→36 | 186→140 | 1024.1799→209.6913 ms |

返回行数统计所有 SQL 结果，而非最终 JSON 条数。审计减少重复子任务读取和同批关联事件重复读取，最终输出的归属和事件内容保持一致。交接测量在一个真实 PGlite 事务中直接记录事务客户端 query，不包含 BEGIN/COMMIT；外层客户端的 spy 无法记录事务查询，不能把它的零计数当作基线。

复现：

```powershell
$previousQueryBatchReport = $env:ARTOO_QUERY_BATCHING_REPORT
try {
  $env:ARTOO_QUERY_BATCHING_REPORT = Join-Path (Get-Location) '.git/query-batching-metrics.jsonl'
  npx vitest run apps/server/src/query-batching.test.ts --maxWorkers=1
} finally {
  $env:ARTOO_QUERY_BATCHING_REPORT = $previousQueryBatchReport
}
```

报告追加计数、行数及耗时，不含正文或凭据。普通回归只测一次。基线实现对最终查询数断言会失败，这是预期的性能约束，不代表基线产品功能失败。实施时在添加最终性能断言前保存了基线完整成功记录。

有效原始记录：`.git/opt-p3-baseline-verified.log` / `.jsonl` 和 `.git/opt-p3-after-verified.log` / `.jsonl`。初次夹具因缺少必填事件字段失败且事务计数无效，后续已修复；`opt-p3-baseline` 不能作为通过证据。初次实现的嵌套子查询选择不符合 Drizzle 标量规则，已改为显式列选择；`opt-p3-after` 也不是最终通过证据。

未运行独立远程 Postgres 测量，未测量生产 p95、峰值内存或网络。索引计划和存储成本见 [P2](presence-indexes-2026-11-13.md)。本项不构成最终统一 E2E 或真实 Provider 验收。

根 typecheck、server build 和最终 7 文件 27 项聚焦回归全部通过，最终日志为 `.git/opt-p3-final-typecheck.log`、`.git/opt-p3-build.log`、`.git/opt-p3-final-regression.log`。覆盖同时间戳最新 Run 的 ID 排序、失败/运行/取消/暂停不回退、组织/项目与制品关联隔离、单任务审计一致性、跨批次事件归属及重复关联去重。

## 2026-11-15 独立 PostgreSQL 后端补充

Windows、Node 24.22.1、独立 PostgreSQL 18.6 回环 TCP；相关服务、契约、存储和完整 `query-batching.test.ts` 与 main `c3923ad` 一致。一次性新集群/两个新数据库只承载生成的测试数据，使用项目原有 `PostgresDbClient` 单物理会话。未连接现有数据库，未读取 Provider 配置。

以独立诊断配置显式选择 PostgreSQL：原 PGlite 工厂改为返回真实 `PostgresDbClient`，选用匹配的 node-postgres Drizzle 驱动；原测试显式持有的事务由真实 pg session 执行 BEGIN/COMMIT 并 release。这个后端适配用于补充跨引擎验证，不属于普通默认 PGlite 测试入口。原文件的两个完整测试、全部断言、30 秒测试/Hook 时限均未修改，仍验证最新失败 Run 不回退、每任务制品上限、组织/项目隔离、消息与关联事件归属及跨批次去重。

两个测试实际通过（14.30s、8.09s），各预热一次后按原报告开关采样 10 次：

| 当前实现的真实 PostgreSQL 夹具 | 查询次数 | 返回行数 | 本地 p95 |
| --- | ---: | ---: | ---: |
| 101 条依赖边的 ContextPack | 10 | 398 | 168.95 ms |
| 45 个子任务的 Goal 审计 | 36 | 140 | 71.93 ms |

原测试的 JSONL 报告把 engine 固定写成 `local PGlite`；为保留原测试字节未改该文字。独立报告明确以实际 PostgreSQL 18.6 版本、两个真实 backend PID 和 127.0.0.1 地址更正本次后端身份，不能把该文字当作引擎证据。上述时间没有同轮旧实现的 PostgreSQL 对照，也没有远程网络，不能据此计算 PostgreSQL 优化百分比或比较历史 PGlite 样本。

证据为 `.git/opt-p3-postgres-diagnostic-2026-11-14T18-18-30.866Z/` 的原始 Vitest JSON/输出、`measurements.jsonl`、`backend-observations.json`、父报告和 `verified-postgres-query-batching.json`。本机驱动、后端配置与适配分别保留在 `.git/opportunities-p3-postgres-diagnostic.mjs`、`.git/opportunities-p3-postgres.vitest.config.mjs` 和 `.git/opportunities-p3-postgres-setup.mjs`。原测试 SHA-256 为 `a088d55886da1a306a3679160fc2ada0ea577769675ee872d2dbe635e38abb51`，与 main/current 源码一致。

原测试客户端和管理连接均已正常关闭；Vitest 子进程、postmaster 及管理 helper 实际 exit/close=0，输出 EOF 完整，没有强制清理，临时数据保留。另一次只读活动观察恰逢已发出的 fast shutdown，返回 57P03 并退出 1；它未参与测量、未重启服务，不改变原两项测试通过结果。

本节补充独立 PostgreSQL 的当前行为、查询数与本地延迟，远程 PostgreSQL 测量仍未完成；不替代普通完整测试、原生客户端或真实 Provider 产品验收。
