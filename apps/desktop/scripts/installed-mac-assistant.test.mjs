import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { assistantStartupReceiptPath, assistantFailureReceiptPath } from "../../../scripts/fixtures/assistant-conversation.mjs";
import { writeE2EReport } from "../../../scripts/e2e-report.mjs";
import { captureMacAssistantScreenshot, macAssistantImageNames, observeMacAssistantCleanup, observeStableMacAssistantState, readMacAssistantObservations } from "./installed-mac-assistant.mjs";
import { finalizePackagedSmokeSource } from "./packaged-e2e-smoke.mjs";

// Unit tests only: synthetic screenshots are confined to temporary failed unit
// reports. CLI probes below do not establish installed-app/worker/UI coverage.
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-mac-assistant-unit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true })); return directory;
}

test("owned observations bind receipt filenames, probe each positive PID once, and retain fail-once state", (t) => {
  const receipts_directory = temporary(t), seen = [];
  const first = { run_id: "first", pid: 101 }, second = { run_id: "second", pid: 202 }, failure = { turn_id: "second-turn", initial_run_id: "second" };
  for (const receipt of [first, second]) writeFileSync(assistantStartupReceiptPath(receipts_directory, receipt.run_id), JSON.stringify(receipt));
  writeFileSync(assistantFailureReceiptPath(receipts_directory, failure.turn_id), JSON.stringify(failure));
  const result = readMacAssistantObservations({ receipts_directory }, { probe: (pid) => { seen.push(pid); return pid === 202; } });
  assert.deepEqual(new Set(seen), new Set([101, 202])); assert.deepEqual(result.livePids, [202]);
  assert.deepEqual(result.failedOnceReceipts, [failure]); assert.equal(result.receipts.length, 2);
});

test("malformed ownership evidence is rejected before any process probe", (t) => {
  for (const receipt of [{ run_id: "first", pid: -1 }, { run_id: "first", pid: 0 }, { run_id: "first", pid: 1.5 }, { run_id: "different-run", pid: 123 }]) {
    const receipts_directory = temporary(t); let probes = 0;
    writeFileSync(assistantStartupReceiptPath(receipts_directory, "first"), JSON.stringify(receipt));
    assert.throws(() => readMacAssistantObservations({ receipts_directory }, { probe: () => { probes++; return false; } }));
    assert.equal(probes, 0);
  }
});

test("an unconfirmable PID cannot be reported as terminated", (t) => {
  const receipts_directory = temporary(t);
  writeFileSync(assistantStartupReceiptPath(receipts_directory, "first"), JSON.stringify({ run_id: "first", pid: 123 }));
  assert.throws(() => readMacAssistantObservations({ receipts_directory }, { probe: () => { throw new Error("Observation denied"); } }), /Observation denied/);
});

test("only the atomic writer's exact temporary filename shape is ignored", (t) => {
  const receipts_directory = temporary(t);
  writeFileSync(join(receipts_directory, `.assistant-receipt-${"a".repeat(32)}.tmp`), "incomplete private JSON");
  assert.deepEqual(readMacAssistantObservations({ receipts_directory }), { receipts: [], failedOnceReceipts: [], livePids: [] });
  for (const filename of [`.assistant-receipt-${"a".repeat(31)}.tmp`, `.assistant-receipt-${"B".repeat(32)}.tmp`, `.assistant-receipt-${"a".repeat(32)}.tmp.extra`, "unknown.json"]) {
    const path = join(receipts_directory, filename); writeFileSync(path, "{}");
    assert.throws(() => readMacAssistantObservations({ receipts_directory }), /Unexpected file/);
    rmSync(path);
  }
});

test("cleanup snapshots only recorded PIDs and waits for exit without losing ownership when a receipt disappears", async (t) => {
  const receipts_directory = temporary(t), path = assistantStartupReceiptPath(receipts_directory, "owned");
  writeFileSync(path, JSON.stringify({ run_id: "owned", pid: 123 }));
  let time = 0; const seen = [];
  const result = await observeMacAssistantCleanup({ receipts_directory }, {
    probe: (pid) => { seen.push(pid); rmSync(path, { force: true }); return time < 200; },
    now: () => time, pause: async (ms) => { time += ms; },
  });
  assert.equal(result.closed, true); assert.deepEqual(result.observed_pids, [123]); assert.deepEqual(result.live_pids, []);
  assert.deepEqual(seen, [123, 123, 123]); assert.equal(result.observed_ms, 200); assert.equal(result.receipt_count, 1);
});

