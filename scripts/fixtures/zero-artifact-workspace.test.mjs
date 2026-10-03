import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ZERO_ARTIFACT_FILES, zeroArtifactContextPath, zeroArtifactHash as hash, zeroArtifactReceiptPath, zeroArtifactWork } from "./zero-artifact-workspace.mjs";

const executable = fileURLToPath(new URL("./zero-artifact-workspace.mjs", import.meta.url));
const baseline = "Original untouched Git baseline.\n";
function setup(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "artoo-zero-artifact-cli-")));
  const base = join(directory, "base"), workspace = join(directory, "worktree"), receipts = join(directory, "receipts");
  for (const path of [base, receipts, join(directory, "hooks")]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(directory, "gitconfig"), "");
  const children = [];
  t.after(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const git = (cwd, ...args) => {
    const result = spawnSync("git", ["-C", cwd, "-c", `core.hooksPath=${join(directory, "hooks")}`, "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "gitconfig") },
    });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  git(base, "init", "--initial-branch=fixture-base");
  writeFileSync(join(base, "implementation.txt"), baseline); writeFileSync(join(base, ".gitignore"), "ignored.bin\n");
  git(base, "add", "implementation.txt", ".gitignore");
  git(base, "-c", "user.name=Artoo Fixture", "-c", "user.email=fixture@artoo.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Disposable baseline");
  const head = git(base, "rev-parse", "HEAD"), index = readFileSync(join(base, ".git", "index"));
  git(base, "worktree", "add", "-b", "artoo/zero-artifact-fixture", workspace);
  const configuration = { workspace_root: workspace, receipts_directory: receipts, project_id: "project_zero", task_title: "Keep all local work without uploading a report",
    acceptance_criteria: ["Keep modified, new and ignored files", "Create no report artifact"], baseline_sha256: hash(baseline) };
  const configurationPath = join(directory, "configuration.json"); writeFileSync(configurationPath, JSON.stringify(configuration));
  const pack = { task: { id: "task_zero", title: configuration.task_title, acceptance_criteria: configuration.acceptance_criteria },
    project: { id: configuration.project_id }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace] }, artifacts: { expected: [] } };
  const prepare = (runId, changedPack = pack, header = `# Context Pack context_${runId}\ntask: ${changedPack.task.id}\nrun: ${runId}`) => {
    const source = `${header}\n\n## Task\ndescription: A fake run: not_the_identity\n\n## Raw Payload\n${JSON.stringify(changedPack, null, 2)}\n`;
    const path = join(directory, `context-${hash(runId)}.md`); writeFileSync(path, source); return { path, source, runId, pack: changedPack };
  };
  const execute = (input, cwd = workspace) => spawnSync(process.execPath, [executable, input.path, configurationPath], { cwd, env: {}, encoding: "utf8", timeout: 5000 });
  const launch = (input) => {
    const child = spawn(process.execPath, [executable, input.path, configurationPath], { cwd: workspace, env: {}, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (b) => { stdout += b; }); child.stderr.on("data", (b) => { stderr += b; });
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr })); });
    children.push({ child, closed }); return { child, closed };
  };
  return { directory, base, workspace, receipts, configuration, pack, head, index, git, prepare, execute, launch };
}
const launches = (s) => readdirSync(s.receipts).filter((name) => name.startsWith("launch-")).map((name) => JSON.parse(readFileSync(join(s.receipts, name))));
const receipt = (s, runId) => JSON.parse(readFileSync(zeroArtifactReceiptPath(s.receipts, runId)));
function assertUntouchedBase(s) {
  assert.equal(s.git(s.base, "rev-parse", "HEAD"), s.head);
  assert.equal(s.git(s.base, "status", "--porcelain", "--untracked-files=all", "--ignored"), "");
  assert.equal(readFileSync(join(s.base, "implementation.txt"), "utf8"), baseline);
  assert.deepEqual(readFileSync(join(s.base, ".git", "index")), s.index);
}

