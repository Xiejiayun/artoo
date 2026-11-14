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

首轮本机没有可用的独立 Postgres 执行环境；后续独立 PostgreSQL 的本地计划与有界写入成本见下节。连接池往返、prepared statement generic plan 和生产 p95 仍未验证。部分索引是否被选择仍取决于实际统计信息和计划。

## 2026-11-15 独立 PostgreSQL 与写入成本补充

本节补充前述历史采样的缺口，不替换其原始结果。验证源码为 main `c3923ad7a9959d795497b0960b8ac628a9f7a3db`；执行 checkout 为 `94c8f41`，相关 DB、存储和基准源码与该 main 相同。Windows、Node 24.22.1，独立 PostgreSQL 18.6 通过回环 TCP 和现有 `PostgresDbClient` 访问，仍为一个物理会话。运行时来自固定的 `@embedded-postgres/windows-x64@18.6.0-beta.19` 包，实际二进制报告 PostgreSQL 18.6，下载归档 SHA-1/SHA-512 与包元数据一致；没有安装系统服务或连接现有数据库。

四轮均创建新数据库，按“基线、索引、索引、基线”顺序运行。基线真实迁移到 0060，使用现有基准相同的 100 任务、20,000 消息、20,000 Run（206 非终态）SQL；候选真实应用 0061，不另写替代索引。查询在写入阶段前预热一次、采样 20 次并保留完整 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`，共 400 个计时样本。下列两轮重复的根节点 shared hit blocks 相同，shared read blocks 都是 0，故这些是热缓存结果：

| 查询 | 行数 | 基线计划与 hits | 0061 后计划与 hits |
| --- | ---: | --- | --- |
| taskMessages | 200 | Seq Scan + Sort，364 | messages_org_task_created_idx，205 |
| latestTaskRun | 1 | 原 task/status Bitmap + Sort，203 | runs_org_task_created_idx，4 |
| computerActive | 52 | Seq Scan，308 | runs_org_active_idx，53 |
| instanceActive | 10 | 原 history Bitmap + Hash Join，327 | runs_org_active_idx + Hash Join，13 |
| allActive | 206 | Seq Scan + Hash Join，310 | runs_org_active_idx + Hash Join，209 |

两轮基线 / 两轮候选的本地查询 p95（ms）分别为：taskMessages 10.81 / 14.65 → 2.77 / 4.97；latestTaskRun 1.32 / 1.28 → 0.86 / 0.81；computerActive 5.75 / 8.49 → 0.67 / 0.72；instanceActive 2.13 / 2.02 → 0.89 / 1.00；allActive 7.19 / 15.88 → 1.45 / 1.72。宿主负载未受控，不据此承诺生产 p95。

另在每个数据库执行 14 个提交批次，前两个预热，其余 12 个计时。每批一个事务，依次插入 100 条消息、100 条 Run（99 completed、1 running），将固定的 100 条已有 Run 改为 running，再改为 completed；包含 BEGIN/COMMIT，总计 400 次行变更。PostgreSQL 逐语句实际影响行数均为 100；四轮最终消息、Run 各为 21,400 条。没有以回滚消除写入成本。PostgreSQL 保留默认 fsync、synchronous_commit、full_page_writes=on，shared_buffers=128MiB。

| 引擎与范围 | 两轮基线批次中位数 / p95（ms） | 两轮 0061 批次中位数 / p95（ms） |
| --- | --- | --- |
| 内存 PGlite，单独四轮 | 37.19 / 43.41；31.84 / 53.10 | 51.30 / 64.32；57.97 / 77.89 |
| 独立 PostgreSQL，回环 TCP、磁盘持久化 | 24.03 / 29.28；36.56 / 43.08 | 58.57 / 100.30；47.88 / 175.64 |

两种引擎各自有 56 个批次、48 个保留样本；引擎、协议和持久化方式不同，不能用这张表比较它们的性能高低。结果说明这些索引存在写入维护成本，读取收益不能推广为整体吞吐改善。PostgreSQL 的两个排序索引各从 1,376,256 bytes 增至 2,195,456 / 2,203,648 bytes，部分索引保持 16,384 bytes；这是短序列插入/状态更新后的原始大小，未执行 VACUUM，不代表稳态膨胀或持续写入吞吐。

原始完整计划、计时、每批行数、设置、退出/关闭与输出 EOF 证据分别保留在 `.git/opt-p2-write-diagnostic-2026-11-14T18-01-40.353Z/` 和 `.git/opt-p2-postgres-diagnostic-2026-11-14T18-14-16.471Z/`；对应独立核验为 `verified-write-diagnostic.json`、`verified-postgres-diagnostic.json`。本机驱动保留为 `.git/opportunities-p2-write-diagnostic.mjs` 与 `.git/opportunities-p2-postgres-diagnostic.mjs`，固定原夹具/迁移指纹，每次创建新报告和新数据库，不覆盖旧证据。四个 PostgreSQL 客户端、管理连接和 postmaster 均实际正常关闭，无强制清理；本次新数据目录保留。

独立 PostgreSQL 的计划与有界写入成本已补测；远程网络延迟、持续/稳态写入吞吐、生产数据分布、迁移锁等待仍未覆盖。上述结果不替代最终统一 E2E 或真实 Provider 验收。
