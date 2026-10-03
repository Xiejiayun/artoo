import assert from "node:assert/strict";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { verifyZeroArtifactWorkspaceExport } from "./fixtures/zero-artifact-workspace-scenario.mjs";

/** Verify retained native evidence after teardown, never synthesize UI evidence
 * from the protocol fixture's successful API/process result. */
export function verifyNativeRetentionEvidence(parent, directory) {
  const result = parent.retention, attempt = resolve(directory);
  assert.equal(result?.passed, true, "Native retention production-record verification must pass");
  assert.deepEqual(result.counts, { tasks: 1, runs: 1, launches: 1, approvals: 1, reviews: 0, artifacts: 0, retained_worktrees: 1, live_owned_processes: 0 });
  assert.deepEqual(result.historical_recovery, { passed: true, checkpoints: ["completed", "relaunched"],
    task_id: result.task_id, run_id: result.run_id, retention_event_id: result.retention_event_id });
  assert.equal(result.workspace_branch, `artoo/run-${result.run_id}`);
  assert.ok(result.workspace_retention?.version === 1 && result.workspace_retention.outcome === "completed");
  assert.equal(result.workspace_retention.event_id, result.retention_event_id);
  assert.equal(result.workspace_retention.workspace_root, result.workspace_root);
  assert.equal(result.workspace_retention.workspace_branch, result.workspace_branch);
  const exported = parent.retained_workspace_export;
  verifyZeroArtifactWorkspaceExport({ manifest: exported,
    manifestPath: join(attempt, "retention-evidence/retained-workspace/manifest.json"), workspaceRoot: result.workspace_root,
    temporary: parent.fixture_temporary_directory, afterCleanup: true });

  const attachments = join(attempt, "ui-attachments"), manifest = JSON.parse(readFileSync(join(attachments, "manifest.json"), "utf8"));
  const entries = [];
  function collect(value) {
    if (Array.isArray(value)) for (const item of value) collect(item);
    else if (value && typeof value === "object") {
      if (value.exportedFileName) entries.push(value);
      if (value.attachments) collect(value.attachments);
    }
  }
  collect(manifest);
  const title = "Native retention exact identities and historical recovery";
  const matches = entries.filter((entry) => {
    const name = entry.suggestedHumanReadableName ?? entry.name ?? "";
    return name === title || name.startsWith(`${title}_`) || name.startsWith(`${title}.`);
  });
  assert.equal(matches.length, 1, "One actual native lifecycle/Copy attachment is required");
  const filename = matches[0].exportedFileName;
  assert.ok(typeof filename === "string" && basename(filename) === filename && filename.endsWith(".json"));
  const path = join(attachments, filename), stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 262_144);
  assert.equal(dirname(realpathSync(path)), realpathSync(attachments));
  const record = JSON.parse(readFileSync(path, "utf8"));
  for (const key of ["task_id", "run_id", "retention_event_id", "workspace_root", "workspace_branch"]) assert.equal(record[key], result[key]);
  assert.equal(record.runs, 1); assert.equal(record.approvals, 1); assert.equal(record.reviews, 0); assert.equal(record.artifacts, 0);
  assert.equal(record.cold_relaunch_completed, true);
  assert.deepEqual(record.workspace_retention_views?.map((view) => view.caption), ["Native retention exact workspace path and branch", "Native retention recovery after cold relaunch"]);
  for (const view of record.workspace_retention_views) {
    for (const key of ["task_id", "run_id", "retention_event_id", "workspace_root", "workspace_branch"]) assert.equal(view[key], result[key]);
    assert.equal(view.outcome, "completed"); assert.equal(view.path_and_branch_copied_through_ui, true);
    assert.equal(view.reporter_computer_id, result.workspace_retention.reporter_computer_id);
    assert.equal(view.reported_at, result.workspace_retention.reported_at);
  }
  return { passed: true, native_observation_path: path, exported_files: exported.files.length };
}
