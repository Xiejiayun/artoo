import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const windowsProcessFiles = [
  "apps/artood/src/owned/windows-browser-exit.test.ts",
  "apps/artood/src/owned/windows-browser-observer-request.test.ts",
];
export const laneNames = ["parallel-1", "parallel-2", "windows-process"];

function fileSet(paths, root, label) {
  assert.ok(Array.isArray(paths) && paths.length > 0, `${label}: missing file inventory`);
  assert.ok(typeof root === "string" && win32.isAbsolute(root), `${label}: missing Windows checkout root`);
  const files = paths.map(path => {
    assert.ok(typeof path === "string" && win32.isAbsolute(path), `${label}: nonabsolute test path`);
    const relative = win32.relative(root, path).replaceAll("\\", "/");
    assert.match(relative, /^(apps|packages)\/.+\.test\.tsx?$/, `${label}: test outside checkout inventory`);
    assert.ok(!relative.split("/").includes(".."), `${label}: test outside checkout`);
    return relative;
  }).sort();
  assert.equal(new Set(files.map(file => file.toLowerCase())).size, files.length, `${label}: duplicate file`);
  return files;
}

function discoveryFiles(discovery, root, label) {
  assert.ok(Array.isArray(discovery), `${label}: missing discovery`);
  assert.ok(discovery.every(file => file && !file.projectName), `${label}: unexpected named project`);
  return fileSet(discovery.map(file => file.file), root, label);
}

function reportedFiles(report, root, label) {
  assert.equal(report?.success, true, `${label}: unsuccessful Vitest report`);
  assert.equal(report.numFailedTests, 0, `${label}: failed cases`);
  assert.equal(report.numFailedTestSuites, 0, `${label}: failed suites`);
  assert.ok(Array.isArray(report.testResults), `${label}: missing actual test results`);
  assert.ok(report.testResults.every(file => file?.status === "passed"), `${label}: unfinished or failed file`);
  // Vitest can mark a file passed while a queued/running case is still pending.
  // Preserve deliberate platform/opt-in skips but require terminal case states.
  for (const file of report.testResults) {
    assert.ok(Array.isArray(file.assertionResults), `${label}: missing case results`);
    assert.ok(file.assertionResults.every(result => ["passed", "skipped", "todo"].includes(result?.status)),
      `${label}: unfinished, failed or unknown case result`);
  }
  return fileSet(report.testResults.map(file => file.name), root, label);
}

export function verifyCoverage(lanes, commit) {
  assert.match(commit ?? "", /^[a-f0-9]{40}$/, "missing immutable checkout commit");
  assert.deepEqual(Object.keys(lanes).sort(), [...laneNames].sort(), "missing or unexpected lane");
  const inventories = {}, actual = {};
  for (const name of laneNames) {
    const lane = lanes[name];
    assert.equal(lane.metadata?.version, 1, `${name}: unsupported metadata`);
    assert.equal(lane.metadata.lane, name, `${name}: lane mismatch`);
    assert.equal(lane.metadata.commit, commit, `${name}: checkout commit mismatch`);
    assert.equal(lane.metadata.platform, "win32", `${name}: requires Windows`);
    inventories[name] = discoveryFiles(lane.discovery, lane.metadata.root, `${name} discovery`);
    actual[name] = reportedFiles(lane.report, lane.metadata.root, `${name} results`);
  }
  const serial = lanes["windows-process"];
  const full = discoveryFiles(serial.fullDiscovery, serial.metadata.root, "full discovery");
  const fixed = [...windowsProcessFiles].sort();
  assert.deepEqual(inventories["windows-process"], fixed, "serial discovery must contain exactly the protected files");
  assert.deepEqual(inventories["parallel-1"], inventories["parallel-2"], "parallel discovery differs between shards");
  const planned = [...inventories["parallel-1"], ...fixed].sort();
  assert.equal(new Set(planned).size, planned.length, "discovery partitions overlap");
  assert.deepEqual(planned, full, "discovery partitions omit or add files");
  assert.deepEqual(actual["windows-process"], fixed, "serial run omitted or added files");
  const parallel = [...actual["parallel-1"], ...actual["parallel-2"]].sort();
  assert.equal(new Set(parallel).size, parallel.length, "actual Vitest shards overlap");
  assert.deepEqual(parallel, inventories["parallel-1"], "actual Vitest shards omit or add files");
  return { version: 1, commit, passed: true, discoveredFiles: full.length,
    actualFilesByLane: Object.fromEntries(laneNames.map(name => [name, actual[name].length])),
    scope: "Actual reporter file coverage, including cases with their existing platform/opt-in skips; not proof that every case executed." };
}

function main(args) {
  if (args[0] === "record" && args.length === 3 && laneNames.includes(args[1])) {
    assert.equal(process.platform, "win32", "CI Vitest lanes require Windows");
    assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/, "missing checkout commit");
    mkdirSync(args[2], { recursive: true });
    writeFileSync(resolve(args[2], "metadata.json"), JSON.stringify({ version: 1, lane: args[1],
      root: process.cwd(), platform: process.platform, commit: process.env.GITHUB_SHA }, null, 2) + "\n", { flag: "wx" });
  } else if (args[0] === "verify" && args.length === 2) {
    const read = (lane, file) => JSON.parse(readFileSync(resolve(args[1], `vitest-${lane}`, file), "utf8"));
    const lanes = Object.fromEntries(laneNames.map(lane => [lane, {
      metadata: read(lane, "metadata.json"), discovery: read(lane, "discovery.json"), report: read(lane, "results.json"),
      ...(lane === "windows-process" ? { fullDiscovery: read(lane, "full-discovery.json") } : {}),
    }]));
    const result = verifyCoverage(lanes, process.env.GITHUB_SHA);
    writeFileSync(resolve(args[1], "coverage.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify(result, null, 2));
  } else throw new Error("Usage: ci-vitest-coverage.mjs record <lane> <output> | verify <download-directory>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
