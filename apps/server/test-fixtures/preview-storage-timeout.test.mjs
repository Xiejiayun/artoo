import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, appendFileSync, constants, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { test } from "node:test";

// Run: node --test apps/server/test-fixtures/preview-storage-timeout.test.mjs
// The child deliberately fails five cases; this parent validates exact failures,
// original work/cleanup ordering, filesystem outcomes, and actual process closure.
test("preview storage cleanup survives real Vitest timeouts", async () => {
const root = process.env.ARTOO_STORAGE_HARNESS_REPO_ROOT === undefined
  ? resolve(import.meta.dirname, "../../..") : resolve(process.env.ARTOO_STORAGE_HARNESS_REPO_ROOT);
const output = process.env.ARTOO_STORAGE_HARNESS_OUTPUT === undefined
  ? mkdtempSync(join(tmpdir(), "artoo-storage-timeout-evidence-")) : resolve(process.env.ARTOO_STORAGE_HARNESS_OUTPUT);
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const inputs = ["preview-storage-timeout-child.ts", "preview-storage-timeout.vitest.config.ts", "preview-storage-timeout-reporter.mjs", "preview-storage-timeout.test.mjs",
  "../src/test-fixtures/preview-storage-scope.ts", "../src/preview-storage.test.ts"].map(file => {
  const path = resolve(import.meta.dirname, file); return { path, sha256: sha(path) };
});
const vitestPackage = JSON.parse(readFileSync(join(root, "node_modules/vitest/package.json"), "utf8"));
if (process.env.ARTOO_STORAGE_HARNESS_OUTPUT !== undefined) mkdirSync(output);
const command = [join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", join(import.meta.dirname, "preview-storage-timeout.vitest.config.ts")];
writeFileSync(join(output, "inputs.json"), JSON.stringify({ inputs, vitest: vitestPackage.version,
  node: { executable: process.execPath, version: process.version, sha256: sha(process.execPath) }, command }, null, 2) + "\n", { flag: "wx" });
const log = join(output, "child.log"); writeFileSync(log, "", { flag: "wx" });
const started = performance.now();
const child = spawn(process.execPath, command, { cwd: root, windowsHide: true,
  env: { ...process.env, FORCE_COLOR: "0", ARTOO_STORAGE_HARNESS_EVIDENCE: output }, stdio: ["ignore", "pipe", "pipe"] });
let spawned = false, exit, closure, spawnError;
child.once("spawn", () => { spawned = true; });
child.stdout.on("data", chunk => appendFileSync(log, chunk));
child.stderr.on("data", chunk => appendFileSync(log, chunk));
child.once("error", error => { spawnError = { name: error.name, message: error.message }; });
child.once("exit", (code, signal) => { exit = { code, signal, elapsedMs: performance.now() - started }; });
await new Promise(resolveClosed => child.once("close", (code, signal) => { closure = { code, signal, elapsedMs: performance.now() - started }; resolveClosed(); }));
const processEvidence = { spawned, pid: child.pid, spawnError, exit, close: closure };
writeFileSync(join(output, "process.json"), JSON.stringify(processEvidence, null, 2) + "\n", { flag: "wx" });
assert.equal(spawned, true); assert.equal(spawnError, undefined);
assert.equal(exit?.code, 1); assert.equal(exit.signal, null);
assert.equal(closure.code, 1); assert.equal(closure.signal, null);

const report = JSON.parse(readFileSync(join(output, "vitest-report.json"), "utf8"));
const runEnd = JSON.parse(readFileSync(join(output, "run-end.json"), "utf8"));
assert.equal(report.numTotalTests, 7); assert.equal(report.numFailedTests, 5); assert.equal(report.numPassedTests, 2);
assert.equal(report.numPendingTests, 0); assert.equal(report.numTodoTests, 0);
assert.equal(runEnd.modules, 1); assert.equal(runEnd.reason, "failed"); assert.deepEqual(runEnd.unhandledErrors, []);
const results = report.testResults.flatMap(module => module.assertionResults);
const names = ["timeout drains original write and close", "ordinary assertion preserves failure and cleans", "failed close confirmation retains", "drain expiry retains after late completion", "late completion sentinel", "unexpected rejected operation preserves assertion and retains", "expected rejected operation permits cleanup"];
assert.deepEqual(results.map(result => result.title), names);
const states = ["failed", "failed", "failed", "failed", "passed", "failed", "passed"];
assert.deepEqual(results.map(result => result.status), states);
assert.deepEqual(runEnd.cases.map(result => result.name), names);
assert.deepEqual(runEnd.cases.map(result => result.state), states);
// Vitest's JSON reporter chooses stack over message; timeout stacks retain
// STACK_TRACE_ERROR. Use the actual TestCase result message without rewriting it.
const failures = runEnd.cases.map(result => result.errors.map(error => error.message).join("\n"));
assert.match(failures[0], /Test timed out in 200ms/);
assert.match(failures[1], /ordinary storage assertion/);
assert.doesNotMatch(failures[1], /closure is unconfirmed|fixture retained/);
assert.match(failures[2], /controlled close confirmation failure/);
assert.match(failures[2], /Owned storage resource closure failed/);
assert.match(failures[3], /Test timed out in 200ms/);
assert.match(failures[3], /Original storage work did not confirm closure within the cleanup drain/);
assert.match(failures[5], /original expected rejection assertion/);
assert.match(failures[5], /expected rejection before acquisition/);
assert.match(failures[5], /controlled hidden close confirmation failure/);
assert.equal(runEnd.cases[5].errors.some(error => error.name === "AssertionError" && error.message.includes("original expected rejection assertion")), true);
assert.equal(failures[6], "");
assert.doesNotMatch(readFileSync(log, "utf8"), /ENOTEMPTY|Unhandled Rejection|Unhandled Error/);

const events = readFileSync(join(output, "trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const event = (name, type) => { const matches = events.filter(row => row.name === name && row.event === type); assert.equal(matches.length, 1, `${name}: ${type}`); return matches[0]; };
for (const name of [names[0], names[1], names[2], names[3], names[5], names[6]]) {
  assert.equal(event(name, "context-identity").same, true);
}
for (const name of [names[0], names[1], names[2], names[3], names[5]]) {
  assert.equal(event(name, "close-started").calls, 1);
  event(name, "native-close-confirmed"); event(name, "body-settled");
}
const order = (name, ...phases) => {
  const times = phases.map(phase => event(name, phase).at);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], `${name}: ${phases.join(" -> ")}`);
};
order(names[0], "afterEach-started", "write-done", "native-close-confirmed", "close-done", "body-settled", "afterEach-completed");
order(names[1], "native-close-confirmed", "body-settled", "afterEach-started", "afterEach-completed");
order(names[3], "afterEach-started", "afterEach-failed", "write-done", "native-close-confirmed", "close-done", "body-settled");
order(names[5], "native-close-confirmed", "body-settled", "afterEach-started", "afterEach-failed");
// Vitest expands AggregateError into its constituent errors. Check the original
// outer retention message from the real hook trace, independently of that report.
for (const name of [names[2], names[3]]) assert.match(event(name, "afterEach-failed").message, /Storage closure is unconfirmed; fixture retained:/);
assert.match(event(names[5], "afterEach-failed").message, /Storage operation or cleanup failed; fixture retained:/);
assert.match(event(names[5], "body-settled").message, /original expected rejection assertion/);
assert.equal(event(names[0], "afterEach-started").aborted, true);
assert.equal(event(names[3], "afterEach-started").aborted, true);
assert.ok(event(names[3], "afterEach-failed").at - event(names[3], "afterEach-started").at >= 25_000);
for (const name of [names[0], names[1], names[6]]) {
  assert.equal(event(name, "afterEach-completed").rootExists, false);
  assert.throws(() => accessSync(event(name, "root-created").root, constants.F_OK), { code: "ENOENT" });
}
for (const name of [names[2], names[3], names[5]]) {
  assert.equal(event(name, "afterEach-failed").rootExists, true);
  accessSync(event(name, "root-created").root, constants.F_OK);
}
assert.equal(event(names[4], "retention-confirmed").closes, 1);
for (const input of inputs) assert.equal(sha(input.path), input.sha256);
const result = { status: "pass", evidenceDirectory: output, scope: "Regression wrapper accepted 5 intentional child failures and 2 passes; this is not a passing child suite or a PGlite test",
  process: processEvidence, total: 7, intentionalFailures: 5, sentinelPasses: 1, expectedRejectionPasses: 1, unhandledErrors: 0,
  testContextIdentityMatches: 6, drainMs: event(names[3], "afterEach-failed").at - event(names[3], "afterEach-started").at,
  retained: [names[2], names[3], names[5]].map(name => event(name, "root-created").root), inputsUnchanged: true };
writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
});
