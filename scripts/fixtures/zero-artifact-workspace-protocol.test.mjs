import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createZeroArtifactWorkspaceScenario, verifyZeroArtifactWorkspace } from "./zero-artifact-workspace-scenario.mjs";
import { zeroArtifactHash as hash } from "./zero-artifact-workspace.mjs";

// This test intentionally makes product mutations through authenticated HTTP.
// It is protocol/Git/process integration, never installed-client UI evidence.
const root = fileURLToPath(new URL("../../", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(75); }
  throw new Error(message);
}
function copiedInputs() {
  const files = [];
  const collect = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name); assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) collect(full);
      else files.push({ path: relative(root, full), sha256: hash(readFileSync(full)) });
    }
  };
  for (const directory of ["apps/server", "apps/artood", "packages/domain", "packages/protocol", "packages/db", "packages/storage", "packages/node-supervisor", "packages/testkit"]) {
    collect(join(root, directory, "src")); collect(join(root, directory, "dist"));
    for (const name of ["package.json", "tsconfig.json"]) files.push({ path: `${directory}/${name}`, sha256: hash(readFileSync(join(root, directory, name))) });
  }
  collect(join(root, "packages/db/migrations"));
  for (const path of ["package.json", "package-lock.json", "tsconfig.base.json", "scripts/fixtures/zero-artifact-workspace.mjs",
    "scripts/fixtures/zero-artifact-workspace-scenario.mjs", "scripts/fixtures/zero-artifact-workspace-protocol.test.mjs"]) files.push({ path, sha256: hash(readFileSync(join(root, path))) });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { scope: "Direct copied source/build/runtime and lockfile hashes; no inherited parent Git attribution", files, sha256: hash(JSON.stringify(files)), node: process.version };
}

