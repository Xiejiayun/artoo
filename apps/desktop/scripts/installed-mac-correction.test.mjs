import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeE2EReport } from "../../../scripts/e2e-report.mjs";
import { assertMacCorrectionAssignment, captureMacCorrectionScreenshot, macCorrectionImageNames,
  observeStableMacCorrection, parseMacCorrectionRetention } from "./installed-mac-correction.mjs";

test("a fresh UI assignment identifies its exact run independently of old failure or array order", () => {
  const first = { id: "r1", task_id: "task", agent_instance_id: "i1", status: "completed" };
  const failed = { id: "r2", task_id: "task", agent_instance_id: "i2", status: "failed" };
  const corrected = { id: "r3", task_id: "task", agent_instance_id: "i3", status: "completed" };
  const input = { previousRunIds: ["r1", "r2"], runId: "r3", taskId: "task", instanceId: "i3",
    snapshot: { task: { id: "task" }, runs: [failed, corrected, first] } };
  assert.equal(assertMacCorrectionAssignment(input), corrected);
  assert.equal(assertMacCorrectionAssignment({ ...input, snapshot: { ...input.snapshot, runs: [first, failed, corrected] } }), corrected);
  for (const alter of [
    (value) => { value.runId = "r2"; },
    (value) => { value.instanceId = "wrong-instance"; },
    (value) => { value.snapshot.runs[1].task_id = "another-task"; },
    (value) => { value.snapshot.runs.push({ ...corrected, id: "unexpected-r4" }); },
    (value) => { value.snapshot.runs.push(corrected); },
    (value) => { value.snapshot.runs = [corrected, failed]; },
  ]) {
    const changed = structuredClone(input); alter(changed);
    assert.throws(() => assertMacCorrectionAssignment(changed));
  }
});

const recovery = { run_id: "held-run", task_id: "task", workspace_root: "/owned/held", workspace_branch: "artoo/run-held-run", outcome: "cancelled" };
const prefix = "Worktree retained for recovery: ";
test("retention output must identify the captured run, task, original worktree and actual outcome", () => {
  const line = prefix + JSON.stringify(recovery);
  assert.equal(parseMacCorrectionRetention(`ordinary process output\n${line}`, recovery), line);
  for (const patch of [{ run_id: "old-failed-run" }, { task_id: "other-task" }, { workspace_root: "/different/root" },
    { workspace_branch: "different-branch" }, { outcome: "failed" }]) {
    assert.throws(() => parseMacCorrectionRetention(prefix + JSON.stringify({ ...recovery, ...patch }), recovery));
  }
  assert.throws(() => parseMacCorrectionRetention(`${line}\n${line}`, recovery));
  assert.throws(() => parseMacCorrectionRetention(JSON.stringify({ text: line }), recovery));
  assert.throws(() => parseMacCorrectionRetention(prefix + "invalid JSON", recovery));
});

function observation(stopped = false) {
  return {
    observed_at: "2026-10-01", started_ms: 1, finished_ms: 2,
    snapshot: { task: { id: "task", status: stopped ? "cancelled" : "running" },
      runs: [{ id: "failed-run", status: "failed" }, { id: "held-run", status: stopped ? "cancelled" : "running" }],
      approvals: [{ id: "g1" }, { id: "g2" }], reviews: [{ event_id: "review", comment: "exact feedback\n" }],
      artifacts: [{ id: "a1", run_id: "r1", checksum: "sha256:original" }, { id: "a2", run_id: "r3", checksum: "sha256:corrected" }] },
    receipts: [{ run_id: "failed-run", pid: 101 }, { run_id: "held-run", pid: 102 }],
    launches: [{ run_id: "failed-run", pid: 101 }, { run_id: "held-run", pid: 102 }],
    exits: stopped ? [{ run_id: "held-run", pid: 102, signal: "SIGTERM" }] : [],
    workspaces: [{ root: "/owned/failed", exists: true, unsaved_sha256: "old-work" }, { root: "/owned/held", exists: true, unsaved_sha256: "new-work" }],
    live_pids: stopped ? [] : [102], artifact_bytes: [{ artifact_id: "a1", sha256: "original" }, { artifact_id: "a2", sha256: "corrected" }],
    cancellation: { errors: [], attempts: stopped ? [{ run_id: "held-run", status: 200, response_finished: true }] : [] },
    base: { head: "base-head", status: "", implementation_sha256: "base-bytes" },
  };
}

