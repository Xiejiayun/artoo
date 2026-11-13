# 服务端字面搜索（F4）

## HTTP 契约

三个现有 GET 接口增加可选 `q`，未传时保留原列表、游标与排序语义。`q` 是 1–200 个 UTF-16 code units 的字符串，拒绝空白、NUL、重复参数和超长原始输入；去除首尾空白后使用参数化 `ILIKE`。大小写规则由数据库 collation 决定；`%`、`_`、反斜杠都是字面字符，不提供查询语言、词干、分词、相关度或命中总数。

| 接口 | 搜索字段与范围 | 排序和边界 |
| --- | --- | --- |
| `/api/v1/tasks?project_id=…&q=…` | 当前组织、指定项目的 title 或 description；保留 review provenance | created_at、id 升序；沿用可选 limit，匹配后限制；未实现任务游标分页 |
| `/api/v1/memories?q=…` | 当前组织的 text、JSONB payload/tag 的数据库文本表示（含键）；沿用 scope/status/project_id/task_id/tag | q 路径 created_at、id 升序，匹配和 tag 精确过滤后 limit；不改变无 q 旧路径；未实现 Memory 游标分页 |
| `/api/v1/rooms/:id/messages?q=…` | 已授权房间的 body，含全部根消息和回复；有 thread_root_id 时仅该线程回复；排除受保护 moderated_at 已标记的消息 | 沿用单调 position、默认 50、最大 100、before/after 双向分页；每页响应按 position 升序 |

消息搜索使用独立 `search.v1` 游标，绑定房间、线程和规范化后的查询文本（SHA-256 scope 摘要），不接受普通历史游标或其他查询的游标。游标是位置标记，不构成授权或数据库快照；每次请求仍重新检查房间/组织和移除状态。新增和移除可能改变后续页，客户端按 ID 去重。查询大小写变化会形成新游标作用域。

复用现有组织/项目/房间可见性，不新增跨组织发现能力。线程根被移除后，仍沿用现有线程读取规则：根正文脱敏，未移除回复可读。搜索只返回可见消息，不返回已移除摘要或计数。Memory 搜索不会改变 context 接口的 accepted-only 注入语义。

## Web 行为

会话头部新增 Search messages，线程新增 Search replies。显式提交搜索，保留 IME；独立无限查询缓存，逐页展示最新命中，Load older matches 读取历史命中。搜索结果通过已有频道深链进入服务端验证后的根消息/回复。已确认移除即时清除相关搜索页，并失效房间搜索；断连和重连沿用退避轮询与全量对账。

旧查询迟到结果使用独立查询键，不覆盖当前查询或普通会话历史。关闭即回收搜索缓存。列表正文截取至 800 字符，不作 HTML 插值。Modal 沿用 Escape、Tab 焦点圈和关闭恢复；头部可换行，小屏长文本可断行。

Board/TaskList/Memory 的现有全量列表及本地过滤继续保留；新增 q 为后续有界列表提供服务端能力，不把搜索子集写入共享全量任务缓存。Goals、Inventory、Audit 未在本项扩展 q。

## 索引与迁移

新迁移 `0062_literal_search_indexes.sql` 安装 `pg_trgm`，为 task.title、task.description 创建 GIN trigram 索引，为未移除 message.body 创建部分 GIN 索引，Drizzle schema 匹配。PGlite 显式注册已安装包内附带的扩展，普通创建、备份恢复和 legacy reference 均使用相同注册。

标准 PostgreSQL 需要安装可用的 `pg_trgm` 扩展并给迁移角色相应权限；缺少扩展/权限时事务失败，不静默宣称升级。GIN 建立和后续写入有存储及维护成本，升级需按现有备份/恢复 runbook 执行。独立 PostgreSQL 服务与线上迁移锁/写入吞吐未在当前 Windows 环境测量。

Memory 候选的 text/payload/tags 三个 GIN 索引在稀有命中场景仍走 Seq Scan，因此未加入正式迁移。单字符/常见子串及 Memory 大范围搜索仍可能扫描；不声称任意搜索耗时有界。未来如实际规模要求，应按分布测量后追加迁移，不能以 tokenized full-text 静默改变字面语义。

