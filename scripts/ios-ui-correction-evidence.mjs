import assert from "node:assert/strict";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { CORRECTION_IGNORED_FILE, correctionHash, correctionModes } from "./fixtures/execution-correction.mjs";

/** Verify the correction attempt's retained copies after fixture cleanup.
 * This supplements the production verifier; synthetic unit inputs are not UI evidence. */
export function verifyNativeCorrectionWorkspaceEvidence(correction, exported, evidenceDirectory) {
  assert.equal(correction?.passed, true, "Correction production verification must pass");
  assert.deepEqual(correction.counts, { runs: 4, launches: 4, approvals: 4, reviews: 2, artifacts: 2,
    retained_worktrees: 4, live_owned_processes: 0 }, "All four completed/failed/cancelled workspaces must be retained");
  assert.ok(Array.isArray(correction.attempts) && correction.attempts.length === 4);
  assert.ok(isAbsolute(evidenceDirectory));
  assert.deepEqual(JSON.parse(readFileSync(join(evidenceDirectory, "manifest.json"), "utf8")), exported,
    "The original immutable export manifest must agree with the native report");
  assert.ok(Array.isArray(exported?.files) && exported.files.length === 18, "All eighteen original workspace files must be exported");
  assert.equal(new Set(correction.attempts.map((attempt) => attempt.run_id)).size, 4);
  assert.equal(new Set(correction.attempts.map((attempt) => attempt.retention_event_id)).size, 4);
  assert.equal(new Set(exported.files.map((file) => file.copy)).size, 18);
  for (const [index, mode] of correctionModes.entries()) {
    const slot = index + 1, attempts = correction.attempts.filter((attempt) => attempt.slot === slot);
    assert.equal(attempts.length, 1);
    const attempt = attempts[0];
    assert.ok(attempt.mode === mode && attempt.retained === true && typeof attempt.run_id === "string" && attempt.run_id.length > 0
      && typeof attempt.retention_event_id === "string" && attempt.retention_event_id.length > 0 && isAbsolute(attempt.workspace_root),
    "Each exact run must retain its typed report and original workspace identity");
    const names = ["implementation.txt", "unsaved.txt", CORRECTION_IGNORED_FILE, "context_pack.md",
      ...([1, 3].includes(slot) ? ["changes.patch"] : [])];
    const files = exported.files.filter((file) => file.slot === slot);
    assert.equal(files.length, names.length, "Each workspace must retain tracked, untracked, ignored and context bytes");
    for (const name of names) {
      const copy = join(evidenceDirectory, `slot-${slot}`, name), matches = files.filter((file) => file.copy === copy);
      assert.equal(matches.length, 1, "Every expected export must have one exact attempt-owned path");
      const file = matches[0];
      assert.equal(file.run_id, attempt.run_id); assert.equal(file.source, join(attempt.workspace_root, name));
      assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0 && /^[a-f0-9]{64}$/.test(file.sha256));
      const stat = lstatSync(copy);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size === file.bytes);
      assert.equal(realpathSync(dirname(copy)), join(realpathSync(evidenceDirectory), `slot-${slot}`));
      assert.equal(correctionHash(readFileSync(copy)), file.sha256, "Retained bytes must still match the immutable export hash");
      if (name === "context_pack.md") assert.equal(file.sha256, attempt.context_sha256);
      if (name === CORRECTION_IGNORED_FILE) {
        assert.equal(file.sha256, attempt.ignored_sha256); assert.equal(file.bytes, attempt.ignored_size);
      }
      if (name === "changes.patch") assert.equal(file.sha256, attempt.artifact_sha256);
    }
  }
  return true;
}
