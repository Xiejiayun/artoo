import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createZeroArtifactWorkspaceSetup } from "../../../scripts/fixtures/zero-artifact-workspace-scenario.mjs";
import { ZERO_ARTIFACT_FILES, zeroArtifactHash } from "../../../scripts/fixtures/zero-artifact-workspace.mjs";
import { writeE2EReport } from "../../../scripts/e2e-report.mjs";
import { assertMacZeroArtifactCommands, assertMacZeroArtifactScreenshots, captureMacZeroArtifactScreenshot,
  macZeroArtifactImageNames } from "./installed-mac-zero-artifact.mjs";

const fixture = { project_id: "p", task_title: "Zero report", acceptance_criteria: ["Retain local work"], approval_summary: "One approved run" };
const input = () => ({ fixture, taskId: "task", approvalId: "approval", instanceId: "installed-instance", commands: [
  { method: "POST", path: "/api/v1/tasks", status: 201, body: { project_id: fixture.project_id, title: fixture.task_title,
    acceptance_criteria: fixture.acceptance_criteria, required_capabilities: ["code.modify"] } },
  { method: "POST", path: "/api/v1/tasks/task/ready", status: 200, body: {} },
  { method: "POST", path: "/api/v1/tasks/task/execution-approval", status: 201, body: { summary: fixture.approval_summary } },
  { method: "POST", path: "/api/v1/approvals/approval/resolve", status: 200, body: { decision: "approved" } },
  { method: "POST", path: "/api/v1/tasks/task/assign", status: 200, body: { mode: "manual", agent_instance_id: "installed-instance", branch_backed: true } },
] });

test("one separate UI task has exactly one approval and assignment, with no review/retry/Stop substitute", () => {
  const good = input(); assertMacZeroArtifactCommands(good);
  for (const mutate of [
    (value) => { value.commands.push({ method: "POST", path: "/api/v1/tasks/task/review", status: 200 }); },
    (value) => { value.commands.pop(); },
    (value) => { value.commands[4].body.agent_instance_id = "helper-node-instance"; },
    (value) => { value.commands[4].body.branch_backed = false; },
    (value) => { value.commands[3].body.decision = "rejected"; },
    (value) => { value.commands[1].path = "/api/v1/tasks/other/ready"; },
    (value) => { value.commands[2].body.summary = "different request"; },
    (value) => { value.commands[4].status = 403; },
  ]) { const changed = structuredClone(good); mutate(changed); assert.throws(() => assertMacZeroArtifactCommands(changed)); }
});

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), "artoo-mac-zero-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}

test("all five real-capture names are mandatory and earlier original bytes survive a later capture failure", async (t) => {
  const root = temporary(t), evidence = { screenshots: [] };
  // Synthetic PNG only for the evidence plumbing unit test; no UI certification.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8KuTxn4GBgYGJAQoAI8UCUpBcPuMAAAAASUVORK5CYII=", "base64");
  const snapshot = async (filename, caption) => { const path = join(root, filename); writeFileSync(path, png); return { path, caption }; };
  await captureMacZeroArtifactScreenshot(snapshot, { filename: macZeroArtifactImageNames[0], caption: "Synthetic unit screenshot", evidence });
  await assert.rejects(captureMacZeroArtifactScreenshot(async () => { throw new Error("later failure"); },
    { filename: macZeroArtifactImageNames[1], caption: "Synthetic failure", evidence }), /later failure/);
  assert.equal(evidence.screenshots.length, 1);
  const html = writeE2EReport({ outputPath: join(root, "failed.html"), title: "Synthetic zero-artifact evidence test",
    report: { passed: false, scope: "Unit data only, no installed app" }, screenshots: evidence.screenshots });
  assert.ok(readFileSync(html, "utf8").includes(png.toString("base64")));
  const complete = macZeroArtifactImageNames.map((name) => ({ path: join(root, name) }));
  assertMacZeroArtifactScreenshots(complete);
  for (let index = 0; index < complete.length; index++) {
    assert.throws(() => assertMacZeroArtifactScreenshots(complete.filter((_, i) => i !== index)));
  }
  await assert.rejects(captureMacZeroArtifactScreenshot(snapshot, { filename: "../unapproved.png", caption: "Rejected", evidence }));
});

