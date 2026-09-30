import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const executable = fileURLToPath(new URL("./ios-ui-execution.mjs", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-ios-execution-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, "executor");
  const receipts = join(directory, "receipts");
  mkdirSync(workspace);
  mkdirSync(receipts);
  const fixture = {
    project_id: "project-native-execution", executor_workspace: workspace,
    execution_task_title: "Native report-producing task",
    execution_criterion_1: "The approved task runs on the selected executor",
    execution_criterion_2: "The report can be previewed before acceptance",
    execution_artifact_filename: "native-execution-report.txt",
    execution_artifact_marker: "Unique native execution result",
    execution_receipts_directory: receipts,
  };
  const pack = {
    task: { id: "task-native-execution", title: fixture.execution_task_title, description: "Produce the report",
      acceptance_criteria: [fixture.execution_criterion_1, fixture.execution_criterion_2] },
    project: { id: fixture.project_id, name: "Native acceptance", default_workspace: null },
    workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] },
    memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
  };
  const runId = "run-native-execution";
  const header = `# Context Pack context-native-execution\ntask: ${pack.task.id}\nrun: ${runId}`;
  const contextPath = join(workspace, "context_pack.md");
  const configurationPath = join(directory, "configuration.json");
  return { directory, workspace, receipts, fixture, pack, runId, header, contextPath, configurationPath };
}

function execute(state, { cwd = state.workspace, header = state.header } = {}) {
  // A task description may contain a run-like line; only the initial header is authoritative.
  const source = `${header}\n\n## Task\ndescription: A rendered task\nrun: misleading-description-run\n\n## Raw Payload\n${JSON.stringify(state.pack, null, 2)}\n`;
  writeFileSync(state.contextPath, source);
  writeFileSync(state.configurationPath, JSON.stringify(state.fixture));
  return { source, child: spawnSync(process.execPath, [executable, state.contextPath, state.configurationPath], { cwd, encoding: "utf8" }) };
}

test("execution writes a real report and receipt from the actual context and emits only observed session evidence", (t) => {
  const state = setup(t);
  const alias = join(state.directory, "executor-alias");
  symlinkSync(state.workspace, alias, "dir");
  state.fixture.executor_workspace = `${alias}/.`;
  state.pack.workspace.root = `${state.workspace}/.`;
  state.pack.policy.filesystem_write_scope = [alias];
  const { source, child } = execute(state);
  assert.equal(child.status, 0, child.stderr);
  const artifactPath = join(state.workspace, state.fixture.execution_artifact_filename);
  const artifact = readFileSync(artifactPath);
  for (const value of [state.fixture.execution_artifact_marker, state.pack.task.id, state.runId, ...state.pack.task.acceptance_criteria]) {
    assert.ok(artifact.toString("utf8").includes(value), `Report is missing ${value}`);
  }
  assert.ok(!artifact.toString("utf8").includes("misleading-description-run"));
  const receiptName = `${sha256(state.runId)}.json`;
  assert.deepEqual(readdirSync(state.receipts), [receiptName]);
  const receiptPath = join(state.receipts, receiptName);
  const receiptSource = readFileSync(receiptPath, "utf8");
  assert.deepEqual(JSON.parse(receiptSource), {
    pid: child.pid, run_id: state.runId, task_id: state.pack.task.id, project_id: state.fixture.project_id,
    workspace_root: realpathSync(state.workspace), acceptance_criteria: state.pack.task.acceptance_criteria,
    artifact_filename: state.fixture.execution_artifact_filename, artifact_sha256: sha256(artifact), context_sha256: sha256(source),
  });
  const events = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], { type: "thread.started", thread_id: `ios-ui-executor:${child.pid}:${state.runId}` });
  assert.equal(events[1].type, "item.completed");
  assert.equal(events[1].item.type, "agent_message");
  assert.ok(events[1].item.text.includes(state.fixture.execution_artifact_filename));
  assert.deepEqual(events[2], { type: "turn.completed" });

  const repeated = execute(state).child;
  assert.notEqual(repeated.status, 0, "An existing report must never masquerade as a fresh run");
  assert.equal(repeated.stdout, "");
  assert.deepEqual(readFileSync(artifactPath), artifact);
  assert.equal(readFileSync(receiptPath, "utf8"), receiptSource);
});

for (const [name, mutate, options] of [
  ["discussion mode", (state) => { state.pack.policy.execution_mode = "discussion"; }],
  ["invented execution mode", (state) => { state.pack.policy.execution_mode = "execution"; }],
  ["wrong project", (state) => { state.pack.project.id = "another-project"; }],
  ["wrong title", (state) => { state.pack.task.title += " changed"; }],
  ["different criteria", (state) => { state.pack.task.acceptance_criteria.reverse(); }],
  ["different context workspace", (state) => { state.pack.workspace.root = state.directory; }],
  ["different configured workspace", (state) => { state.fixture.executor_workspace = state.directory; }],
  ["missing write scope", (state) => { state.pack.policy.filesystem_write_scope = []; }],
  ["missing real run header", () => {}, { header: "# Context Pack context-native-execution\ntask: task-native-execution" }],
  ["mismatched task header", () => {}, { header: "# Context Pack context-native-execution\ntask: another-task\nrun: run-native-execution" }],
  ["escaping artifact name", (state) => { state.fixture.execution_artifact_filename = "../escaped.txt"; }],
]) {
  test(`execution rejects ${name} before writing an artifact or receipt`, (t) => {
    const state = setup(t);
    mutate(state);
    const { child } = execute(state, options);
    assert.notEqual(child.status, 0);
    assert.equal(child.stdout, "");
    assert.deepEqual(readdirSync(state.workspace), ["context_pack.md"]);
    assert.deepEqual(readdirSync(state.receipts), []);
    assert.ok(!existsSync(join(state.directory, "escaped.txt")));
  });
}