test("Keep running stability uses repeated unchanged reads for at least 3.1 seconds", async () => {
  let now = 0, reads = 0;
  const baseline = observation(), original = structuredClone(baseline);
  const result = await observeStableMacCorrection(async () => {
    const next = structuredClone(baseline); reads++;
    next.observed_at = `sample-${reads}`; next.started_ms = now; next.finished_ms = now + 1;
    next.snapshot.runs.reverse(); next.snapshot.approvals.reverse(); next.workspaces.reverse();
    return next;
  }, baseline, { now: () => now, pause: async (ms) => { now += ms; } });
  assert.ok(result.observed_ms >= 3100); assert.ok(result.samples > 2); assert.equal(result.samples, reads);
  assert.deepEqual(baseline, original, "Evidence comparisons must not mutate retained observations");
  for (const minimumMs of [0, 3099, Number.NaN, 60001]) await assert.rejects(observeStableMacCorrection(async () => baseline, baseline, { minimumMs }));
});

test("an intermediate cancellation, new dispatch, PID exit or file change fails the stability boundary", async () => {
  for (const change of [
    (value) => { value.cancellation.attempts.push({ run_id: "held-run", status: 200 }); },
    (value) => { value.snapshot.runs.push({ id: "unexpected", status: "running" }); },
    (value) => { value.live_pids = []; },
    (value) => { value.workspaces[1].unsaved_sha256 = "changed"; },
    (value) => { value.snapshot.reviews[0].comment = "rewritten"; },
  ]) {
    let now = 0, reads = 0; const baseline = observation();
    await assert.rejects(observeStableMacCorrection(async () => {
      const next = structuredClone(baseline); if (++reads === 3) change(next); return next;
    }, baseline, { now: () => now, pause: async (ms) => { now += ms; } }), /Correction state changed/);
    assert.equal(reads, 3);
  }
});

test("terminal stability retains exact cancellation, dead PID and recovery-byte evidence", async () => {
  let now = 0; const baseline = observation(true);
  const result = await observeStableMacCorrection(async () => structuredClone(baseline), baseline,
    { now: () => now, pause: async (ms) => { now += ms; } });
  assert.ok(result.observed_ms >= 3100);
  now = 0;
  await assert.rejects(observeStableMacCorrection(async () => ({ ...structuredClone(baseline), live_pids: [102] }), baseline,
    { now: () => now, pause: async (ms) => { now += ms; } }), /Correction state changed/);
});

test("approved captures are retained immediately if a later capture fails", async (t) => {
  // Valid 2x2 RGBA PNG generated independently with Pillow; synthetic unit data,
  // not installed-client visual evidence (also used by e2e-report.test.mjs).
  const root = mkdtempSync(join(tmpdir(), "artoo-correction-capture-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8KuTxn4GBgYGJAQoAI8UCUpBcPuMAAAAASUVORK5CYII=", "base64");
  const evidence = { screenshots: [] }, published = [];
  assert.equal(new Set(macCorrectionImageNames).size, 12);
  const snapshot = async (filename, caption) => {
    const path = join(root, filename); writeFileSync(path, png); const result = { path, caption }; published.push(result); return result;
  };
  await captureMacCorrectionScreenshot(snapshot, { filename: macCorrectionImageNames[0], caption: "Synthetic unit capture", evidence });
  assert.equal(evidence.screenshots.length, 1); assert.deepEqual(evidence.screenshots, published);
  await assert.rejects(captureMacCorrectionScreenshot(async () => { throw new Error("later capture failed"); },
    { filename: macCorrectionImageNames[1], caption: "Synthetic later image", evidence }), /later capture failed/);
  let invoked = false;
  await assert.rejects(captureMacCorrectionScreenshot(async () => { invoked = true; }, { filename: "../escape.png", caption: "Rejected", evidence }));
  assert.equal(invoked, false);
  const html = writeE2EReport({ outputPath: join(root, "failed-unit.html"), title: "Synthetic correction screenshot retention",
    report: { passed: false, scope: "Synthetic unit data, no browser or installed app", finished_at: new Date().toISOString() }, screenshots: evidence.screenshots });
  assert.ok(readFileSync(html, "utf8").includes(png.toString("base64")));
});

test("a nonexistent or invalid capture cannot be advertised as screenshot evidence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "artoo-correction-invalid-capture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const evidence = { screenshots: [] }, filename = macCorrectionImageNames[0], path = join(root, filename), caption = "Synthetic invalid image";
  await assert.rejects(captureMacCorrectionScreenshot(async () => ({ path, caption }), { filename, caption, evidence }));
  writeFileSync(path, "not a PNG");
  await assert.rejects(captureMacCorrectionScreenshot(async () => ({ path, caption }), { filename, caption, evidence }));
  assert.deepEqual(evidence.screenshots, []);
});
