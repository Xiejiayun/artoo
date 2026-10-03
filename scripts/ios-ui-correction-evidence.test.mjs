import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyNativeCorrectionWorkspaceEvidence } from "./ios-ui-correction-evidence.mjs";

// Synthetic report-validator bytes only; these are not native or process evidence.
function correctionExportFixture(directory) {
  const evidenceDirectory = join(directory, "correction-evidence", "retained-workspaces");
  const correction = { passed: true, counts: { runs: 4, launches: 4, approvals: 4, reviews: 2, artifacts: 2, retained_worktrees: 4, live_owned_processes: 0 },
    attempts: ["initial", "failed", "corrected", "hold"].map((mode, index) => ({ slot: index + 1, mode,
      run_id: `run_fixture_${index + 1}`, workspace_root: join(directory, `original-work-${index + 1}`),
      retention_event_id: `event_retained_${index + 1}`, retained: true })) };
  const exported = { scope: "Synthetic unit fixture only", files: [] };
  for (const attempt of correction.attempts) {
    const target = join(evidenceDirectory, `slot-${attempt.slot}`); mkdirSync(target, { recursive: true });
    for (const name of ["implementation.txt", "unsaved.txt", "ignored.bin", "context_pack.md", ...([1, 3].includes(attempt.slot) ? ["changes.patch"] : [])]) {
      const bytes = Buffer.from(`unit fixture: ${attempt.run_id} / ${name}\n\0`), hash = createHash("sha256").update(bytes).digest("hex");
      const copy = join(target, name); writeFileSync(copy, bytes);
      exported.files.push({ slot: attempt.slot, run_id: attempt.run_id, source: join(attempt.workspace_root, name), copy, bytes: bytes.length, sha256: hash });
      if (name === "context_pack.md") attempt.context_sha256 = hash;
      if (name === "ignored.bin") { attempt.ignored_sha256 = hash; attempt.ignored_size = bytes.length; }
      if (name === "changes.patch") attempt.artifact_sha256 = hash;
    }
    attempt.artifact_sha256 ??= null;
  }
  writeFileSync(join(evidenceDirectory, "manifest.json"), JSON.stringify(exported));
  return { correction, exported, evidenceDirectory };
}

function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-native-retention-report-"));
  try { run(correctionExportFixture(directory)); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("native correction requires all four retained workspaces and all eighteen immutable exported files", () => {
  withFixture(({ correction, exported, evidenceDirectory }) => {
    assert.equal(verifyNativeCorrectionWorkspaceEvidence(correction, exported, evidenceDirectory), true);
    assert.equal(exported.files.length, 18);
  });
});

for (const [name, mutate] of [
  ["legacy two-worktree result", (f) => { f.correction.counts.retained_worktrees = 2; }],
  ["failed production verifier", (f) => { f.correction.passed = false; }],
  ["unretained completed run", (f) => { f.correction.attempts[0].retained = false; }],
  ["duplicate retention event", (f) => { f.correction.attempts[2].retention_event_id = f.correction.attempts[0].retention_event_id; }],
  ["missing completed-work file", (f) => { f.exported.files.splice(0, 1); }],
  ["missing ignored bytes", (f) => { f.exported.files = f.exported.files.filter((file) => !file.copy.endsWith("ignored.bin")); }],
  ["wrong originating run", (f) => { f.exported.files[0].run_id = f.correction.attempts[2].run_id; }],
  ["wrong source workspace", (f) => { f.exported.files[0].source = join(f.correction.attempts[2].workspace_root, "implementation.txt"); }],
  ["duplicate exported copy", (f) => { f.exported.files[1] = { ...f.exported.files[0] }; }],
  ["wrong context identity", (f) => { f.correction.attempts[0].context_sha256 = "a".repeat(64); }],
  ["wrong ignored-file identity", (f) => { f.correction.attempts[0].ignored_sha256 = "b".repeat(64); }],
  ["wrong completed artifact identity", (f) => { f.correction.attempts[0].artifact_sha256 = "c".repeat(64); }],
  ["removed export manifest", (f) => { rmSync(join(f.evidenceDirectory, "manifest.json")); }],
  ["removed exported file", (f) => { rmSync(f.exported.files[0].copy); }],
  ["altered exported bytes", (f) => { writeFileSync(f.exported.files[0].copy, "changed"); }],
  ["directory instead of file", (f) => { const p = f.exported.files[0].copy; rmSync(p); mkdirSync(p); }],
]) test(`native correction rejects ${name}`, () => {
  withFixture((fixture) => { mutate(fixture); assert.throws(() => verifyNativeCorrectionWorkspaceEvidence(fixture.correction, fixture.exported, fixture.evidenceDirectory)); });
});