test("cleanup reports a bounded failure when a recorded PID remains live or unconfirmable", async (t) => {
  for (const denied of [false, true]) {
    const receipts_directory = temporary(t); let time = 0;
    writeFileSync(assistantStartupReceiptPath(receipts_directory, "owned"), JSON.stringify({ run_id: "owned", pid: 123 }));
    const result = await observeMacAssistantCleanup({ receipts_directory }, { timeoutMs: 250,
      probe: () => { if (denied) throw Object.assign(new Error("private diagnostic must not leak"), { code: "EPERM" }); return true; },
      now: () => time, pause: async (ms) => { time += ms; },
    });
    assert.equal(result.closed, false); assert.equal(result.observed_ms, 250);
    assert.deepEqual(result.live_pids, denied ? null : [123]);
    if (denied) assert.equal(result.error.code, "EPERM");
    assert.equal(JSON.stringify(result).includes("private diagnostic"), false);
  }
});

test("cleanup retries a transient denied probe but requires a later confirmed exit", async (t) => {
  const receipts_directory = temporary(t); let time = 0;
  writeFileSync(assistantStartupReceiptPath(receipts_directory, "owned"), JSON.stringify({ run_id: "owned", pid: 123 }));
  const result = await observeMacAssistantCleanup({ receipts_directory }, {
    probe: () => { if (time === 0) throw Object.assign(new Error("reaping"), { code: "EPERM" }); return false; },
    now: () => time, pause: async (ms) => { time += ms; },
  });
  assert.equal(result.closed, true); assert.equal(result.samples, 2); assert.equal(result.error, undefined);
});

test("invalid or missing cleanup receipts fail without probing any process", async (t) => {
  const receipts_directory = temporary(t); let probes = 0;
  writeFileSync(assistantStartupReceiptPath(receipts_directory, "owned"), JSON.stringify({ run_id: "owned", pid: -123 }));
  for (const directory of [receipts_directory, join(receipts_directory, "missing")]) {
    const result = await observeMacAssistantCleanup({ receipts_directory: directory }, { probe: () => { probes++; return false; } });
    assert.equal(result.closed, false); assert.equal(result.error.code, "INVALID_RECEIPTS");
  }
  assert.equal(probes, 0);
});

test("an empty receipt directory explicitly reports zero recorded processes", async (t) => {
  const result = await observeMacAssistantCleanup({ receipts_directory: temporary(t) }, { probe: () => { throw new Error("must not probe"); } });
  assert.equal(result.closed, true); assert.equal(result.receipt_count, 0); assert.deepEqual(result.observed_pids, []);
});

const sourceFixture = () => ({ commit: "unit-commit", branch: "main", working_tree_dirty: true,
  tracked_diff_sha256: "a".repeat(64), untracked_source_sha256: "b".repeat(64), untracked_source_files: 1, untracked_source_complete: true });

test("unchanged complete source fingerprints retain the packaged smoke outcome", () => {
  const report = { source: sourceFixture(), result: "pass", passed: true };
  assert.equal(finalizePackagedSmokeSource(report, sourceFixture()), undefined);
  assert.equal(report.source_stable, true); assert.equal(report.passed, true);
});

test("commit, tracked and untracked drift fail closed while preserving the original failure", () => {
  for (const change of [{ commit: "another-commit" }, { tracked_diff_sha256: "c".repeat(64) }, { untracked_source_sha256: "d".repeat(64) }]) {
    const report = { source: sourceFixture(), result: "pass", passed: true, error: "Original workflow failure" };
    const finished = { ...sourceFixture(), ...change };
    assert.ok(finalizePackagedSmokeSource(report, finished) instanceof Error);
    assert.equal(report.source_stable, false); assert.equal(report.result, "fail"); assert.equal(report.passed, false);
    assert.equal(report.error, "Original workflow failure"); assert.deepEqual(report.source_at_finish, finished);
  }
});

test("matching incomplete fingerprints cannot certify stable source", () => {
  for (const change of [{ commit: null }, { tracked_diff_sha256: null }, { untracked_source_sha256: null }, { untracked_source_complete: false }]) {
    const source = { ...sourceFixture(), ...change }, report = { source, result: "pass", passed: true };
    assert.ok(finalizePackagedSmokeSource(report, { ...source }) instanceof Error);
    assert.equal(report.source_stable, false); assert.equal(report.passed, false);
  }
});

