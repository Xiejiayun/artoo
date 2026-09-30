// Deterministic subprocess used only by the native UI execution acceptance harness.
// The scheduler supplies the context; this process writes the actual report and
// observed receipt without contacting an API or changing any run state.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

assert.equal(process.argv.length, 4, "Expected contextPackPath and configurationPath");
const [contextPath, configurationPath] = process.argv.slice(2);
const context = readFileSync(contextPath);
const source = context.toString("utf8");
const marker = "## Raw Payload\n";
assert.ok(source.includes(marker), "The process adapter must provide a complete context pack");
const pack = JSON.parse(source.slice(source.indexOf(marker) + marker.length));
const header = source.split("\n\n", 1)[0];
const runs = [...header.matchAll(/^run: (.+)$/gm)];
const tasks = [...header.matchAll(/^task: (.+)$/gm)];
assert.equal(runs.length, 1, "The context header must identify the actual run");
assert.equal(tasks.length, 1, "The context header must identify the actual task");
const runId = runs[0][1];
assert.ok(runId.trim(), "The run ID must not be empty");
assert.equal(tasks[0][1], pack.task.id, "The raw task must match the process adapter header");

const fixture = JSON.parse(readFileSync(configurationPath, "utf8"));
for (const field of ["project_id", "executor_workspace", "execution_task_title", "execution_criterion_1", "execution_criterion_2",
  "execution_artifact_filename", "execution_artifact_marker", "execution_receipts_directory"]) {
  assert.ok(typeof fixture[field] === "string" && fixture[field].trim(), `Missing fixture field: ${field}`);
}
assert.equal(pack.project.id, fixture.project_id);
assert.equal(pack.task.title, fixture.execution_task_title);
assert.deepEqual(pack.task.acceptance_criteria, [fixture.execution_criterion_1, fixture.execution_criterion_2]);
assert.equal(pack.policy.execution_mode, undefined, "Only an ordinary execution context may write the report");
assert.ok(isAbsolute(fixture.executor_workspace), "The configured executor workspace must be absolute");
assert.ok(isAbsolute(pack.workspace.root), "The context workspace must be absolute");
const workspaceRoot = realpathSync(fixture.executor_workspace);
assert.equal(realpathSync(process.cwd()), workspaceRoot, "The subprocess must run in the configured executor workspace");
assert.equal(realpathSync(pack.workspace.root), workspaceRoot, "The context must use the configured executor workspace");
assert.ok(Array.isArray(pack.policy.filesystem_write_scope));
assert.ok(pack.policy.filesystem_write_scope.some((scope) => isAbsolute(scope) && realpathSync(scope) === workspaceRoot),
  "The filesystem write scope must include the actual executor workspace");

const artifactFilename = fixture.execution_artifact_filename;
assert.ok(artifactFilename === basename(artifactFilename) && !artifactFilename.includes("\\") && extname(artifactFilename) === ".txt",
  "The artifact must be a top-level .txt filename inside the executor workspace");
assert.ok(isAbsolute(fixture.execution_receipts_directory), "The receipt directory must be absolute");
const receiptDirectory = realpathSync(fixture.execution_receipts_directory);
const artifactPath = join(workspaceRoot, artifactFilename);
const report = [
  fixture.execution_artifact_marker,
  `task: ${pack.task.id}`,
  `run: ${runId}`,
  `project: ${pack.project.id}`,
  "",
  "Acceptance criteria:",
  ...pack.task.acceptance_criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
  "",
].join("\n");
// Exclusive creation makes an old report an error rather than fresh evidence.
writeFileSync(artifactPath, report, { mode: 0o600, flag: "wx" });
writeFileSync(join(receiptDirectory, `${sha256(runId)}.json`), JSON.stringify({
  pid: process.pid, run_id: runId, task_id: pack.task.id, project_id: pack.project.id,
  workspace_root: workspaceRoot, acceptance_criteria: pack.task.acceptance_criteria,
  artifact_filename: artifactFilename, artifact_sha256: sha256(readFileSync(artifactPath)), context_sha256: sha256(context),
}), { mode: 0o600, flag: "wx" });

console.log(JSON.stringify({ type: "thread.started", thread_id: `ios-ui-executor:${process.pid}:${runId}` }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message",
  text: `Wrote ${artifactFilename} for task ${pack.task.id} and run ${runId}, recording both acceptance criteria.` } }));
console.log(JSON.stringify({ type: "turn.completed" }));
