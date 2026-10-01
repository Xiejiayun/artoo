// Deterministic CLI for ordinary task correction. It consumes the actual
// production context, writes real files and never calls an API or changes a run.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, linkSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const correctionHash = (value) => createHash("sha256").update(value).digest("hex");
export const CORRECTION_FAILURE_EXIT = 23;
export const CORRECTION_HOLD_TIMEOUT_EXIT = 24;
export const correctionModes = ["initial", "failed", "corrected", "hold"];
export const correctionReceiptPath = (directory, runId) => join(directory, `run-${correctionHash(runId)}.json`);
export const correctionContextPath = (directory, runId) => join(directory, `context-${correctionHash(runId)}.md`);
export const correctionExitPath = (directory, runId) => join(directory, `exit-${correctionHash(runId)}.json`);
export const correctionReportPath = (directory, runId) => join(directory, `report-${correctionHash(runId)}.patch`);

function publishExclusive(path, bytes) {
  const temporary = join(dirname(path), `.correction-${randomBytes(16).toString("hex")}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, "wx", 0o600); created = true;
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    linkSync(temporary, path);
  } finally { if (created) rmSync(temporary, { force: true }); }
}
const publishJSON = (path, value) => publishExclusive(path, JSON.stringify(value));

/** Ordinary correction reports are valid patches against the one-line fixture
 * base. Their added content is entirely derived from the real task/context. */
export function correctionImplementation(pack, runId, mode) {
  const entries = pack.review_feedback?.entries ?? [];
  return ["Execution correction evidence", `task: ${pack.task.id}`, `run: ${runId}`, `stage: ${mode}`,
    `context feedback count: ${entries.length}`,
    ...entries.flatMap((entry) => [
      `feedback event: ${entry.event_id}`, `feedback actor: ${entry.actor.type}:${entry.actor.id}`,
      `feedback comment: ${JSON.stringify(entry.comment)}`,
      `feedback comment sha256: ${correctionHash(entry.comment)}`,
    ]), ""].join("\n");
}

export function correctionPatch(original, implementation) {
  assert.ok(original.endsWith("\n") && implementation.endsWith("\n"));
  const before = original.slice(0, -1).split("\n"), after = implementation.slice(0, -1).split("\n");
  return ["diff --git a/implementation.txt b/implementation.txt", "--- a/implementation.txt", "+++ b/implementation.txt",
    `@@ -1,${before.length} +1,${after.length} @@`, ...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`), ""].join("\n");
}

function readExecution(contextPath, configurationPath) {
  const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
  assert.ok(isAbsolute(configuration.receipts_directory));
  const directory = realpathSync(configuration.receipts_directory);
  assert.ok(Array.isArray(configuration.workspaces) && configuration.workspaces.length === 4);
  assert.equal(new Set(configuration.workspaces.map((item) => item.root)).size, 4);
  const context = readFileSync(contextPath), text = context.toString("utf8"), marker = "## Raw Payload\n";
  const header = text.split("\n\n", 1)[0];
  const ids = (name) => [...header.matchAll(new RegExp(`^${name}: (.+)$`, "gm"))].map((match) => match[1]);
  const runIds = ids("run"), taskIds = ids("task");
  const workspace = realpathSync(process.cwd());
  const index = configuration.workspaces.findIndex((item) => resolve(item.root) === workspace);
  // Count actual invocations before substantive validation or duplicate-run
  // rejection. A second process cannot hide behind an existing run receipt.
  publishJSON(join(directory, `launch-${process.pid}-${randomBytes(8).toString("hex")}.json`), {
    pid: process.pid, run_id: runIds.length === 1 ? runIds[0] : null,
    task_id: taskIds.length === 1 ? taskIds[0] : null, workspace_root: workspace,
    slot: index + 1, started_at: new Date().toISOString(),
  });
  assert.ok(text.includes(marker), "The real process adapter must provide its raw payload");
  const pack = JSON.parse(text.slice(text.indexOf(marker) + marker.length));
  assert.equal(runIds.length, 1); assert.equal(taskIds.length, 1);
  const runId = runIds[0]; assert.ok(runId.trim()); assert.equal(taskIds[0], pack.task.id);
  assert.ok(index >= 0, "Only an explicitly configured owned workspace can run this fixture");
  const slot = configuration.workspaces[index], mode = correctionModes[index];
  assert.equal(slot.mode, mode); assert.ok(isAbsolute(slot.root));
  assert.equal(pack.workspace.root, slot.root); assert.equal(realpathSync(pack.workspace.root), workspace);
  assert.equal(pack.project.id, configuration.project_id); assert.equal(pack.task.title, configuration.task_title);
  assert.deepEqual(pack.task.acceptance_criteria, configuration.acceptance_criteria);
  assert.equal(pack.conversation, undefined); assert.equal(pack.policy.execution_mode, undefined);
  assert.deepEqual(pack.policy.filesystem_write_scope, [slot.root]);
  assert.equal(configuration.artifact_filename, "changes.patch");
  assert.equal(configuration.artifact_filename, basename(configuration.artifact_filename));
  assert.ok(!existsSync(correctionReceiptPath(directory, runId)), "A run must launch exactly once");
  const entries = pack.review_feedback?.entries ?? [];
  assert.equal(entries.length, [0, 1, 1, 2][index], "Each execution must receive its real preceding change requests");
  if (entries.length) assert.equal(pack.review_feedback.version, 1);
  let position = 0;
  for (const entry of entries) {
    assert.equal(entry.task_id, pack.task.id); assert.ok(typeof entry.event_id === "string" && entry.event_id);
    assert.ok(Number.isSafeInteger(entry.position) && entry.position > position); position = entry.position;
    assert.ok(typeof entry.comment === "string" && entry.comment.trim());
    assert.ok(entry.actor?.type === "user" && typeof entry.actor.id === "string" && entry.actor.id);
    assert.ok(typeof entry.occurred_at === "string" && Number.isFinite(Date.parse(entry.occurred_at)));
  }
  assert.equal(new Set(entries.map((entry) => entry.event_id)).size, entries.length);
  const original = readFileSync(join(workspace, "implementation.txt"), "utf8");
  assert.equal(correctionHash(original), configuration.baseline_sha256, "Every attempt starts from the unchanged Git base");
  assert.ok(!existsSync(join(workspace, "unsaved.txt")) && !existsSync(join(workspace, configuration.artifact_filename)));
  publishExclusive(correctionContextPath(directory, runId), context);
  return { configuration, directory, context, pack, runId, workspace, index, mode, original, entries };
}

