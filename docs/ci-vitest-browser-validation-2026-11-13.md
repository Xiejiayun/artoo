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
