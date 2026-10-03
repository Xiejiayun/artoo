import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CORRECTION_FAILURE_EXIT, CORRECTION_IGNORED_FILE, correctionContextPath, correctionExitPath, correctionIgnoredBytes, correctionReceiptPath, correctionReportPath } from "./execution-correction.mjs";

// Real CLI subprocess and Git fixture tests. Signals target only children this
// file starts; user-facing Stop and worktree cleanup remain separate E2E checks.
const executable = fileURLToPath(new URL("./execution-correction.mjs", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const modes = ["initial", "failed", "corrected", "hold"];
const baseline = "Initial task-owned implementation.\n";
const frames = (output) => output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

function git(directory, args) {
  const ownedRoot = dirname(directory);
  const result = spawnSync("git", ["-C", directory, "-c", `core.hooksPath=${join(ownedRoot, "hooks")}`, "-c", "core.autocrlf=false", ...args], { encoding: "utf8", timeout: 10_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(ownedRoot, "empty.gitconfig") } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function setup(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "artoo-correction-cli-test-")));
  const base = join(directory, "base"), receipts = join(directory, "receipts"), contexts = join(directory, "contexts");
  for (const path of [base, receipts, contexts, join(directory, "hooks")]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(directory, "empty.gitconfig"), "");
  const children = [];
  t.after(async () => {
    for (const owned of children) {
      if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill("SIGKILL");
      await owned.closed;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  git(base, ["init", "--initial-branch=fixture-main"]);
  git(base, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(base, "implementation.txt"), baseline);
  writeFileSync(join(base, ".gitignore"), `${CORRECTION_IGNORED_FILE}\n`);
  git(base, ["add", "implementation.txt", ".gitignore"]);
  git(base, ["-c", "user.name=Correction Fixture", "-c", "user.email=correction-fixture@artoo.test", "commit", "-m", "Task-owned baseline"]);
  const commit = git(base, ["rev-parse", "HEAD"]).trim();
  const configuration = { project_id: "project_correction", task_title: "Correct the actual delivered report",
    acceptance_criteria: ["Keep original feedback", "Preserve failed work"], artifact_filename: "changes.patch",
    baseline_sha256: hash(baseline), receipts_directory: receipts, hold_timeout_ms: 10_000,
    workspaces: modes.map((mode) => ({ mode, root: join(directory, `worktree-${mode}`) })) };
  for (const slot of configuration.workspaces) git(base, ["worktree", "add", "--detach", slot.root, commit]);
  return { directory, base, receipts, contexts, configuration, commit, children,
    configurationPath: join(directory, "configuration.json") };
}

function feedback(index) {
  return { event_id: `review_${index}`, position: index * 10, task_id: "task_correction",
    actor: { type: "user", id: `reviewer_${index}` }, occurred_at: "2026-10-01T00:00:00.000Z",
    comment: index === 1 ? "  C1: 修正第一版\n\tKeep the exact original text.  " : "C2: preserve recoverable work before stopping.",
    artifact_ids: index === 1 ? ["artifact_original"] : ["artifact_original", "artifact_corrected"] };
}

function packFor(state, mode) {
  const index = modes.indexOf(mode), root = state.configuration.workspaces[index].root;
  const entries = index === 0 ? [] : index === 3 ? [feedback(1), feedback(2)] : [feedback(1)];
  return {
    task: { id: "task_correction", title: state.configuration.task_title, description: "Real CLI unit fixture", acceptance_criteria: state.configuration.acceptance_criteria },
    project: { id: state.configuration.project_id, name: "Correction fixture", default_workspace: null },
    workspace: { root, file_scope: [] }, policy: { filesystem_write_scope: [root], requires_approval: ["git.push", "external.post"] },
    memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    ...(entries.length ? { review_feedback: { version: 1, entries } } : {}),
  };
}

function prepare(state, mode, runId, options = {}) {
  const pack = options.pack ?? packFor(state, mode);
  const header = options.header ?? `# Context Pack context_${runId}\ntask: ${pack.task.id}\nrun: ${runId}`;
  const source = options.source ?? `${header}\n\n## Task\ndescription: A rendered task\nrun: misleading_description_run\n\n## Raw Payload\n${JSON.stringify(pack, null, 2)}\n`;
  const contextPath = join(state.contexts, `${hash(runId)}.md`);
  writeFileSync(contextPath, source);
  writeFileSync(state.configurationPath, JSON.stringify(state.configuration));
  return { contextPath, source, pack, workspace: state.configuration.workspaces[modes.indexOf(mode)].root };
}

function execute(state, mode, runId, options = {}) {
  const input = prepare(state, mode, runId, options);
  const child = spawnSync(process.execPath, [executable, input.contextPath, state.configurationPath], {
    cwd: options.cwd ?? input.workspace, env: {}, encoding: "utf8", timeout: 5000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  return { child, ...input };
}

function launch(state, input) {
  const child = spawn(process.execPath, [executable, input.contextPath, state.configurationPath], {
    cwd: input.workspace, env: {}, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  const owned = { child, closed, stdout: () => stdout, stderr: () => stderr };
  state.children.push(owned);
  return owned;
}

const receipt = (state, runId) => JSON.parse(readFileSync(correctionReceiptPath(state.receipts, runId), "utf8"));
const launches = (state) => readdirSync(state.receipts).filter((name) => name.startsWith("launch-")).map((name) => JSON.parse(readFileSync(join(state.receipts, name), "utf8")));
const privateTemps = (state) => readdirSync(state.receipts).filter((name) => /^\.correction-.*\.tmp$/.test(name));

function assertFileEvidence(state, runId, result) {
  const recorded = receipt(state, runId);
  assert.equal(recorded.pid, result.child.pid);
  assert.equal(recorded.run_id, runId);
  assert.equal(recorded.task_id, result.pack.task.id);
  assert.equal(recorded.workspace_root, result.workspace);
  assert.equal(recorded.context_sha256, hash(result.source));
  assert.deepEqual(readFileSync(correctionContextPath(state.receipts, runId)), Buffer.from(result.source));
  for (const [filename, field] of [["implementation.txt", "implementation_sha256"], ["unsaved.txt", "unsaved_sha256"], [CORRECTION_IGNORED_FILE, "ignored_sha256"]]) {
    assert.equal(hash(readFileSync(join(result.workspace, filename))), recorded[field]);
  }
  const ignored = readFileSync(join(result.workspace, CORRECTION_IGNORED_FILE));
  assert.deepEqual(ignored, correctionIgnoredBytes(result.pack, runId, recorded.mode, recorded.context_sha256));
  assert.deepEqual([...ignored.subarray(0, 5)], [0, 255, 128, 13, 10]);
  assert.equal(ignored.length, recorded.ignored_size);
  assert.equal(git(result.workspace, ["check-ignore", "--", CORRECTION_IGNORED_FILE]).trim(), CORRECTION_IGNORED_FILE);
  assert.deepEqual(recorded.feedback, (result.pack.review_feedback?.entries ?? []).map((entry) => ({ ...entry, comment_sha256: hash(entry.comment) })));
  assert.deepEqual(git(result.workspace, ["diff", "--name-only"]).trim().split("\n"), ["implementation.txt"]);
  assert.deepEqual(privateTemps(state), []);
  if (process.platform !== "win32") assert.equal(statSync(correctionReceiptPath(state.receipts, runId)).mode & 0o777, 0o600);
  return recorded;
}

test("initial and corrected children derive distinct real Git-applicable patches from their actual context", (t) => {
  const state = setup(t), hashes = [];
  for (const mode of ["initial", "corrected"]) {
    const runId = `run_${mode}`, result = execute(state, mode, runId);
    assert.equal(result.child.status, 0, result.child.stderr);
    const recorded = assertFileEvidence(state, runId, result);
    const patch = readFileSync(join(result.workspace, "changes.patch"));
    assert.equal(hash(patch), recorded.artifact_sha256);
    assert.deepEqual(readFileSync(correctionReportPath(state.receipts, runId)), patch);
    hashes.push(recorded.artifact_sha256);
    assert.equal(recorded.artifact_filename, "changes.patch");
    assert.deepEqual(frames(result.child.stdout).map((frame) => frame.type), ["thread.started", "item.completed", "turn.completed"]);
    const verify = join(state.directory, `verify-${mode}`);
    git(state.base, ["worktree", "add", "--detach", verify, state.commit]);
    git(verify, ["apply", "--check", correctionReportPath(state.receipts, runId)]);
    git(verify, ["apply", correctionReportPath(state.receipts, runId)]);
    assert.deepEqual(readFileSync(join(verify, "implementation.txt")), readFileSync(join(result.workspace, "implementation.txt")));
    assert.equal(existsSync(join(verify, "unsaved.txt")), false);
    assert.equal(existsSync(join(verify, CORRECTION_IGNORED_FILE)), false, "Uploaded patch cannot reconstruct the real ignored work");
    if (mode === "corrected") {
      assert.ok(patch.toString().includes(JSON.stringify(feedback(1).comment)));
      assert.ok(patch.toString().includes(feedback(1).event_id));
      assert.ok(patch.toString().includes(hash(feedback(1).comment)));
    }
  }
  assert.notEqual(hashes[0], hashes[1]);
  assert.equal(git(state.base, ["status", "--porcelain"]), "");
  assert.equal(readFileSync(join(state.base, "implementation.txt"), "utf8"), baseline);
  assert.ok(!readFileSync(state.configurationPath, "utf8").includes(feedback(1).comment), "Feedback must come from the context, not hidden fixture configuration");
  assert.equal(launches(state).length, 2);
});

test("failed execution exits 23 with real tracked/new files and immutable evidence but no report or success", (t) => {
  const state = setup(t), result = execute(state, "failed", "run_failed");
  assert.equal(result.child.status, CORRECTION_FAILURE_EXIT, result.child.stderr);
  const recorded = assertFileEvidence(state, "run_failed", result);
  assert.equal(recorded.artifact_filename, null); assert.equal(recorded.artifact_sha256, null);
  assert.equal(existsSync(join(result.workspace, "changes.patch")), false);
  assert.equal(existsSync(correctionReportPath(state.receipts, "run_failed")), false);
  assert.deepEqual(frames(result.child.stdout).map((frame) => frame.type), ["thread.started", "error"]);
  assert.equal(launches(state)[0].pid, result.child.pid);
  assert.equal(git(state.base, ["status", "--porcelain"]), "");
});

test("hold is live until owned SIGTERM, then records exact exit hashes without changing startup/context evidence", {
  skip: process.platform === "win32" ? "Windows process termination does not deliver a POSIX SIGTERM handler" : false,
}, async (t) => {
  const state = setup(t), runId = "run_hold", input = prepare(state, "hold", runId), owned = launch(state, input);
  const deadline = Date.now() + 5000;
  while (!existsSync(correctionReceiptPath(state.receipts, runId)) && Date.now() < deadline) {
    assert.equal(owned.child.exitCode, null, owned.stderr()); await delay(10);
  }
  assert.ok(existsSync(correctionReceiptPath(state.receipts, runId)), owned.stderr());
  const recorded = assertFileEvidence(state, runId, { ...input, child: owned.child });
  const originalReceipt = readFileSync(correctionReceiptPath(state.receipts, runId));
  const originalContext = readFileSync(correctionContextPath(state.receipts, runId));
  assert.equal(recorded.feedback.length, 2);
  assert.equal(recorded.artifact_sha256, null);
  assert.equal(existsSync(correctionExitPath(state.receipts, runId)), false);
  process.kill(owned.child.pid, 0);
  await delay(50);
  assert.equal(owned.child.exitCode, null); assert.equal(owned.child.signalCode, null);
  assert.equal(owned.child.kill("SIGTERM"), true);
  assert.deepEqual(await owned.closed, { status: 0, signal: null });
  const exit = JSON.parse(readFileSync(correctionExitPath(state.receipts, runId), "utf8"));
  assert.deepEqual(exit, { run_id: runId, task_id: input.pack.task.id, pid: owned.child.pid, signal: "SIGTERM",
    implementation_sha256: recorded.implementation_sha256, unsaved_sha256: recorded.unsaved_sha256, ignored_sha256: recorded.ignored_sha256 });
  assert.deepEqual(readFileSync(correctionReceiptPath(state.receipts, runId)), originalReceipt);
  assert.deepEqual(readFileSync(correctionContextPath(state.receipts, runId)), originalContext);
  assert.equal(hash(readFileSync(join(input.workspace, "implementation.txt"))), exit.implementation_sha256);
  assert.equal(hash(readFileSync(join(input.workspace, "unsaved.txt"))), exit.unsaved_sha256);
  assert.equal(hash(readFileSync(join(input.workspace, CORRECTION_IGNORED_FILE))), exit.ignored_sha256);
  assert.ok(!frames(owned.stdout()).some((frame) => frame.type === "turn.completed" || frame.item?.type === "agent_message"));
  assert.equal(existsSync(join(input.workspace, "changes.patch")), false);
  assert.equal(launches(state).length, 1);
});

test("forced termination exits the held child without an exit receipt and preserves all recorded work bytes", async (t) => {
  const state = setup(t), runId = "run_forced_hold", input = prepare(state, "hold", runId), owned = launch(state, input);
  const deadline = Date.now() + 5000;
  while (!existsSync(correctionReceiptPath(state.receipts, runId)) && Date.now() < deadline) {
    assert.equal(owned.child.exitCode, null, owned.stderr()); await delay(10);
  }
  assert.ok(existsSync(correctionReceiptPath(state.receipts, runId)), owned.stderr());
  const recorded = assertFileEvidence(state, runId, { ...input, child: owned.child });
  const paths = [correctionReceiptPath(state.receipts, runId), correctionContextPath(state.receipts, runId),
    join(input.workspace, "implementation.txt"), join(input.workspace, "unsaved.txt"), join(input.workspace, CORRECTION_IGNORED_FILE)];
  const before = paths.map((path) => readFileSync(path));
  process.kill(owned.child.pid, 0);
  assert.equal(owned.child.kill("SIGKILL"), true);
  const terminal = await owned.closed;
  assert.ok(terminal.signal !== null || terminal.status !== 0, "Forced process termination must not report successful completion");
  assert.equal(owned.child.exitCode === null && owned.child.signalCode === null, false);
  assert.equal(existsSync(correctionExitPath(state.receipts, runId)), false);
  assert.deepEqual(paths.map((path) => readFileSync(path)), before);
  assert.equal(hash(readFileSync(join(input.workspace, "implementation.txt"))), recorded.implementation_sha256);
  assert.equal(hash(readFileSync(join(input.workspace, "unsaved.txt"))), recorded.unsaved_sha256);
  assert.ok(!frames(owned.stdout()).some((frame) => frame.type === "turn.completed"));
  assert.equal(launches(state).length, 1);
});

test("a duplicate run remains a counted real launch and cannot overwrite original context/report/receipt or work", (t) => {
  const state = setup(t), runId = "run_duplicate", first = execute(state, "initial", runId);
  assert.equal(first.child.status, 0, first.child.stderr);
  const paths = [correctionReceiptPath(state.receipts, runId), correctionContextPath(state.receipts, runId), correctionReportPath(state.receipts, runId),
    join(first.workspace, "implementation.txt"), join(first.workspace, "unsaved.txt"), join(first.workspace, CORRECTION_IGNORED_FILE), join(first.workspace, "changes.patch")];
  const before = paths.map((path) => readFileSync(path));
  const duplicate = execute(state, "initial", runId);
  assert.equal(duplicate.child.status, 1); assert.equal(duplicate.child.stdout, "");
  assert.deepEqual(paths.map((path) => readFileSync(path)), before);
  const observed = launches(state);
  assert.equal(observed.length, 2);
  assert.deepEqual(new Set(observed.map((item) => item.pid)), new Set([first.child.pid, duplicate.child.pid]));
  assert.ok(observed.every((item) => item.run_id === runId));
  assert.deepEqual(privateTemps(state), []);
});

test("a fresh run in a retained failed workspace is rejected without overwriting its tracked or new work", (t) => {
  const state = setup(t), first = execute(state, "failed", "run_retained");
  assert.equal(first.child.status, CORRECTION_FAILURE_EXIT);
  const paths = [join(first.workspace, "implementation.txt"), join(first.workspace, "unsaved.txt"), join(first.workspace, CORRECTION_IGNORED_FILE),
    correctionReceiptPath(state.receipts, "run_retained"), correctionContextPath(state.receipts, "run_retained")];
  const before = paths.map((path) => readFileSync(path));
  const reuse = execute(state, "failed", "run_reused_workspace");
  assert.equal(reuse.child.status, 1); assert.equal(reuse.child.stdout, "");
  assert.deepEqual(paths.map((path) => readFileSync(path)), before);
  assert.equal(existsSync(correctionReceiptPath(state.receipts, "run_reused_workspace")), false);
  assert.equal(existsSync(correctionContextPath(state.receipts, "run_reused_workspace")), false);
  assert.equal(launches(state).length, 2);
});

test("two concurrent invocations of one run yield one immutable winner and two observed process launches", async (t) => {
  const state = setup(t), runId = "run_concurrent", input = prepare(state, "initial", runId);
  const children = [launch(state, input), launch(state, input)];
  const results = await Promise.all(children.map((item) => item.closed));
  assert.deepEqual(results.map((item) => item.status).sort(), [0, 1]);
  const winner = children[results.findIndex((item) => item.status === 0)];
  assert.equal(receipt(state, runId).pid, winner.child.pid);
  assert.equal(readdirSync(state.receipts).filter((name) => name.startsWith("run-")).length, 1);
  assert.equal(readdirSync(state.receipts).filter((name) => name.startsWith("context-")).length, 1);
  assert.equal(readdirSync(state.receipts).filter((name) => name.startsWith("report-")).length, 1);
  assert.equal(launches(state).length, 2);
  assertFileEvidence(state, runId, { ...input, child: winner.child });
  assert.deepEqual(privateTemps(state), []);
});

for (const [name, mode, mutate, options] of [
  ["wrong project", "initial", (pack) => { pack.project.id = "foreign_project"; }],
  ["wrong title", "initial", (pack) => { pack.task.title = "Unrelated task"; }],
  ["wrong acceptance criteria", "initial", (pack) => { pack.task.acceptance_criteria = ["Different criterion"]; }],
  ["wrong context workspace", "initial", (pack, state) => { pack.workspace.root = state.base; }],
  ["missing write grant", "initial", (pack) => { pack.policy.filesystem_write_scope = []; }],
  ["assistant conversation", "initial", (pack) => { pack.conversation = {}; }],
  ["planning discussion", "initial", (pack) => { pack.policy.execution_mode = "discussion"; }],
  ["missing preceding feedback", "failed", (pack) => { delete pack.review_feedback; }],
  ["foreign feedback task", "failed", (pack) => { pack.review_feedback.entries[0].task_id = "foreign_task"; }],
  ["blank correction", "failed", (pack) => { pack.review_feedback.entries[0].comment = " \n\t"; }],
  ["reversed feedback order", "hold", (pack) => { pack.review_feedback.entries.reverse(); }],
  ["duplicate feedback identities", "hold", (pack) => { pack.review_feedback.entries[1].event_id = pack.review_feedback.entries[0].event_id; }],
  ["missing run header", "initial", () => {}, { header: "# Context Pack ctx\ntask: task_correction" }],
  ["mismatched task header", "initial", () => {}, { header: "# Context Pack ctx\ntask: another_task\nrun: run_invalid" }],
  ["two run headers", "initial", () => {}, { header: "# Context Pack ctx\ntask: task_correction\nrun: run_invalid\nrun: run_other" }],
  ["missing raw payload", "initial", () => {}, { source: "# Context Pack ctx\ntask: task_correction\nrun: run_invalid\n\nNo raw payload here.\n" }],
  ["malformed raw payload", "initial", () => {}, { source: "# Context Pack ctx\ntask: task_correction\nrun: run_invalid\n\n## Raw Payload\n{broken json\n" }],
]) test(`invalid ${name} is counted and rejected before workspace mutation or successful receipt`, (t) => {
  const state = setup(t), pack = packFor(state, mode);
  mutate(pack, state);
  const result = execute(state, mode, "run_invalid", { pack, ...options });
  assert.equal(result.child.status, 1); assert.equal(result.child.stdout, "");
  assert.equal(git(result.workspace, ["status", "--porcelain"]), "");
  assert.equal(readFileSync(join(result.workspace, "implementation.txt"), "utf8"), baseline);
  assert.equal(existsSync(correctionReceiptPath(state.receipts, "run_invalid")), false);
  assert.equal(existsSync(correctionContextPath(state.receipts, "run_invalid")), false);
  assert.equal(existsSync(correctionReportPath(state.receipts, "run_invalid")), false);
  assert.equal(launches(state).length, 1, "A rejected invocation must not vanish from actual process-launch accounting");
  assert.equal(launches(state)[0].pid, result.child.pid);
  assert.deepEqual(privateTemps(state), []);
});