export async function runExecutionCorrectionFixture({ contextPath, configurationPath, emit = (line) => console.log(line) }) {
  const value = readExecution(contextPath, configurationPath);
  const { configuration, directory, context, pack, runId, workspace, index, mode, original, entries } = value;
  const implementation = correctionImplementation(pack, runId, mode);
  const pending = `Unuploaded work for task ${pack.task.id}, run ${runId}, stage ${mode}.\nContext SHA256 ${correctionHash(context)}\n`;
  writeFileSync(join(workspace, "implementation.txt"), implementation, { mode: 0o600 });
  writeFileSync(join(workspace, "unsaved.txt"), pending, { flag: "wx", mode: 0o600 });
  let reportHash = null;
  if (mode === "initial" || mode === "corrected") {
    const patch = correctionPatch(original, implementation);
    writeFileSync(join(workspace, configuration.artifact_filename), patch, { flag: "wx", mode: 0o600 });
    publishExclusive(correctionReportPath(directory, runId), patch); reportHash = correctionHash(patch);
  }
  const receipt = {
    slot: index + 1, mode, pid: process.pid, run_id: runId, task_id: pack.task.id, project_id: pack.project.id,
    workspace_root: workspace, context_sha256: correctionHash(context),
    implementation_sha256: correctionHash(implementation), unsaved_sha256: correctionHash(pending),
    feedback: entries.map((entry) => ({ ...entry, comment_sha256: correctionHash(entry.comment) })),
    artifact_filename: reportHash ? configuration.artifact_filename : null, artifact_sha256: reportHash,
  };
  emit(JSON.stringify({ type: "thread.started", thread_id: `correction:${process.pid}:${runId}` }));
  if (mode !== "hold") {
    publishJSON(correctionReceiptPath(directory, runId), receipt);
    if (mode === "failed") {
      emit(JSON.stringify({ type: "error", message: "Intentional correction failure; use Task Retry after inspecting the preserved work." }));
      process.exitCode = CORRECTION_FAILURE_EXIT; return receipt;
    }
    emit(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `Created ${configuration.artifact_filename} from ${entries.length} persisted review comments.` } }));
    emit(JSON.stringify({ type: "turn.completed" }));
    return receipt;
  }
  const timeoutMs = configuration.hold_timeout_ms ?? 300_000;
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10_000 && timeoutMs <= 600_000);
  const stopped = (signal) => {
    publishJSON(correctionExitPath(directory, runId), { run_id: runId, task_id: pack.task.id, pid: process.pid, signal,
      implementation_sha256: correctionHash(readFileSync(join(workspace, "implementation.txt"))),
      unsaved_sha256: correctionHash(readFileSync(join(workspace, "unsaved.txt"))) });
    process.exit(0);
  };
  process.once("SIGTERM", () => stopped("SIGTERM")); process.once("SIGINT", () => stopped("SIGINT"));
  // Signal handlers are installed before the readiness receipt becomes visible.
  publishJSON(correctionReceiptPath(directory, runId), receipt);
  await new Promise(() => {
    setInterval(() => emit(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Waiting for the real user Stop command." } })), 1000).unref();
    setTimeout(() => { console.error("Correction hold expired before a user cancellation"); process.exit(CORRECTION_HOLD_TIMEOUT_EXIT); }, timeoutMs);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 4, "Expected actual context path and fixture configuration path");
  await runExecutionCorrectionFixture({ contextPath: process.argv[2], configurationPath: process.argv[3] });
}
