# P5 紧凑状态与本机 HTTP 测量

## 可复现方法

先构建 server，然后执行 `node scripts/benchmarks/message-reconciliation.mjs`；可选参数指定报告父目录。脚本新建独立报告目录，使用已迁移的内存 PGlite、真实 session 鉴权和监听随机回环端口的 Fastify，不读取用户数据库地址或凭据。每次请求有 15 秒期限，结束后按资源所有权反序关闭；不删除报告。

夹具有 250 条用户根消息（普通正文 4,200 字符）、末根 7 条漏收回复计数、最旧历史 1 条管理员移除，没有新根增量。比较原 100-ID 可见性批次加快照、500-ID 批次加快照、500-ID 紧凑状态。每种先预热 5 次，再测 30 次；每轮轮换顺序。每个样本核对全部 ID 的移除与回复数一致后才记录。耗时包含顺序 HTTP、鉴权、数据库查询、JSON 读取和结果核验；字节仅为响应正文，不包含请求、头部或 TLS。

## 冻结版本结果

实现版本 `0edfdf7204c804d6b9b4698ae93c4eb770d1abba`，执行时追踪源码干净，Windows / Node 26.13.0。server build 与脚本实际退出 0。完整原始样本从脚本打印的 artifacts 路径移至 `.git/opt-p5-compact-http-evidence/message-reconciliation-sQffbe/report.json` 保留；日志 `.git/opt-p5-compact-http-final.log`。

| 路径 | 每次请求 | 响应正文 bytes | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| 原 100-ID + 根快照 | 5 | 224,073 | 59.52 | 129.83 |
| 500-ID + 根快照 | 3 | 224,021 | 40.25 | 156.03 |
| 500-ID 紧凑状态 | 2 | 13,593 | 25.35 | 69.14 |

批次路径的 p95 在本轮高于原路径；本机调度与尾延迟有波动，不能以请求数推断延迟一定按比例下降。此前未冻结源码的探索样本（同父目录 `message-reconciliation-SToh1X/report.json`）p95 分别为 251.66 / 146.03 / 112.33ms，亦保留，不与冻结版本混算。两轮的请求和字节计数一致。这里比较的是同一 server 上客户端请求策略，未测远程服务、压力下吞吐或生产 p95。

## 验证范围

聚焦回归覆盖旧能力回退、完整响应校验、无效版本/计数/ID 覆盖拒绝、房间和组织隔离、真实权限、500/501 边界、未知 ID 不泄露，以及后续批次失败时全部房间/线程/单消息缓存即时脱敏。组件验证无新根时回复数更新、分页保留、并发历史和实时较新计数不回退，另保留旧 agent 文本的历史计划投影快照。

真实 Chromium 测试使用真实服务端，断开并隔离该浏览器 HTTP/WS，经独立 HTTP 请求新增线程回复、移除已加载的旧历史；恢复网络后核对实际 UI、没有额外正文根快照，刷新后再次加载历史仍保留脱敏。WebSocket 路由只转发真实流量并控制断开，不注入业务事件或响应。

根 typecheck、server/Web build 通过。初轮聚焦 5 文件、59 项通过；补充跨组织边界及实时缓存回归后 2 文件、12 项通过，后者包含复跑的服务端 7 项。跨组织夹具首次漏建用户导致外键失败，补齐用户后原断言全部通过，失败日志 `.git/opt-p5-compact-boundaries.log` 保留。成功记录分别为 `.git/opt-p5-compact-tests.log`、`.git/opt-p5-compact-boundaries-fixed.log`、`.git/opt-p5-compact-typecheck-final.log`、`.git/opt-p5-compact-server-build-final.log`、`.git/opt-p5-compact-web-build.log`。

冻结源码上的最终聚焦 Chromium E2E 两项通过：既有独立客户端同步/刷新与新增断连期间回复/旧分页移除；使用新的独立数据目录，完整命令实际退出 0。日志 `.git/opt-p5-compact-e2e-final.log`，浏览器证据 `apps/web/test-results/workflows-2026-11-13T14-41-56-010Z`。此前探索运行两项也通过，但最终结论使用补强断连隔离断言后的运行。受控断开会产生 WS proxy ECONNRESET 日志，业务结果与断连期间未收到更新的断言均通过。

这是受控本机源码与浏览器验证，不是生产延迟、远程 Postgres、原生应用或真实 Provider 产品验收。最终统一门禁在其余优化合并后执行。