test("one successful zero-artifact run keeps every local work byte with durable retention before completion", { timeout: 90_000 }, async (t) => {
  assert.ok(!process.env.DATABASE_URL && !process.env.ARTOO_DATABASE_URL, "This fixture must use its disposable local database");
  const input = copiedInputs();
  const evidence = process.env.ARTOO_ZERO_ARTIFACT_EVIDENCE_DIR ? resolve(process.env.ARTOO_ZERO_ARTIFACT_EVIDENCE_DIR) : null;
  if (evidence) {
    const inside = relative(root, evidence); assert.ok(inside && !isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`));
    assert.equal(existsSync(evidence), false); mkdirSync(evidence, { recursive: true, mode: 0o700 });
  }
  const temporary = mkdtempSync(join(tmpdir(), "artoo-zero-artifact-integration-"));
  const exportParent = evidence ?? realpathSync(mkdtempSync(join(tmpdir(), "artoo-zero-artifact-proof-")));
  const report = { passed: false, started_at: new Date().toISOString(), input,
    scope: "Authenticated loopback HTTP/WebSocket with production server/node and real Git/owned subprocess; NOT client UI/E2E", cleanup: {} };
  let server, scenario, exported, primaryError;
  try {
    const { startServer } = await import(pathToFileURL(join(root, "apps/server/dist/main.js")).href);
    const { createSession } = await import(pathToFileURL(join(root, "apps/server/dist/auth/auth-service.js")).href);
    const workspace = join(temporary, "workspace"); mkdirSync(workspace);
    server = await startServer({ NODE_ENV: "production", ARTOO_HOST: "127.0.0.1", ARTOO_PORT: "0", ARTOO_DATA_DIR: join(temporary, "server-data"),
      ARTOO_WORKSPACE_ROOT: workspace, ARTOO_PAIRING_PEPPER: randomBytes(32).toString("hex"), GOOGLE_CLIENT_ID: "zero-artifact-integration",
      GOOGLE_CLIENT_SECRET: "unused-local-integration", GOOGLE_REDIRECT_URI: "http://localhost/auth/google/callback",
      AUTH_ALLOWED_EMAILS: "owner@zero-artifact.test", AUTH_OWNER_EMAILS: "owner@zero-artifact.test" });
    const origin = `http://127.0.0.1:${server.app.server.address().port}`;
    const owner = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
    const request = async (path, body) => {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { Authorization: `Bearer ${owner.raw}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
      assert.ok(response.ok, `${path}: HTTP ${response.status}`); return response.json();
    };
    scenario = await createZeroArtifactWorkspaceScenario({ root, temporary, projectId: "proj_artoo", suffix: randomUUID().slice(0, 8), request, origin, until });
    const { fields } = scenario;
    const task = (await request("/api/v1/tasks", { project_id: fields.project_id, title: fields.task_title,
      acceptance_criteria: fields.acceptance_criteria, required_capabilities: ["code.modify"] })).task;
    const taskPath = `/api/v1/tasks/${task.id}`;
    await request(`${taskPath}/ready`, {});
    const approval = (await request(`${taskPath}/execution-approval`, { summary: fields.approval_summary, risk: "high" })).approval;
    await request(`/api/v1/approvals/${approval.id}/resolve`, { decision: "approved" });
    await request(`${taskPath}/assign`, { mode: "manual", agent_instance_id: fields.instance_id, branch_backed: true });
    await until(async () => (await request(taskPath)).task.status === "review", "Zero-artifact task did not reach review");
    const observation = await scenario.observe(), expected = { ...scenario, observation };
    report.result = verifyZeroArtifactWorkspace(expected);
    assert.deepEqual(report.result.counts, { tasks: 1, runs: 1, launches: 1, approvals: 1, reviews: 0, artifacts: 0, retained_worktrees: 1, live_owned_processes: 0 });
    assert.throws(() => scenario.exportEvidence(join(temporary, "must-not-be-exported"), observation));
    assert.equal(existsSync(join(temporary, "must-not-be-exported")), false);
    const ignored = join(fields.workspace_root, "ignored.bin"), backup = join(fields.workspace_root, "ignored.backup");
    const refused = join(exportParent, "refused-symlink");
    renameSync(ignored, backup);
    try {
      symlinkSync(backup, ignored);
      assert.throws(() => scenario.exportEvidence(refused, observation), /original regular workspace files/);
      assert.equal(existsSync(refused), false);
    } finally { rmSync(ignored, { force: true }); renameSync(backup, ignored); }
    exported = scenario.exportEvidence(join(exportParent, "retained-workspace"), observation); report.exported = exported;
    assert.equal(exported.files.length, 4);
    if (evidence) writeFileSync(join(evidence, "observation.json"), JSON.stringify({ fields, configuration: scenario.configuration,
      baseHead: scenario.baseHead, baseIndex: scenario.baseIndex, baseRepo: scenario.baseRepo, baseCommonDirectory: scenario.baseCommonDirectory, observation }, null, 2) + "\n", { mode: 0o600 });
    const mutations = [
      ["uploaded artifact despite zero-artifact intent", (v) => { v.snapshot.artifacts.push({ id: "unwanted_artifact" }); }],
      ["fabricated artifact event", (v) => { v.bundle.events.push({ type: "artifact.created" }); }],
      ["successful status without retention", (v) => { v.bundle.events = v.bundle.events.filter((event) => event.type !== "run.workspace.retained"); }],
      ["changed ignored bytes", (v) => { v.workspace.files["ignored.bin"].sha256 = "0".repeat(64); }],
      ["consistently falsified new-file hashes", (v) => { v.workspace.files["unuploaded.txt"].sha256 = "0".repeat(64); v.receipts[0].files["unuploaded.txt"].sha256 = "0".repeat(64); }],
      ["duplicate actual launch", (v) => { v.launches.push(v.launches[0]); }],
      ["process remains alive", (v) => { v.live_pids.push(v.receipts[0].pid); }],
      ["modified source checkout", (v) => { v.base.status = " M implementation.txt\n"; }],
      ["removed worktree registration", (v) => { v.base.registrations = v.base.registrations.split("\n\n")[0]; }],
      ["wrong reporter identity", (v) => { v.bundle.events.find((event) => event.type === "run.workspace.retained").payload.reporter_computer_id = "wrong_computer"; }],
      ["retention after completed", (v) => { v.bundle.events.find((event) => event.type === "run.workspace.retained").position = v.bundle.events.find((event) => event.type === "run.completed").position + 1; }],
      ["historical GET projection missing", (v) => { v.run_reads[0].workspace_retention = null; }],
      ["foreign system actor", (v) => { v.bundle.events.find((event) => event.type === "run.workspace.retained").actor.id = "foreign_computer"; }],
      ["foreign event organization", (v) => { v.bundle.events.find((event) => event.type === "run.workspace.retained").organization_id = "foreign_org"; }],
      ["foreign event correlation", (v) => { v.bundle.events.find((event) => event.type === "run.workspace.retained").correlation_id = "foreign_task"; }],
      ["fractional sequence", (v) => { v.bundle.events.find((event) => event.type === "run.workspace.retained").sequence += 0.5; }],
      ["negative event position", (v) => { v.bundle.events.find((event) => event.type === "run.workspace.retained").position = -1; }],
      ["unrelated base branch", (v) => { v.base.branch = "foreign-base"; }],
      ["additional branch ref", (v) => { v.base.refs.push("refs/heads/foreign"); }],
      ["substituted base registration", (v) => { v.base.registrations = v.base.registrations.replace("branch refs/heads/fixture-base", "branch refs/heads/foreign-base"); }],
      ["missing started lifecycle", (v) => { v.bundle.events = v.bundle.events.filter((event) => event.type !== "run.started"); }],
      ["additional failed lifecycle", (v) => { v.bundle.events.push({ type: "run.failed", run_id: v.snapshot.runs[0].id }); }],
    ];
    for (const [name, mutate] of mutations) {
      let mutationError;
      await t.test(`rejects ${name}`, () => {
        try {
          const changed = structuredClone(observation); mutate(changed);
          assert.throws(() => verifyZeroArtifactWorkspace({ ...scenario, observation: changed }));
        } catch (error) { mutationError = error; throw error; }
      });
      if (mutationError) throw mutationError;
    }
    report.negative_mutations = mutations.length; report.export_guards = { disposable_destination_rejected: true, symlink_source_rejected_before_copy: true };
  } catch (error) { primaryError = error; report.failure = error.message; }
  finally {
    const failures = [];
    const attempt = async (key, operation) => {
      try { await operation(); report.cleanup[key] = true; }
      catch (error) { report.cleanup[key] = false; failures.push(error); }
    };
    await attempt("fixture_closed", () => scenario?.close());
    await attempt("server_closed", () => server?.close());
    if (report.cleanup.fixture_closed && report.cleanup.server_closed) await attempt("temporary_directory_removed", () => {
      rmSync(temporary, { recursive: true, force: true }); assert.equal(existsSync(temporary), false);
    });
    else { report.cleanup.temporary_directory_removed = false; report.retained_failure_temporary = temporary; }
    if (exported) await attempt("exported_copy_verified_after_cleanup", () => {
      assert.equal(report.cleanup.temporary_directory_removed, true);
      for (const file of exported.files) { const bytes = readFileSync(file.copied); assert.equal(hash(bytes), file.sha256); assert.equal(bytes.length, file.size); }
    });
    try {
      report.input_at_finish = copiedInputs(); report.source_stable = report.input.sha256 === report.input_at_finish.sha256;
      assert.equal(report.source_stable, true);
    } catch (error) { report.source_stable = false; failures.push(error); }
    if (!evidence) await attempt("ephemeral_export_removed", () => rmSync(exportParent, { recursive: true, force: true }));
    report.cleanup_errors = failures.map((error) => error.message);
    report.passed = !primaryError && failures.length === 0 && report.result?.passed === true && report.source_stable === true
      && ["fixture_closed", "server_closed", "temporary_directory_removed", "exported_copy_verified_after_cleanup"].every((key) => report.cleanup[key] === true);
    report.finished_at = new Date().toISOString();
    if (evidence) writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    if (primaryError || failures.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...failures], "Zero-artifact integration or finalization failed");
    assert.equal(report.passed, true);
  }
});
