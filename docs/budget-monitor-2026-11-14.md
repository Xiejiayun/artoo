# 预算监视空闲退避

P6 从 main `46c28b1` 开始，替换每秒固定定时器。默认首次扫描仍在 1 秒后；没有受支持的周期预算时，间隔按 2、4、8、16 秒增长，最多 30 秒。存在运行中的 elapsed/retry 预算时，扫描完成后按原 1 秒间隔继续。查询失败恢复短间隔并通过原错误回调报告。

初始查询额外读取 budgets 和 stop_conditions。无限预算、仅并发容量预算的目标不再开启用量事务；无效预算/停止条件数据继续进入原校验和报错路径。适用目标仍在 `enforceGoalBudget` 的事务中锁定、重读配置和状态，保留精确 elapsed 边界、幂等暂停、checkpoint、事件、组织隔离以及正在运行任务自然排空。调度准入和 terminal run 的预算检查不变。

计划接受、独立 materialize 和目标恢复仅在事务成功提交后唤醒共用 DbClient 上的监视器；失败与回滚不唤醒。请求 context 副本共享该客户端。唤醒不直接执行预算动作，只取消延迟；扫描中收到唤醒会在扫描结束后立即再查，不能重叠或丢失。stop 注销观察、清除定时器并等待当前扫描；重复 stop 不移除后来创建的观察者。

观察者属于当前进程；通过启用监视器的服务进程启动/恢复的目标由该写入进程立即检查。其他客户端或直接数据库写入由最长 30 秒的后备扫描发现；重启时仍按首次 1 秒扫描恢复。该后备时限应与部署方式一起评估，不能把内存观察者当作跨进程事件总线。

## 测量与边界

`scripts/benchmarks/budget-scan.mjs` 使用独立内存 PGlite、10,000 目标、20 running（其中 2 个 elapsed 预算），执行 ANALYZE 和两条实际扫描的 EXPLAIN ANALYZE。当前引擎为两条查询选择 `goals_project_status_idx` 的 Index Scan；它不证明所有 PostgreSQL 版本/数据分布都能有效使用该索引的第二列，也不能将其当作 status 首列索引。本项没有足够证据追加独立索引或迁移。

最终 30 次本机样本中，原扫描 p50/p95 为 0.847/1.091ms，带预算/停止条件为 1.002/1.435ms；增加字段未带来单次扫描延迟收益，本项减少调用与不适用事务。最终原始计划和样本在 `.git/opt-p6-query-plan-final/budget-scan-uacntY/report.json`，日志 `.git/opt-p6-query-plan-final.log`。早期仅附带 budgets 的报告保留在 `.git/opt-p6-query-plan-evidence/report.json`（从 artifacts 移入保留）。可用脚本参数指定新的报告父目录，不覆盖已有运行。

确定性时钟检查验证：持续空闲的前 120 秒为 7 次扫描，原固定 1 秒为 120 次；没有无限/仅容量目标的用量事务。这是调度计数验证，不是实际 CPU、远程数据库费用或休眠测量。

其他数据库活动仍存在：event publisher 在远程数据库默认每 1000ms、内存数据库默认每 200ms 查询；GoalRunner 开启时每 1500ms pump，数据库连接也有独立生命周期。本项不承诺 Scale-to-Zero。

## 验证

根 typecheck 和 server build 通过。预算/DAG 回归 6 文件、40 项通过；最后预算/停止条件预筛选版本的监视器、Goal/Plan、替换计划回归 5 文件、30 项通过，两轮存在重叠，不相加。日志：`.git/opt-p6-regression.log`、`.git/opt-p6-final-tests.log`、`.git/opt-p6-typecheck-accepted.log`、`.git/opt-p6-build-accepted.log`。最终全仓门禁和统一 E2E 仍在后续集成版本执行。

新增检查覆盖退避上限、错误恢复、跨客户端隔离、提交后唤醒、扫描中唤醒、非重叠、关闭排空和观察者重复清理；真实 PGlite 检查跨组织执法、精确期限、事务内重读及接受失败回滚。初轮新增时钟测试因每次启动都重装 fake timers 而清除了前一个计时器，已改为每个测试只安装一次；初轮类型检查补齐了新测试成员的必填字段。失败日志保留，不调整生产时限或既有断言。
