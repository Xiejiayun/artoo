# Presence 与审计索引测量（P2）

## 范围和复现

Windows、Node 26.13.0、内存 PGlite；基线迁移到 `0060_list_query_indexes.sql`。夹具有 100 个任务、20,000 条消息、20,000 条 Run，其中 206 条非终态。使用参数化 SQL，每个阶段预热一次、采样 20 次并记录 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`。p95 使用 nearest-rank；宿主负载未受控，同进程按阶段执行，延迟仅供本地诊断。

先构建工作区，再从仓库根执行：

```powershell
npm run build
node scripts/benchmarks/presence-indexes.mjs .git/presence-index-reports
```

参数是报告的父目录。每次新建独立目录，逐阶段保留计划，最后写 `report.json`，不覆盖旧证据。脚本始终创建内存数据库，不使用外部数据库 URL。未指定目录时写入 `artifacts/performance`，生成的诊断数据不应提交。

## 候选取舍

迁移 `0061_presence_audit_context_indexes.sql` 追加三个索引，Drizzle schema 同步声明：

- `messages (organization_id, task_id, created_at, id)` 支持任务审计消息读取。
- `runs (organization_id, task_id, created_at DESC, id DESC)` 支持先取最新 Run 再判断完成状态，不回退旧成功运行。
- `runs (organization_id, computer_id, agent_instance_id) WHERE status NOT IN ('completed','failed','cancelled')` 共用组织/电脑/实例非终态集合。

第三个索引替代方案中的普通 `(organization_id, computer_id, status)` 候选。保留 queued、starting、running、awaiting_input、paused；没有新增 completed-only 索引，也没有另堆实例部分索引。

| 查询 | 基线计划与读取 | 选用索引后的计划与读取 |
| --- | --- | --- |
| 任务消息（200 条） | Seq Scan，过滤 19,800 行，364 shared hit blocks | Index Scan，200 行，205 hits |
| 最新任务 Run（1 条） | Bitmap 扫描 200 行再排序，203 hits | Index Scan，1 行，4 hits |
| 电脑非终态 Run（52 条） | 扫描历史；普通复合候选仍过滤 4,948 条，314 hits | 部分索引直接读取 52 条，53 hits |
| 实例非终态 Run（10 条） | 历史集合过滤 | 部分索引及任务关联，11 hits |
| 组织非终态 Run（206 条） | 历史集合过滤 | 部分索引及任务关联，207 hits |

两个排序索引在该夹具中各占 1,376,256 bytes；普通电脑/状态候选占 163,840 bytes，选用的部分索引占 16,384 bytes。每个新索引均增加写入维护成本；本次没有测量持续写入吞吐、迁移锁等待或生产数据分布，不推断这些指标的改善。标准迁移会持有建索引所需的锁，正式升级应按既有维护和恢复流程执行。

第一次独立采样的本地 p95（ms）：

| 查询 | 基线 | 排序索引 + 普通状态候选 | 排序索引 + 部分索引 |
| --- | ---: | ---: | ---: |
| taskMessages | 12.7281 | 7.8900 | 9.8475 |
| latestTaskRun | 2.5990 | 0.9822 | 1.0917 |
| computerActive | 7.7174 | 2.6775 | 1.2078 |
| instanceActive | 3.0519 | 2.4115 | 1.8430 |
| allActive | 16.4422 | 12.7940 | 3.7988 |

可移植脚本复跑时与回归共享宿主，延迟有变化，结果保留在 `.git/opt-p2-benchmark/presence-indexes-FHKgrA`；初次计划保留在 `.git/opt-p2-query-plans.json`。索引选择基于计划、行数和存储成本，不以小样本延迟承诺生产收益。

本机没有可用的独立 Postgres 执行环境，因此未验证生产 Postgres 查询计划、连接池往返、prepared statement generic plan 或生产 p95。部分索引是否被选择仍取决于实际统计信息和计划。
