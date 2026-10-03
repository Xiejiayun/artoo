// Synthetic report-validator files only. Never client, process or retention evidence.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function nativeRetentionReportFixture(directory, parent = { passed: true }) {
  const temporary = join(directory, "removed-owned-fixture"), workspaceRoot = join(temporary, "worktree");
  const result = { passed: true, task_id: "task_fixture", run_id: "run_fixture", retention_event_id: "retention_fixture",
    workspace_root: workspaceRoot, workspace_branch: "artoo/run-run_fixture",
    counts: { tasks: 1, runs: 1, launches: 1, approvals: 1, reviews: 0, artifacts: 0, retained_worktrees: 1, live_owned_processes: 0 } };
  result.workspace_retention = { version: 1, event_id: result.retention_event_id, workspace_root: workspaceRoot,
    workspace_branch: result.workspace_branch, outcome: "completed", reporter_computer_id: "computer_fixture", reported_at: "2026-10-01T00:00:00.000Z", position: 2, sequence: 2 };
  result.historical_recovery = { passed: true, checkpoints: ["completed", "relaunched"], task_id: result.task_id, run_id: result.run_id, retention_event_id: result.retention_event_id };
  const target = join(directory, "retention-evidence/retained-workspace"); mkdirSync(target, { recursive: true });
  const manifest = { scope: "Synthetic unit bytes only", files: [] };
  for (const name of ["implementation.txt", "unuploaded.txt", "ignored.bin", "context_pack.md"]) {
    const bytes = Buffer.from(`unit-only ${name}\n\0`), copied = join(target, name); writeFileSync(copied, bytes);
    manifest.files.push({ source: join(workspaceRoot, name), copied, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest));
  parent.retention = result; parent.retained_workspace_export = manifest; parent.fixture_temporary_directory = temporary;
  const identity = { task_id: result.task_id, run_id: result.run_id, retention_event_id: result.retention_event_id,
    workspace_root: workspaceRoot, workspace_branch: result.workspace_branch };
  const record = { ...identity, runs: 1, approvals: 1, reviews: 0, artifacts: 0, cold_relaunch_completed: true,
    workspace_retention_views: ["Native retention exact workspace path and branch", "Native retention recovery after cold relaunch"].map((caption) => ({ ...identity, caption,
      outcome: "completed", path_and_branch_copied_through_ui: true, reporter_computer_id: result.workspace_retention.reporter_computer_id, reported_at: result.workspace_retention.reported_at })) };
  const attachments = join(directory, "ui-attachments"); mkdirSync(attachments, { recursive: true });
  const manifestPath = join(attachments, "manifest.json"), entries = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
  entries.push({ name: "Native retention exact identities and historical recovery", exportedFileName: "retention-observation.json" });
  writeFileSync(manifestPath, JSON.stringify(entries));
  const recordPath = join(attachments, "retention-observation.json"), saveRecord = () => writeFileSync(recordPath, JSON.stringify(record)); saveRecord();
  return { parent, record, recordPath, saveRecord, target };
}