function prepareEmbeddedFixture(t) {
  const root = temporary(t), setup = createZeroArtifactWorkspaceSetup({ temporary: root, projectId: "p", suffix: "route", runtimeId: "codex" });
  const git = spawnSync("git", ["-C", setup.baseRepo, "worktree", "add", "-b", "artoo/run-route", setup.fields.workspace_root], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  const pack = { task: { id: "task-route", title: setup.fields.task_title, acceptance_criteria: setup.fields.acceptance_criteria },
    project: { id: "p" }, workspace: { root: setup.fields.workspace_root },
    policy: { filesystem_write_scope: [setup.fields.workspace_root] }, artifacts: { expected: [] } };
  writeFileSync(join(setup.fields.workspace_root, "context_pack.md"), `# Context Pack ctx-route\ntask: task-route\nrun: run-route\n\n## Raw Payload\n${JSON.stringify(pack)}`);
  const source = readFileSync(new URL("./packaged-e2e-smoke.mjs", import.meta.url), "utf8");
  const start = source.indexOf("writeFileSync(fixtureEntry, `"), end = source.indexOf("\n`);", start) + "\n`);".length;
  assert.ok(start >= 0 && end > start);
  const fixtureEntry = join(root, "installed-fixture.mjs"), desktopDir = fileURLToPath(new URL("../", import.meta.url)), repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  new Function("writeFileSync", "fixtureEntry", "fixtureKey", "isMac", "pathToFileURL", "join", "desktopDir", "repoRoot",
    "planningConfigurationPath", "assistantConfigurationPath", "correctionConfigurationPath", "zeroArtifactConfigurationPath", "fixturePatch", source.slice(start, end))(
    writeFileSync, fixtureEntry, "unit-key", true, pathToFileURL, join, desktopDir, repoRoot,
    join(root, "unused-planning.json"), join(root, "unused-assistant.json"), join(root, "unused-correction.json"), setup.configurationPath, "must-not-fabricate-a-report");
  return { setup, fixtureEntry };
}

test("the installed CLI routing executes the separate real child without fabricating changes.patch", (t) => {
  const { setup, fixtureEntry } = prepareEmbeddedFixture(t);
  const child = spawnSync(process.execPath, [fixtureEntry], { cwd: setup.fields.workspace_root,
    env: { ARTOO_CODEX_PROVIDER_KEY: "unit-key", ARTOO_REPORT_ARTIFACTS: "none" }, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null);
  assert.deepEqual(child.stdout.trim().split("\n").map((line) => JSON.parse(line).type), ["thread.started", "item.completed", "turn.completed"]);
  assert.equal(existsSync(join(setup.fields.workspace_root, "changes.patch")), false);
  assert.equal(existsSync(join(setup.fields.workspace_root, "fixture-execution.json")), false);
  const receipts = readdirSync(setup.receipts).filter((name) => name.startsWith("run-")); assert.equal(receipts.length, 1);
  const receipt = JSON.parse(readFileSync(join(setup.receipts, receipts[0]))); assert.equal(receipt.pid, child.pid);
  assert.deepEqual(receipt.artifact_filenames, []);
  for (const name of ZERO_ARTIFACT_FILES) assert.equal(zeroArtifactHash(readFileSync(join(setup.fields.workspace_root, name))), receipt.files[name].sha256);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("the installed zero-artifact route refuses the default report-collecting worker before modifying work", (t) => {
  const { setup, fixtureEntry } = prepareEmbeddedFixture(t);
  const before = readFileSync(join(setup.fields.workspace_root, "implementation.txt"));
  const child = spawnSync(process.execPath, [fixtureEntry], { cwd: setup.fields.workspace_root,
    env: { ARTOO_CODEX_PROVIDER_KEY: "unit-key" }, encoding: "utf8", timeout: 10_000 });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /disable report collection explicitly/);
  assert.equal(child.stdout, ""); assert.deepEqual(readdirSync(setup.receipts), []);
  assert.deepEqual(readFileSync(join(setup.fields.workspace_root, "implementation.txt")), before);
  assert.equal(existsSync(join(setup.fields.workspace_root, "changes.patch")), false);
});