test("one real successful child leaves exact modified/new/ignored bytes with no report or artifact frame", (t) => {
  const s = setup(t), input = s.prepare("run_zero"), child = s.execute(input);
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null);
  const record = receipt(s, input.runId), expected = zeroArtifactWork(s.pack, input.runId, hash(input.source));
  assert.equal(record.pid, child.pid); assert.equal(record.task_id, s.pack.task.id); assert.equal(record.run_id, input.runId);
  assert.equal(record.workspace_root, s.workspace); assert.equal(record.context_sha256, hash(input.source));
  assert.deepEqual(record.artifact_filenames, []);
  assert.deepEqual(readFileSync(zeroArtifactContextPath(s.receipts, input.runId)), Buffer.from(input.source));
  for (const filename of ZERO_ARTIFACT_FILES) {
    const bytes = readFileSync(join(s.workspace, filename)); assert.deepEqual(bytes, expected[filename]);
    assert.deepEqual(record.files[filename], { sha256: hash(bytes), size: bytes.length });
  }
  assert.equal(existsSync(join(s.workspace, "changes.patch")), false);
  assert.equal(s.git(s.workspace, "check-ignore", "--", "ignored.bin").trim(), "ignored.bin");
  assert.equal(s.git(s.workspace, "status", "--porcelain", "--untracked-files=all", "--ignored"), " M implementation.txt\n?? unuploaded.txt\n!! ignored.bin\n");
  assert.equal(s.git(s.workspace, "branch", "--show-current").trim(), "artoo/zero-artifact-fixture");
  assert.equal(s.git(s.workspace, "rev-parse", "HEAD"), s.head);
  const frames = child.stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(frames.map((f) => f.type), ["thread.started", "item.completed", "turn.completed"]);
  assert.ok(frames.every((f) => f.type !== "artifact.created"));
  assert.equal(launches(s).length, 1); assert.equal(launches(s)[0].pid, child.pid);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  assertUntouchedBase(s);
});

for (const [name, mutate, header] of [
  ["wrong project", (p) => { p.project.id = "other_project"; }],
  ["wrong title", (p) => { p.task.title = "other task"; }],
  ["changed criteria", (p) => { p.task.acceptance_criteria = []; }],
  ["wrong root", (p) => { p.workspace.root += "-other"; }],
  ["broader scope", (p) => { p.policy.filesystem_write_scope = ["/"]; }],
  ["discussion mode", (p) => { p.policy.execution_mode = "discussion"; }],
  ["old review context", (p) => { p.review_feedback = { version: 1, entries: [] }; }],
  ["two header run IDs", () => {}, "# Context Pack ctx\ntask: task_zero\nrun: run_a\nrun: run_b"],
  ["mismatched task header", () => {}, "# Context Pack ctx\ntask: other_task\nrun: run_zero"],
]) test(`rejects ${name} before writing work; records the actual failed invocation`, (t) => {
  const s = setup(t), changed = structuredClone(s.pack); mutate(changed);
  const result = s.execute(s.prepare("run_bad", changed, header));
  assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); assert.equal(launches(s).length, 1);
  assert.equal(readFileSync(join(s.workspace, "implementation.txt"), "utf8"), baseline);
  for (const filename of ["unuploaded.txt", "ignored.bin", "changes.patch"]) assert.equal(existsSync(join(s.workspace, filename)), false);
  assert.equal(readdirSync(s.receipts).filter((name) => !name.startsWith("launch-")).length, 0);
  assertUntouchedBase(s);
});

test("reusing the successful workspace with the same or a different run cannot overwrite previous evidence", (t) => {
  const s = setup(t), input = s.prepare("run_zero"); assert.equal(s.execute(input).status, 0);
  const paths = [...ZERO_ARTIFACT_FILES.map((name) => join(s.workspace, name)), zeroArtifactReceiptPath(s.receipts, input.runId), zeroArtifactContextPath(s.receipts, input.runId)];
  const before = paths.map((path) => readFileSync(path));
  for (const runId of [input.runId, "run_other"]) {
    const result = s.execute(s.prepare(runId)); assert.notEqual(result.status, 0); assert.equal(result.stdout, "");
    assert.deepEqual(paths.map((path) => readFileSync(path)), before);
  }
  assert.equal(launches(s).length, 3); assert.equal(existsSync(zeroArtifactReceiptPath(s.receipts, "run_other")), false);
  assertUntouchedBase(s);
});

test("concurrent distinct run IDs produce one owned success and two visible process launches", async (t) => {
  const s = setup(t), inputs = [s.prepare("run_a"), s.prepare("run_b")];
  const children = inputs.map((input) => s.launch(input));
  const results = await Promise.all(children.map((item) => item.closed));
  assert.deepEqual(results.map((r) => r.status).sort(), [0, 1]);
  const winner = results.findIndex((r) => r.status === 0), record = receipt(s, inputs[winner].runId);
  assert.equal(record.pid, children[winner].child.pid); assert.equal(launches(s).length, 2);
  assert.equal(readdirSync(s.receipts).filter((name) => name.startsWith("run-")).length, 1);
  for (const filename of ZERO_ARTIFACT_FILES) assert.equal(hash(readFileSync(join(s.workspace, filename))), record.files[filename].sha256);
  assert.equal(readdirSync(s.receipts).filter((name) => name.endsWith(".tmp")).length, 0);
  assertUntouchedBase(s);
});
