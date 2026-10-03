import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyNativeRetentionEvidence } from "./ios-ui-retention-evidence.mjs";
import { nativeRetentionReportFixture } from "./fixtures/native-retention-report-test-fixture.mjs";

function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-native-zero-report-"));
  try { run({ directory, ...nativeRetentionReportFixture(directory) }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
test("native zero-artifact acceptance binds real-UI attachment and four retained copies after cleanup", () => {
  withFixture(({ parent, directory }) => assert.deepEqual(verifyNativeRetentionEvidence(parent, directory), {
    passed: true, native_observation_path: join(directory, "ui-attachments/retention-observation.json"), exported_files: 4 }));
});
for (const [name, mutate] of [
  ["an uploaded artifact", (f) => { f.parent.retention.counts.artifacts = 1; }],
  ["an extra execution", (f) => { f.parent.retention.counts.runs = 2; }],
  ["unconfirmed cold recovery", (f) => { f.parent.retention.historical_recovery.passed = false; }],
  ["missing typed retention", (f) => { delete f.parent.retention.workspace_retention; }],
  ["wrong run branch", (f) => { f.parent.retention.workspace_branch = "artoo/run-other"; }],
  ["missing native attachment", (f) => { rmSync(f.recordPath); }],
  ["wrong native run identity", (f) => { f.record.run_id = "wrong"; f.saveRecord(); }],
  ["unperformed native cold relaunch", (f) => { f.record.cold_relaunch_completed = false; f.saveRecord(); }],
  ["Copy only before relaunch", (f) => { f.record.workspace_retention_views[1].path_and_branch_copied_through_ui = false; f.saveRecord(); }],
  ["wrong copied root", (f) => { f.record.workspace_retention_views[0].workspace_root += "-wrong"; f.saveRecord(); }],
  ["changed retention timestamp", (f) => { f.record.workspace_retention_views[1].reported_at = "2026-10-02T00:00:00Z"; f.saveRecord(); }],
  ["missing ignored file", (f) => { rmSync(join(f.target, "ignored.bin")); }],
  ["corrupted unuploaded bytes", (f) => { writeFileSync(join(f.target, "unuploaded.txt"), "corrupt"); }],
  ["fixture not removed", (f) => { mkdirSync(f.parent.fixture_temporary_directory); }],
  ["duplicate native observation", (f) => { const p = join(f.directory, "ui-attachments/manifest.json"); const m = JSON.parse(readFileSync(p, "utf8")); m.push(m[0]); writeFileSync(p, JSON.stringify(m)); }],
]) test(`native zero-artifact evidence rejects ${name}`, () => {
  withFixture((fixture) => { mutate(fixture); assert.throws(() => verifyNativeRetentionEvidence(fixture.parent, fixture.directory)); });
});