## 本地查询计划证据（2026-11-14）

Windows、Node 26.13.0、内存 PGlite：20,000 条消息分布于 10 个房间，5,000 个任务、5,000 条 Memory；长文本、稀有/缺失/单字符三个查询。每查询先预热、采样 10 次，记录 p50（第 5 个）/p95（第 10 个）与 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`。每阶段校验结果 ID 相同；共享宿主负载未受控，按阶段顺序执行，数字只作本地诊断。

```powershell
npm run build
node scripts/benchmarks/search-queries.mjs .git/search-query-reports
```

脚本仅创建隔离内存库，不读取数据库 URL。每次新建报告目录，不覆盖旧证据。此轮报告已保存在 `.git/opt-f4-search-query-reports/search-queries-5q0JEc/report.json`，日志 `.git/opt-f4-search-benchmark-selected.log` 保留运行时原始路径。

| 查询 p50 ms | 既有索引 | 最终选择的消息/任务索引 |
| --- | ---: | ---: |
| 房间消息，稀有命中（2 条） | 17.44 | 1.91 |
| 房间消息，无命中 | 22.47 | 1.40 |
| 房间消息，单字符（51 条） | 7.71 | 5.35 |
| 任务，稀有命中（5 条） | 40.99 | 1.58 |
| 任务，无命中 | 40.15 | 1.22 |
| 任务，单字符（50 条） | 3.72 | 3.05 |
| Memory，稀有命中（5 条） | 51.58 | 41.72 |

Memory 最终没有新增索引，变化视为采样波动；候选三索引仅改善无命中，不足以证明应承担其维护成本。房间稀有命中从房间 B-tree 的 Bitmap Heap Scan + 过滤转为 body GIN Bitmap Scan + 过滤；任务从 Seq Scan 转为 title/description BitmapOr。短查询可沿用原排序索引，不能从上述小数据推断生产收益。

该夹具的稀有命中 shared hit blocks：消息 1,001→53、任务 248→55。候选消息 GIN 1,736,704 bytes，任务 description/title 分别 229,376/204,800 bytes；这只是当前数据上的索引体积，未测持续写入成本。

## 验证

验证结果随该项集成记录于 [实施进度](opportunities-progress.md)。服务端测试覆盖字面文本/Unicode、过滤后 limit、组织/项目/房间隔离、真实移除、线程和双向查询绑定游标、非法参数；扩展迁移回归覆盖旧数据升级、重复启动、备份恢复及 legacy reference；Web 覆盖显式提交、IME、迟到响应隔离、分页/去重、失败重试与实时移除。真实浏览器和完整仓库门禁的状态分别记录，不以局部测试替代最终 E2E 或 Provider 验收。

本项根 typecheck、server/Web build、服务端/迁移/存储 5 文件 32 项、最终搜索/移除 2 文件 12 项、完整 Web 67 文件 630 项、Chromium 2 项通过。日志为 `.git/opt-f4-final-typecheck.log`、`.git/opt-f4-server-build.log`、`.git/opt-f4-final-web-build.log`、`.git/opt-f4-integration-tests.log`、`.git/opt-f4-final-server-tests.log`、`.git/opt-f4-web-all.log`、`.git/opt-f4-e2e-third.log` 和 `.git/opt-f4-quality.log`。

最后 key 修复后的会话/搜索组件回归 2 文件 30 项通过：`.git/opt-f4-final-components.log`。

浏览器首轮发现频道 CSS 把整个会话头部隐藏；改为只隐藏重复标题/计数，保留紧凑搜索入口。第二轮发现搜索弹窗与时间线的 sibling key 重复，造成关闭后残留，已加前缀修复；深链目标按既有设计显示于 Mentioned reply 区域，测试据此定位。最终两项通过，保留首两轮失败日志 `.git/opt-f4-e2e.log`、`.git/opt-f4-e2e-second.log`；没有增加超时或跳过断言。截图目录 `apps/web/test-results/workflows-2026-11-13T17-25-06-655Z`，桌面与 320px 已人工查看。