test("a failed final source boundary still permits retained HTML with earlier image evidence", (t) => {
  const directory = temporary(t), path = join(directory, "unit-image.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  writeFileSync(path, png);
  const report = { source: sourceFixture(), result: "pass", passed: true, finished_at: new Date().toISOString() };
  const error = finalizePackagedSmokeSource(report, { ...sourceFixture(), untracked_source_sha256: "c".repeat(64) });
  const htmlPath = writeE2EReport({ outputPath: join(directory, "failed-unit-report.html"), title: "Unit source-boundary failure only", report,
    screenshots: [{ path, caption: "Synthetic unit image; no installed app was run" }] });
  const html = readFileSync(htmlPath, "utf8");
  assert.ok(error instanceof Error); assert.ok(html.includes('class="status Failed"'));
  assert.ok(html.includes(`data:image/png;base64,${png.toString("base64")}`)); assert.ok(html.includes("source_at_finish"));
});

test("the stability window repeatedly checks state for at least two dispatcher periods", async () => {
  let time = 0, reads = 0;
  const result = await observeStableMacAssistantState(async () => { reads++; }, { now: () => time, pause: async (ms) => { time += ms; } });
  assert.ok(result.observed_ms >= 3100); assert.ok(reads > 2); assert.equal(result.samples, reads);
  await assert.rejects(observeStableMacAssistantState(async () => {}, { minimumMs: 100 }), /Assertion/);
});

test("a changed state fails the stability observation instead of earning elapsed-time evidence", async () => {
  let time = 0, reads = 0;
  await assert.rejects(observeStableMacAssistantState(async () => {
    if (++reads === 3) throw new Error("Unexpected redispatch");
  }, { now: () => time, pause: async (ms) => { time += ms; } }), /Unexpected redispatch/);
  assert.equal(reads, 3);
});

test("separate answer captures reject the old container path and retain the first when the follow-up capture fails", async (t) => {
  const artifactDir = temporary(t), screenshots = [], evidence = { screenshots: [] };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const options = { artifactDir, evidence, onScreenshot: (image) => screenshots.push(image) };
  assert.deepEqual(macAssistantImageNames, ["macos-assistant-waiting.png", "macos-assistant-failed.png", "macos-assistant-first-answer.png", "macos-assistant-followup.png", "macos-assistant-cancelled.png"]);
  let rejectedCapture = false;
  await assert.rejects(captureMacAssistantScreenshot({ screenshot: async () => { rejectedCapture = true; } }, {
    ...options, filename: "macos-assistant-answers.png", caption: "Disallowed former container screenshot" }));
  assert.equal(rejectedCapture, false);
  await captureMacAssistantScreenshot({ screenshot: async ({ path }) => writeFileSync(path, png) }, {
    ...options, filename: macAssistantImageNames[2], caption: "Synthetic unit first-answer image captured before failure; no installed app was run" });
  assert.equal(screenshots.length, 1, "The first answer must be published before the next capture starts");
  await assert.rejects(captureMacAssistantScreenshot({ screenshot: async () => { throw new Error("Synthetic capture failure"); } }, {
    ...options, filename: macAssistantImageNames[3], caption: "Synthetic failed follow-up unit capture" }), /Synthetic capture failure/);
  assert.equal(screenshots.length, 1); assert.deepEqual(evidence.screenshots, screenshots);
  const html = writeE2EReport({ outputPath: join(artifactDir, "failed-unit-report.html"), title: "Unit capture retention only",
    report: { passed: false, finished_at: new Date().toISOString(), scope: "Unit test; no installed app or real provider" }, screenshots });
  assert.ok(readFileSync(html, "utf8").includes(`data:image/png;base64,${png.toString("base64")}`));
});

function inlineFixture(t) {
  const directory = temporary(t), workspace = join(directory, "workspace"), receipts = join(directory, "receipts");
  mkdirSync(workspace); mkdirSync(receipts);
  const fixture = { project_id: "unit-project", room_id: "unit-room", user_id: "unit-user", agent_instance_id: "unit-agent",
    workspace_root: realpathSync(workspace), receipts_directory: receipts, requests: { first: "First unit request", second: "Second unit request", hold: "Hold unit request" } };
  const assistantConfigurationPath = join(directory, "assistant.json"); writeFileSync(assistantConfigurationPath, JSON.stringify(fixture));
  const source = readFileSync(new URL("./packaged-e2e-smoke.mjs", import.meta.url), "utf8");
  const start = source.indexOf("writeFileSync(fixtureEntry, `"), end = source.indexOf("\n`);", start) + "\n`);".length;
  assert.ok(start >= 0 && end > start);
  const program = join(directory, "installed-fixture.mjs"), desktopDir = fileURLToPath(new URL("../", import.meta.url));
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  new Function("writeFileSync", "fixtureEntry", "fixtureKey", "isMac", "pathToFileURL", "join", "desktopDir", "repoRoot", "planningConfigurationPath", "assistantConfigurationPath", "correctionConfigurationPath", "fixturePatch", source.slice(start, end))(
    writeFileSync, program, "unit-key", true, pathToFileURL, join, desktopDir, repoRoot, join(directory, "must-not-read-planning.json"), assistantConfigurationPath, join(directory, "must-not-read-correction.json"), "must-not-write-artifact");
  const history = [];
  const prepare = (mode, runId) => {
    const pack = { task: { id: "unit-task" }, project: { id: fixture.project_id }, workspace: { root: fixture.workspace_root },
      policy: { filesystem_write_scope: [fixture.workspace_root], requires_approval: ["git.push"] },
      conversation: { room_id: fixture.room_id, turn_id: `turn-${mode}`, thread_root_id: null, current_request: fixture.requests[mode], messages: history, history_truncated: false } };
    writeFileSync(join(workspace, "context_pack.md"), `# Context Pack unit\ntask: unit-task\nrun: ${runId}\n\n## Raw Payload\n${JSON.stringify(pack)}`);
  };
  const parse = (text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const run = (mode, runId) => { prepare(mode, runId); return spawnSync(process.execPath, [program], { cwd: workspace, env: { ARTOO_CODEX_PROVIDER_KEY: "unit-key" }, encoding: "utf8", timeout: 10_000 }); };
  const remember = (mode, output) => {
    const answer = parse(output).find((frame) => frame.type === "item.completed").item.text;
    history.push({ id: `request-${mode}`, role: "user", actor_id: fixture.user_id, body: fixture.requests[mode] },
      { id: `answer-${mode}`, role: "assistant", actor_id: fixture.agent_instance_id, body: answer });
    return answer;
  };
  return { fixture, workspace, program, prepare, parse, run, remember };
}

test("generated Mac CLI routes all direct modes to the shared fixture without falling into artifact or planning", async (t) => {
  const state = inlineFixture(t), first = state.run("first", "run-first");
  assert.equal(first.status, 0, first.stderr); const firstAnswer = state.remember("first", first.stdout);
  const failed = state.run("second", "run-failed"); assert.equal(failed.status, 42, failed.stderr);
  assert.deepEqual(state.parse(failed.stdout).map((frame) => frame.type), ["thread.started", "turn.failed"]);
  const retried = state.run("second", "run-retried"); assert.equal(retried.status, 0, retried.stderr);
  assert.equal(state.remember("second", retried.stdout), `Follow-up used the actual earlier answer: ${firstAnswer}`);
  state.prepare("hold", "run-held");
  const child = spawn(process.execPath, [state.program], { cwd: state.workspace, env: { ARTOO_CODEX_PROVIDER_KEY: "unit-key" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; });
  const deadline = Date.now() + 5000;
  let observation;
  while (Date.now() < deadline) {
    try { observation = readMacAssistantObservations(state.fixture); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (observation?.receipts.some((receipt) => receipt.run_id === "run-held")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(child.exitCode, null, stderr);
  assert.ok(observation);
  assert.equal(observation.receipts.length, 4); assert.equal(observation.failedOnceReceipts.length, 1); assert.deepEqual(observation.livePids, [child.pid]);
  const stillRunning = await observeMacAssistantCleanup(state.fixture, { timeoutMs: 20 });
  assert.equal(stillRunning.closed, false); assert.deepEqual(stillRunning.live_pids, [child.pid]);
  assert.equal(child.exitCode, null, "Read-only cleanup observation must not stop the live child");
  child.kill("SIGTERM"); assert.equal((await closed).signal, "SIGTERM");
  assert.deepEqual(state.parse(stdout).map((frame) => frame.type), ["thread.started"]);
  assert.deepEqual(readMacAssistantObservations(state.fixture).livePids, []);
  const stopped = await observeMacAssistantCleanup(state.fixture);
  assert.equal(stopped.closed, true); assert.equal(stopped.receipt_count, 4); assert.deepEqual(stopped.live_pids, []);
  assert.equal(existsSync(join(state.workspace, "changes.patch")), false);
  assert.equal(existsSync(join(state.workspace, "fixture-execution.json")), false);
});
