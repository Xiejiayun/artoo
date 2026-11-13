# Windows Vitest 无 Playwright 浏览器缓存验证

## 范围与环境

E1 的前提是执行两个实际 parallel 分片、四文件 windows-process 分区，再检查实际 JSON reporter 的文件覆盖集合。不得通过改分区、跳过用例、缩短文件清单或放宽超时得到通过。

待验证源码为 `53b1d55486fd39dcf8e56341e046130a40be72e2`（P5 合并后的 main）。宿主为 Windows 11 Enterprise 10.0.26300 x64，正式验证使用 Node 24.22.1、npm 11.20.0、锁文件中的 Vitest 4.1.11 / Playwright 1.60.0。`npm run build:preview` 已通过；该次构建使用 shell 默认 Node 26.13.0。构建后的测试切换到与 CI 相同的 Node 大版本。

最初 Node 26 的分片未完成，识别到运行时差异后只终止该次已核实 PID 的 Vitest 进程树；保留输出，不将它计为通过。

## 方法

每一分区设置独立的 `PLAYWRIGHT_BROWSERS_PATH`，指向本次随机证据目录下从未创建的子目录。执行前后确认目录不存在，并通过 `chromium.executablePath()` 确认解析路径落在其中且文件不存在。无需删除默认缓存，也不修改系统浏览器安装。

在 Node 24 的 PowerShell 会话中，设置 `GITHUB_SHA` 为上述完整 SHA，分别执行与 CI 一致的命令（输出目录为该分区的独立目录）：

```powershell
$env:ARTOO_CI_TEST_PARTITION = 'parallel'
node scripts/ci-vitest-coverage.mjs record parallel-1 <output-directory>
npx vitest list --config vitest.ci.config.mjs --filesOnly --json=<output-directory>/discovery.json
npm test -- --config vitest.ci.config.mjs --maxWorkers=2 --shard=1/2 --reporter=default --reporter=json --outputFile.json=<output-directory>/results.json
```

第二个分片改为 `parallel-2` / `2/2`。进程分区设置 `ARTOO_CI_TEST_PARTITION=windows-process`，另外用默认配置记录 `full-discovery.json`，测试参数使用 `--maxWorkers=1 --no-file-parallelism`。三个目录依次命名为 `vitest-parallel-1`、`vitest-parallel-2`、`vitest-windows-process`，最后运行 `node scripts/ci-vitest-coverage.mjs verify <parent-directory>`。任一进程非零退出、生成浏览器目录或覆盖核验失败，均不能据此删除安装步骤。

## 当前状态

Node 24 第一分片报告 `preview-storage.test.ts` 四项中的第一项失败（用例耗时 65.375 秒）。随后停止这轮已失败的实验，确认其 Vitest 进程退出；未手动删除临时夹具。该轮没有完整 JSON reporter、未执行第二分片和进程分区、未运行覆盖聚合，不能记为通过。失败类型仍需聚焦复核，不把耗时本身当作根因证明。尚未删除 workflow 安装步骤。

该轮证据父目录为 `.git/opt-e1-cold-e1d3283f51ac4567a012f7d529f29667`，总日志为 `.git/opt-e1-cold-node24-run.log`。校验器自身 23 项拒绝/成功回归通过（`.git/opt-e1-coverage-fixtures.log`），这不能替代实际分片报告。后续须针对最终源码重新执行完整分区及覆盖核验。

即使后续全部通过，本项也只能证明指定版本的 Vitest 分区在指定 Windows 环境不需要 Playwright 管理的 Chromium 缓存。现有平台/显式 opt-in 跳过条件保持，不声称每项用例均实际执行；不代表真实浏览器 E2E、原生应用或 live Provider 验收通过。未测量 CI 安装节省的时间或流量，远程 CI 状态单独记录。

## 恢复链聚焦复核

原四案例在 Node 24、单 worker 下独立复跑全部通过（`.git/opt-e1-storage-baseline.log` / `.json`），第一条恢复长链报告 60,530ms，包含报告口径的清理时间。单次通过不能解释完整分片中的失败类型，也不能证明完整分片已经恢复。

