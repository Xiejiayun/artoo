# Presence 批量读取测量（P1）

## 范围和方法

2026-11-13，Windows、Node 26.13.0、npm 11.20.0，本机内存 PGlite；不含 HTTP、网络、远程连接池或生产流量。数据为 20 个 Agent 实例、4 台电脑、4 个 runtime、1,000 条终态 Run 和 20 条运行中 Run。原实现取自 main `e61992be43d8a1ccd93ba65d3d4d647433416ec1`，使用相同夹具测量。

在一次预热后，各记录 20 次串行请求，以 nearest-rank 计算 p95。前后独立测量均使用 `--maxWorkers=1`。宿主负载未受控，20 次是小样本，延迟仅供本地诊断；查询次数和返回行数由真实 PGlite `query` 调用记录并由回归断言约束。未测量生产 p95、堆峰值、RSS 或写入开销，不推断这些指标的改善。

| 列表 | 优化前查询数 | 优化后查询数 | 优化前返回行数 | 优化后返回行数 | 优化前本地 p95 | 优化后本地 p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Agent 实例 | 81 | 5 | 1,080 | 48 | 108.404 ms | 8.880 ms |
| 电脑 | 13 | 4 | 1,028 | 28 | 18.007 ms | 5.730 ms |

另外一次与其他 Presence 回归共同运行的采样得到实例 6.092 ms、电脑 3.369 ms；该次 `--maxWorkers=2`，不用于上述独立前后比较。返回行数包含所有关联查询，而非 API 结果条数；终态历史不再传入 Node.js。

## 复现及证据

当前回归默认只测一次，避免为普通 CI 增加不必要的计时循环。使用 PowerShell 可以显式写出 20 样本的 JSONL 报告，指定新的报告路径以区分调用：

```powershell
$previousPresenceReport = $env:ARTOO_PRESENCE_BENCHMARK_REPORT
try {
  $env:ARTOO_PRESENCE_BENCHMARK_REPORT = Join-Path (Get-Location) 'presence-metrics.jsonl'
  npx vitest run apps/server/src/presence-agent.test.ts -t 'measures list query growth' --maxWorkers=1
} finally {
  $env:ARTOO_PRESENCE_BENCHMARK_REPORT = $previousPresenceReport
}
```

报告追加每种列表的样本数、查询数、总返回行数与 p95，不包含任务正文或凭据。测试源码中的查询数/返回行数断言验证最终实现；还原原实现进行比较时应保留原始输出，不能将原实现对新性能断言的失败包装成通过。本次原实现采样在引入最终性能断言前完成。

本机原始记录保留在 Git 元数据目录：`opt-p1-baseline-metrics.log` / `.jsonl`、`opt-p1-tests.log`、`opt-p1-after-metrics.jsonl`、`opt-p1-after-isolated-metrics.log` / `.jsonl`、`opt-p1-final-typecheck.log`、`opt-p1-build.log`。它们不提交到工作树；上表和命令用于持久交接。

测量时文件字节 SHA-256（Windows 工作树字节，非 Git 对换行归一化后的 blob）：

- `apps/server/src/services/presence-service.ts`：`7f097aaca451d2964f6029adc756b6980c2ae1cea397d6d1946edb1f6c059e5d`
- `apps/server/src/presence-agent.test.ts`：`f391b013c0b1fc110333ce487ea8cfe196ef2ab9591a96c1c36df83019894037`

## 正确性验证

Presence 的五个领域/服务/API 文件共 52 项通过；根 typecheck、服务端 build 通过。覆盖所有 Run 状态、Task 审批优先级、共享电脑 queue depth、设备撤销优先级、软删除实例及跨组织事实隔离。列表与单资源入口复用纯事实装配；SQL 终态排除从领域状态函数推导，保留 queued、starting、running、awaiting_input、paused。

没有新增或声称索引收益；数据库查询计划与候选索引由 P2 单独评估。此结果也不构成最终 Web E2E 或真实 Provider 产品验收。
