// A separate one-run CLI fixture. It only consumes the real process context,
// changes its explicitly owned Git workspace and emits normal CLI completion.
// It does not call the server, upload an artifact or assert product retention.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const zeroArtifactHash = (value) => createHash("sha256").update(value).digest("hex");
export const ZERO_ARTIFACT_FILES = ["implementation.txt", "unuploaded.txt", "ignored.bin"];
export const zeroArtifactReceiptPath = (directory, runId) => join(directory, `run-${zeroArtifactHash(runId)}.json`);
export const zeroArtifactContextPath = (directory, runId) => join(directory, `context-${zeroArtifactHash(runId)}.md`);

function publishExclusive(path, bytes) {
  const temporary = join(dirname(path), `.zero-artifact-${randomBytes(16).toString("hex")}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, "wx", 0o600); created = true;
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    linkSync(temporary, path);
  } finally { if (created) rmSync(temporary, { force: true }); }
}
const publishJSON = (path, value) => publishExclusive(path, JSON.stringify(value));

export function zeroArtifactWork(pack, runId, contextHash) {
  return {
    "implementation.txt": Buffer.from(`Completed local work\ntask: ${pack.task.id}\nrun: ${runId}\ncontext: ${contextHash}\n`, "utf8"),
    "unuploaded.txt": Buffer.from(`Unuploaded work — 中文\ntask: ${pack.task.id}\nrun: ${runId}\ncontext: ${contextHash}\n`, "utf8"),
    "ignored.bin": Buffer.concat([Buffer.from([0, 255, 128, 13, 10]),
      Buffer.from(`Zero-artifact work: ${pack.task.id}\n${runId}\n`, "utf8"), Buffer.from(contextHash, "hex"), Buffer.from([0])]),
  };
}

export function runZeroArtifactWorkspace({ contextPath, configurationPath, emit = (line) => console.log(line) }) {
  const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
  assert.ok(isAbsolute(configuration.receipts_directory));
  assert.ok(isAbsolute(configuration.workspace_root));
  const directory = realpathSync(configuration.receipts_directory), workspace = realpathSync(process.cwd());
  const context = readFileSync(contextPath), text = context.toString("utf8"), marker = "## Raw Payload\n";
  const header = text.split("\n\n", 1)[0];
  const ids = (name) => [...header.matchAll(new RegExp(`^${name}: (.+)$`, "gm"))].map((match) => match[1]);
  const runIds = ids("run"), taskIds = ids("task");
  // Every actual invocation is recorded, including an invalid or duplicate one.
  publishJSON(join(directory, `launch-${process.pid}-${randomBytes(8).toString("hex")}.json`), {
    pid: process.pid, run_id: runIds.length === 1 ? runIds[0] : null,
    task_id: taskIds.length === 1 ? taskIds[0] : null, workspace_root: workspace,
    started_at: new Date().toISOString(),
  });
  assert.ok(text.includes(marker));
  const pack = JSON.parse(text.slice(text.indexOf(marker) + marker.length));
  assert.equal(runIds.length, 1); assert.equal(taskIds.length, 1);
  const runId = runIds[0]; assert.ok(runId.trim()); assert.equal(taskIds[0], pack.task.id);
  assert.equal(resolve(configuration.workspace_root), workspace);
  assert.equal(pack.workspace.root, configuration.workspace_root);
  assert.equal(realpathSync(pack.workspace.root), workspace);
  assert.equal(pack.project.id, configuration.project_id);
  assert.equal(pack.task.title, configuration.task_title);
  assert.deepEqual(pack.task.acceptance_criteria, configuration.acceptance_criteria);
  assert.deepEqual(pack.policy.filesystem_write_scope, [configuration.workspace_root]);
  assert.equal(pack.conversation, undefined); assert.equal(pack.policy.execution_mode, undefined);
  assert.equal(pack.review_feedback, undefined, "This is a separate fresh task with no earlier review");
  assert.ok(lstatSync(join(workspace, "implementation.txt")).isFile());
  assert.equal(zeroArtifactHash(readFileSync(join(workspace, "implementation.txt"))), configuration.baseline_sha256);
  for (const filename of ["unuploaded.txt", "ignored.bin", "changes.patch"]) assert.equal(existsSync(join(workspace, filename)), false);
  // One configured workspace has one immutable owner even if two distinct run
  // IDs are accidentally launched concurrently by the fixture harness.
  publishJSON(join(directory, "workspace-owner.json"), { run_id: runId, task_id: pack.task.id, workspace_root: workspace });
  publishExclusive(zeroArtifactContextPath(directory, runId), context);
  const files = zeroArtifactWork(pack, runId, zeroArtifactHash(context));
  for (const [filename, bytes] of Object.entries(files)) {
    writeFileSync(join(workspace, filename), bytes, { mode: 0o600, flag: filename === "implementation.txt" ? "w" : "wx" });
  }
  const receipt = { mode: "zero-artifact-success", pid: process.pid, run_id: runId, task_id: pack.task.id,
    project_id: pack.project.id, workspace_root: workspace, context_sha256: zeroArtifactHash(context),
    files: Object.fromEntries(Object.entries(files).map(([filename, bytes]) => [filename, { sha256: zeroArtifactHash(bytes), size: bytes.length }])),
    artifact_filenames: [] };
  publishJSON(zeroArtifactReceiptPath(directory, runId), receipt);
  emit(JSON.stringify({ type: "thread.started", thread_id: `zero-artifact:${process.pid}:${runId}` }));
  emit(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Completed local work. No report artifact was requested." } }));
  emit(JSON.stringify({ type: "turn.completed" }));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 4, "Expected actual context path and fixture configuration path");
  runZeroArtifactWorkspace({ contextPath: process.argv[2], configurationPath: process.argv[3] });
}