检查恢复顺序发现：数据库归档通过校验后，原实现先创建并关闭恢复数据库，才核验附件。最后一个附件损坏时，这次数据库启动无法产生可发布结果。现在保留数据库归档的优先校验，将附件流式复制及校验移到数据库创建前；有效附件仍只复制一次，数据库健康检查、禁止覆盖、校验和及最终原子 rename 均保留。

真实多附件回归在四个约 8MB 文件的最后一个损坏后，断言不打开数据库。旧实现精确失败为 `expected 1 to be +0`（`.git/opt-storage-preflight-before.log`）；调整后与原四案例一同运行，2 文件、5 项全部通过（`.git/opt-storage-preflight-after.log`）。根 typecheck 和 server build 通过，未放宽测试时限或减少断言。这证明避免了一次无效数据库启动，未据此宣称完整分片失败已解决或量化恢复耗时改善。

额外执行超时清理父 harness，通过核验子进程故意 5 失败、2 通过，实际 exit/close 均为 1，原输入不变，安全删除或保留目录及 25 秒 drain 行为符合预期。父 harness 本身 1 项通过，不能称为子套件通过，也不替代上述普通四案例。证据目录：`C:/Users/jiaxie/AppData/Local/Temp/artoo-storage-timeout-evidence-pQql6P`；日志：`.git/opt-storage-preflight-timeout.log`。保留该证据与未确认可删除的夹具。

## 预检修复合并后的完整第一分片

恢复预检经 PR #68 合并后，冻结 `a455704e74b6da27b9e5e86fec3ada48446b0979` 再次执行。CIM 进程记录确认实际 Vitest worker 使用 Node 24.22.1；本轮证据目录为 `.git/opt-e1-cold-65318cb900e447ca822f6461f73fc40c`，总日志为 `.git/opt-e1-cold-after-preflight.log`。每 lane 使用独立、原本不存在的浏览器缓存路径，第一分片执行前后均确认目录及解析的 Chromium executable 不存在。

第一分片完整运行 2,988.43 秒并实际退出 1。JSON reporter 记录 296 文件（292 通过、1 失败、3 跳过），4,409 用例（4,385 通过、1 失败、23 跳过）。唯一失败是 `server-entry.test.ts` 的开发入口启动、优雅关闭并直接重开数据库案例，错误为 `Server did not emit readiness before its deadline`，来自内部 30 秒 readiness 期限。普通存储四案例及大附件预检回归均通过。终端 footer 受到 PowerShell/npm 包装输出污染，以上结论来自完整 `vitest-parallel-1/results.json`。

不改源码、断言或时限，直接用绝对 Node 24 路径聚焦复核 `server-entry.test.ts`，仍为 1 失败、1 通过，错误相同，实际退出 1（`.git/opt-e1-server-entry-recheck.log` / `.json`）。当前证据尚不能区分开发入口首次启动还是直接入口重开超时，也不能证明内部变慢的根因。

脚本在第一分片失败后停止，第二分片、windows-process 分区和覆盖聚合未执行。安装步骤保持。完整冷缓存验证推迟到后续集成源码；仍须先解决 readiness 失败，再重新执行全部实际分区和覆盖核验。聚焦复核不能替代失败的完整运行。

## 2026-11-14 启动诊断与 CI 隔离候选

从 C5 合并后的 `d46efae2be7ca48cb598329b9c43025e5cdf538b` 开始，入口失败现在记录具体入口、已过时间、最近 stdout/stderr 和实际 exit/close 状态。原断言、30 秒 readiness、90 秒完整案例及清理规则保持。聚焦复核仍为 1 失败/1 通过，明确失败发生在 `dev-server.mjs` 首次启动，30 秒时无输出且进程存活；日志 `.git/opt-e1-entry-diagnostics.log` / `.json`。

一个只添加委托计时的真实编译模块/持久化启动采样为 34.669 秒到监听：导入 15.054 秒、数据库创建约 9 秒、迁移约 9.1 秒，最后确认实际关闭并安全删临时根（`.git/opt-e1-startup-profile.log`）。它是单次诊断，不证明全部超时同因。曾尝试路由加载与数据库初始化并行，采样仍为 33.078 秒；四文件回归 21 通过/2 超时（入口和进程内配置启动），原断言/期限未改。该尝试及仅针对它的控制测试已撤回，main.ts 恢复基线字节；失败证据 `.git/opt-e1-startup-tests.*` 和 profile-overlap 日志保留。继续测量迁移执行，不把未稳定的尝试记为修复。

