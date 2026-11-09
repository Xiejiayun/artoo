import assert from "node:assert/strict";
import { join } from "node:path/win32";
import test from "node:test";
import { laneNames, verifyCoverage, windowsProcessFiles } from "./ci-vitest-coverage.mjs";

const commit = "a".repeat(40);
const parallelFiles = ["apps/server/src/a.test.ts", "packages/domain/src/b.test.ts"];
// Controlled reporter/discovery fixtures test coverage validation only.
function fixture() {
  return Object.fromEntries(laneNames.map((name, index) => {
    const root = `C:\\runner-${index}\\artoo`;
    const discovery = (name === "windows-process" ? windowsProcessFiles : parallelFiles).map(file => ({ file: join(root, file) }));
    const ran = name === "windows-process" ? windowsProcessFiles : [parallelFiles[index]];
    return [name, { metadata: { version: 1, lane: name, root, platform: "win32", commit }, discovery,
      report: { success: true, numFailedTests: 0, numFailedTestSuites: 0,
        testResults: ran.map(file => ({ name: join(root, file), status: "passed", assertionResults: [{ status: "passed" }] })) },
      ...(name === "windows-process" ? { fullDiscovery: [...parallelFiles, ...windowsProcessFiles].map(file => ({ file: join(root, file) })) } : {}),
    }];
  }));
}

test("actual reporter sets cover the complete inventory once across different checkout roots", () => {
  assert.deepEqual(verifyCoverage(fixture(), commit).actualFilesByLane, { "parallel-1": 1, "parallel-2": 1, "windows-process": 3 });
});

test("keeps files with deliberate platform/opt-in skips and todo cases in coverage", () => {
  const value = fixture();
  value["parallel-1"].report.testResults[0].assertionResults = [{ status: "skipped" }];
  value["parallel-2"].report.testResults[0].assertionResults = [{ status: "todo" }];
  assert.equal(verifyCoverage(value, commit).discoveredFiles, 5);
});

for (const [name, mutate, reason] of [
  ["missing lane", f => { delete f["parallel-2"]; }, /missing or unexpected lane/],
  ["wrong commit", f => { f["parallel-1"].metadata.commit = "b".repeat(40); }, /checkout commit mismatch/],
  ["wrong platform", f => { f["windows-process"].metadata.platform = "linux"; }, /requires Windows/],
  ["wrong lane", f => { f["parallel-1"].metadata.lane = "parallel-2"; }, /lane mismatch/],
  ["failed test run", f => { f["parallel-1"].report.success = false; }, /unsuccessful Vitest report/],
  ["failed case", f => { f["parallel-1"].report.numFailedTests = 1; }, /failed cases/],
  ["failed suite", f => { f["parallel-1"].report.numFailedTestSuites = 1; }, /failed suites/],
  ["unfinished file", f => { f["parallel-1"].report.testResults[0].status = "pending"; }, /unfinished or failed file/],
  ["missing case results", f => { delete f["parallel-1"].report.testResults[0].assertionResults; }, /missing case results/],
  ["pending case in a passed file and successful report", f => { f["parallel-1"].report.testResults[0].assertionResults[0].status = "pending"; }, /unfinished, failed or unknown case result/],
  ["failed case in a passed file", f => { f["parallel-1"].report.testResults[0].assertionResults[0].status = "failed"; }, /unfinished, failed or unknown case result/],
  ["unknown case state", f => { f["parallel-1"].report.testResults[0].assertionResults[0].status = "unknown"; }, /unfinished, failed or unknown case result/],
  ["duplicate report entry", f => { f["parallel-1"].report.testResults.push(f["parallel-1"].report.testResults[0]); }, /duplicate file/],
  ["wrong checkout path", f => { f["parallel-1"].report.testResults[0].name = "C:\\another\\apps\\server\\src\\a.test.ts"; }, /outside checkout/],
  ["discovery drift", f => { f["parallel-1"].discovery.pop(); }, /parallel discovery differs/],
  ["discovery overlap", f => {
    for (const name of ["parallel-1", "parallel-2"]) f[name].discovery.push({ file: join(f[name].metadata.root, windowsProcessFiles[0]) });
  }, /discovery partitions overlap/],
  ["discovery omission", f => { f["windows-process"].fullDiscovery.push({ file: join(f["windows-process"].metadata.root, "apps/server/src/missing.test.ts") }); }, /discovery partitions omit/],
  ["serial omission", f => { f["windows-process"].report.testResults.pop(); }, /serial run omitted/],
  ["shard overlap", f => { f["parallel-2"].report.testResults[0].name = join(f["parallel-2"].metadata.root, parallelFiles[0]); }, /actual Vitest shards overlap/],
  ["shard omission", f => {
    for (const name of laneNames) {
      const field = name === "windows-process" ? "fullDiscovery" : "discovery";
      f[name][field].push({ file: join(f[name].metadata.root, "apps/server/src/missing.test.ts") });
    }
  }, /actual Vitest shards omit/],
  ["serial file in shard", f => { f["parallel-1"].report.testResults.push({ name: join(f["parallel-1"].metadata.root, windowsProcessFiles[0]), status: "passed", assertionResults: [{ status: "passed" }] }); }, /actual Vitest shards omit or add/],
]) test(`rejects ${name}`, () => {
  const value = fixture(); mutate(value);
  assert.throws(() => verifyCoverage(value, commit), reason);
});
