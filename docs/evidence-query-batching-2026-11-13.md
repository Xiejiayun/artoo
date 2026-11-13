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