CI 候选为两个 parallel 分片和 windows-process 各设置独立、原本不存在的 Playwright 路径，并由 [缓存观察器](../scripts/gates/ci-vitest-browser-cache.mjs)在实际测试前后核对缓存、解析的 Chromium executable 均不存在，输出绑定 commit/lane/Node 的 JSON。观察器不创建、删除或替换浏览器缓存；现有 Chromium 安装暂时放到另一个路径保留。实际 Node 24 / Windows CLI 的前后正向及已有目录、路径变化、缺少前记录、重复记录、提交不匹配共 5 个拒绝场景通过（`.git/opt-e1-cache-probe.log`）；这只是观察器验证，没有执行完整分区。

后续须取得该候选的三个完整 lane、实际 JSON 文件覆盖聚合及前后缓存记录，全部通过后才删除两个 parallel 安装步骤。shared-checks 与实际原生/桌面浏览器安装继续保留。当前尚未完成该轮完整验证，也没有删除安装步骤。

## 2026-11-14 完整 Windows CI 证据与安装移除

[PR #106](https://github.com/Xiejiayun/artoo/pull/106) 的 [run 43515163808](https://github.com/Xiejiayun/artoo/actions/runs/43515163808) 已完成三个 Vitest lane。PR head 为 `119db1281fbaad338579f41b56c904722f6d5e1b`，实际 checkout 为 `05622d4b4fb3473cbb9ec412611abe538ba70a67`；GitHub Git API 与本地 Git 均确认它和 main 合并 `a1c4bf205af4720e43ea3fa42a41fd3b6e3d268c` 的 tree 相同：`59d599c09ea30a152262420111ced19676ab98ae`。各 lane 为 Windows、Node 24.22.2。

| lane | 实际 reporter 文件数 | 通过用例 | 失败 | 既有条件跳过 |
| --- | ---: | ---: | ---: | ---: |
| parallel-1 | 303 | 4,500 | 0 | 23 |
| parallel-2 | 303 | 4,250 | 0 | 67 |
| windows-process | 4 | 88 | 0 | 0 |
| 合计 | 610 | 8,838 | 0 | 90 |

实际下载三份 artifacts 后，以原 checkout SHA 执行 `node scripts/ci-vitest-coverage.mjs verify .git/opt-e1-remote-43515163808`，核对完整发现集合、三个实际 JSON 文件集合、终态用例、零遗漏及零重叠，通过并生成 `coverage.json`。文件数来自 `testResults.length`，没有将 Vitest 的嵌套 suite 数当作文件数。每 lane 的 `browser-cache-before.json` / `browser-cache-after.json` 均绑定同一提交、lane、Node 与独立路径，并确认缓存目录及解析的 Chromium executable 在测试前后不存在；机器复核汇总为该目录的 `verified-evidence.json`。

这证明上述版本的全部 Vitest 分区在保留原平台/opt-in 条件的情况下不需要安装的 Chromium。现在从 `shared-vitest` 矩阵删除 installer step（实际对应两个 parallel job）；测试命令、分区、断言、时限、条件跳过和覆盖聚合保持，缓存观察器继续防止依赖回流。shared-checks、iOS、Mac 和 Windows desktop 的真实浏览器安装保持。未测量这项删除对 CI 总耗时或流量的影响。

该旧 run 的 shared-checks 曾有三个 Web 失败，shared 聚合因此失败；不能称整个 run 通过。随后 [PR #107](https://github.com/Xiejiayun/artoo/pull/107) 修复 Goal 链接刷新项目归属并合并为 `e5a4915d19095413175c30fa2b34af43d45073c5`。该改动的新 jsdom Goal-link 文件在实现 `560ba3baf9a6333ec9c5f51380c34334c0199976` 下独立空缓存执行 9 项通过，前后缓存及 executable 不存在（`.git/opt-goal-link-cold{,-results}.json`）；已有 API client 测试扩展复用 fetch fixture，未增加浏览器依赖。聚焦真实 Chromium 8 项通过，包含原三项失败。不同版本和范围的证据分别保留；这些补充不将旧分区结果改称最终 main 全量验证。安装移除后的最终四门禁仍须独立执行。
