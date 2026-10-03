import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createCorrectionFixture } from "../ios-ui-correction-fixture.mjs";
import { verifyCorrectionResults } from "./execution-correction-results.mjs";
import { correctionHash } from "./execution-correction.mjs";
import { exportCorrectionWorkspaceEvidence } from "./execution-correction-scenario.mjs";

// Production protocol integration and evidence-validator regressions. Commands
// in this test intentionally use HTTP. It is not client UI/E2E certification.
const root = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(100); }
  throw new Error(message);
}

// This copy may live inside an ignored parent repository. Do not let Git walk
// upward and falsely label the copied implementation as the parent's source.
function copiedInputs() {
  const files = [];
  const collect = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      assert.ok(!entry.isSymbolicLink(), "Execution input trees must not escape through symlinks");
      if (entry.isDirectory()) collect(full);
      else files.push({ path: relative(root, full), sha256: correctionHash(readFileSync(full)) });
    }
  };
  const packages = ["apps/server", "apps/artood", "packages/domain", "packages/protocol", "packages/db", "packages/storage", "packages/node-supervisor", "packages/testkit"];
  for (const item of packages) {
    collect(join(root, item, "src")); collect(join(root, item, "dist"));
    for (const name of ["package.json", "tsconfig.json"]) files.push({ path: `${item}/${name}`, sha256: correctionHash(readFileSync(join(root, item, name))) });
  }
  collect(join(root, "packages/db/migrations"));
  for (const name of ["package.json", "package-lock.json", "tsconfig.base.json", "scripts/ios-ui-correction-fixture.mjs",
    "scripts/fixtures/execution-correction.mjs", "scripts/fixtures/execution-correction-scenario.mjs",
    "scripts/fixtures/execution-correction-results.mjs", "scripts/fixtures/execution-correction-results.test.mjs",
    "scripts/fixtures/git-worktree-evidence.mjs"]) {
    files.push({ path: name, sha256: correctionHash(readFileSync(join(root, name))) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { scope: "Direct hashes of copied runtime source, built dist, SQL migrations, fixture scripts and dependency lock; no Git-discovered source claim",
    files, sha256: correctionHash(JSON.stringify(files)), node: process.version, executable: process.execPath };
}

function patchCheckpoints() {
  return [".verification/server-domain-start-ack-recovery/server-domain-revised.patch", "../artood-evidence/artood-retention.patch",
    process.env.ARTOO_CORRECTION_PATCH_CHECKPOINT ?? ".verification/correction-retention/fixture-retention.patch"].flatMap((name) => {
    const path = resolve(root, name); return existsSync(path) ? [{ path, sha256: correctionHash(readFileSync(path)) }] : [];
  });
}

test("actual four-run protocol produces verifiable correction evidence and rejects altered evidence", { timeout: 120_000 }, async (t) => {
  const input = copiedInputs();
  const evidenceDirectory = process.env.ARTOO_CORRECTION_EVIDENCE_DIR ? resolve(process.env.ARTOO_CORRECTION_EVIDENCE_DIR) : null;
  if (evidenceDirectory) {
    const inside = relative(root, evidenceDirectory);
    assert.ok(inside && !isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`), "Evidence must stay inside this tested repository copy");
    assert.equal(existsSync(evidenceDirectory), false, "Use a fresh evidence directory"); mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  }
  const temporary = mkdtempSync(join(tmpdir(), "artoo-correction-integration-"));
  const report = { passed: false, scope: "Authenticated loopback HTTP/WebSocket, real Git and owned deterministic subprocess protocol integration; NOT client UI/E2E certification",
    started_at: new Date().toISOString(), input, patch_checkpoints: patchCheckpoints(),
    patch_note: "Checkpoint patches describe preparation; the direct copied source/build hashes above identify executed bytes", temporary };
  let server, fixture, exported;
  try {
    const { startServer } = await import(pathToFileURL(join(root, "apps/server/dist/main.js")).href);
    const { createSession } = await import(pathToFileURL(join(root, "apps/server/dist/auth/auth-service.js")).href);
    const workspace = join(temporary, "workspace"); mkdirSync(workspace);
    server = await startServer({ NODE_ENV: "production", ARTOO_HOST: "127.0.0.1", ARTOO_PORT: "0",
      ARTOO_DATA_DIR: join(temporary, "server-data"), ARTOO_WORKSPACE_ROOT: workspace,
      ARTOO_PAIRING_PEPPER: randomBytes(32).toString("hex"),
      GOOGLE_CLIENT_ID: "correction-integration", GOOGLE_CLIENT_SECRET: "unused-local-integration",
      GOOGLE_REDIRECT_URI: "http://localhost/auth/google/callback",
      AUTH_ALLOWED_EMAILS: "owner@correction.test", AUTH_OWNER_EMAILS: "owner@correction.test" });
    const origin = `http://127.0.0.1:${server.app.server.address().port}`;
    const owner = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
    const request = async (path, body, token = owner.raw) => {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
      assert.ok(response.ok, `${path}: HTTP ${response.status}`); return response.json();
    };
    fixture = await createCorrectionFixture({ root, temporary, origin, server, projectId: "proj_artoo",
      userId: "user_owner", peerToken: owner.raw, suffix: randomUUID().slice(0, 8), request, until });
    const { fields, scenario } = fixture;
    assert.equal(Object.hasOwn(fields, "simulator_udid"), false, "Protocol-only fixtures must not invent a simulator binding");
    assert.deepEqual(fixture.clipboardEvidence(), [], "Protocol-only fixtures have no native clipboard evidence");
    for (const operation of ["seed", "read", "clear"]) {
      const response = await fetch(`${fields.fixture_control_url}/clipboard/${operation}`, { method: "POST",
        headers: { Authorization: `Bearer ${fields.fixture_control_token}`, "Content-Type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 404, "Protocol-only controls must expose no simulator clipboard routes");
    }
    const pairing = await request("/api/v1/devices/pairings", { intended_platform: "ios" });
    const peer = await request("/api/v1/devices/claim", { code: pairing.code, platform: "ios",
      display_name: fields.native_device_name, app_version: "protocol-integration" });
    const command = (path, body) => request(path, body, peer.control_token);
    const task = (await command("/api/v1/tasks", { project_id: fields.project_id, title: fields.task_title,
      acceptance_criteria: [fields.criterion_1, fields.criterion_2], required_capabilities: ["code.modify"] })).task;
    const path = `/api/v1/tasks/${task.id}`;
    await command(`${path}/ready`, {});
    const assign = async (index) => {
      const approval = (await command(`${path}/execution-approval`, { summary: fields.approval_summaries[index], risk: "high" })).approval;
      await command(`/api/v1/approvals/${approval.id}/resolve`, { decision: "approved" });
      return command(`${path}/assign`, { mode: "manual", agent_instance_id: fields.instances[index].id, branch_backed: true });
    };
    const review = async (index) => {
      const before = await request(path);
      await command(`${path}/review`, { outcome: "changes_requested", comment: fields[`review_comment_${index}`], base_version: before.version_cursor });
    };
    await assign(0); await scenario.waitForCheckpoint("initial", 15_000);
    await review(1); await scenario.checkpoint("changes_requested");
    await assign(1); await scenario.waitForCheckpoint("failed", 15_000);
    await command(`${path}/retry`, {}); await scenario.checkpoint("retried");
    await assign(2); await scenario.waitForCheckpoint("corrected", 15_000);
    await review(2); await scenario.checkpoint("changes_requested_again");
    await assign(3); await scenario.waitForCheckpoint("holding", 15_000);
    const refusedExport = join(temporary, "refused-live-export");
    assert.throws(() => exportCorrectionWorkspaceEvidence({ setup: fixture.setup, destination: refusedExport }), /Stop owned writers/);
    assert.equal(existsSync(refusedExport), false);
    const before = await scenario.checkpoint("keep_running_before");
    await sleep(3150); await scenario.checkpoint("keep_running_after");
    const run = before.observation.receipts.find((receipt) => receipt.slot === 4);
    await command(`/api/v1/runs/${run.run_id}/cancel`, {});
    await scenario.waitForCheckpoint("stopped", 15_000);
    await sleep(3150); await scenario.checkpoint("stopped_stable");
    const original = { fields: scenario.fields, configuration: fixture.setup.configuration,
      baseHead: fixture.setup.baseHead, checkpoints: scenario.evidence(), final: await scenario.observe() };
    const verified = verifyCorrectionResults(original);
    assert.equal(verified.passed, true);
    assert.deepEqual(verified.counts, { runs: 4, launches: 4, approvals: 4, reviews: 2, artifacts: 2, retained_worktrees: 4, live_owned_processes: 0 });
    assert.equal(verified.cancellation.attempts.length, 1);
    exported = exportCorrectionWorkspaceEvidence({ setup: fixture.setup, destination: join(evidenceDirectory ?? temporary, "retained-workspaces") });
    assert.equal(exported.files.length, 18); assert.equal(exported.files.filter((file) => file.source.endsWith("ignored.bin")).length, 4);
    if (evidenceDirectory) {
      const { fixture_control_token: _token, fixture_control_url: _url, ...safeFields } = original.fields;
      writeFileSync(join(evidenceDirectory, "observations.json"), JSON.stringify({ ...original, fields: safeFields }, null, 2) + "\n", { mode: 0o600 });
    }
    report.result = { ...verified, scope: report.scope }; report.exported = exported;
    const all = (value, mutate) => { for (const entry of value.checkpoints) mutate(entry.observation); mutate(value.final); };
    const runAt = (observation, slot = 1) => observation.snapshot.runs.find((run) => run.id === observation.receipts.find((receipt) => receipt.slot === slot)?.run_id);
    const retained = (observation, slot = 1) => observation.bundle.events.find((event) => event.type === "run.workspace.retained" && event.run_id === runAt(observation, slot)?.id);
    const syncProjection = (observation, event) => {
      for (const list of [observation.snapshot.runs, observation.bundle.runs, observation.run_reads]) {
        const run = list.find((item) => item.id === event.run_id);
        if (run) run.workspace_retention = { ...event.payload, event_id: event.id, position: event.position, sequence: event.sequence,
          reported_at: new Date(event.occurred_at).toISOString() };
      }
    };
    const mutations = [
      ["an omitted stable-state observation", (value) => value.checkpoints.splice(8, 1)],
      ["a stable window shorter than 3.1 seconds", (value) => { value.checkpoints[8].observation.started_ms = value.checkpoints[7].observation.finished_ms + 100; }],
      ["a duplicate real launch hidden behind its first receipt", (value) => all(value, (observation) => observation.launches.push(observation.launches[0]))],
      ["a changed retained implementation", (value) => all(value, (observation) => { if (observation.workspaces[1].exists) observation.workspaces[1].implementation_sha256 = "0".repeat(64); })],
      ["a fabricated later artifact in an earlier review", (value) => all(value, (observation) => { if (observation.snapshot.reviews[0]) observation.snapshot.reviews[0].artifact_ids.push("invented-artifact"); })],
      ["a substituted user comment", (value) => all(value, (observation) => { if (observation.snapshot.reviews[0]) observation.snapshot.reviews[0].comment = "substituted"; })],
      ["feedback from the wrong context event", (value) => { const context = value.final.contexts.find((context) => context.pack.review_feedback); context.pack.review_feedback.entries[0].event_id = "wrong-event"; }],
      ["cancel response before actual process exit", (value) => all(value, (observation) => { for (const attempt of observation.cancellation.attempts) attempt.process_alive_on_response = true; })],
      ["cancel from a different paired device", (value) => all(value, (observation) => { for (const attempt of observation.cancellation.attempts) attempt.device_id = "other-device"; })],
      ["changed authenticated artifact bytes", (value) => all(value, (observation) => { if (observation.artifact_bytes[0]) observation.artifact_bytes[0].text += "tampered"; })],
      ["invented provider cost", (value) => { value.final.usages.find((item) => item.usage).usage.cost_usd = 1; }],
      ["modified Git base", (value) => all(value, (observation) => { observation.base.status = " M implementation.txt"; })],
      ["a substituted context-pack identity", (value) => all(value, (observation) => { observation.snapshot.runs[0].context_pack_id = "wrong-context"; })],
      ["an unrelated scheduler decision", (value) => { value.final.bundle.scheduler_decisions[0].id = "wrong-decision"; }],
      ["another selected execution computer", (value) => { value.final.bundle.scheduler_decisions[0].selected_computer_id = "wrong-computer"; }],
      ["consistently fabricated artifact hashes", (value) => all(value, (observation) => {
        const receipt = observation.receipts.find((item) => item.slot === 1), artifact = observation.snapshot.artifacts.find((item) => item.run_id === receipt.run_id);
        receipt.artifact_sha256 = "1".repeat(64); artifact.checksum = `sha256:${receipt.artifact_sha256}`;
        const bytes = observation.artifact_bytes.find((item) => item.artifact_id === artifact.id);
        bytes.sha256 = receipt.artifact_sha256; bytes.source_report_sha256 = receipt.artifact_sha256;
      })],
      ["a future worktree created before assignment", (value) => { value.checkpoints[0].observation.workspaces[1].exists = true; }],
      ["an extra workspace evidence row", (value) => all(value, (observation) => observation.workspaces.push({ ...observation.workspaces[0] }))],
      ["removed successful work", (value) => all(value, (observation) => { observation.workspaces[0].exists = false; })],
      ["changed unuploaded successful work", (value) => all(value, (observation) => { observation.workspaces[0].unsaved_sha256 = "0".repeat(64); })],
      ["changed ignored successful bytes", (value) => all(value, (observation) => { observation.workspaces[0].ignored_sha256 = "0".repeat(64); })],
      ["consistently substituted ignored receipt and observed hashes", (value) => all(value, (observation) => {
        observation.receipts.find((receipt) => receipt.slot === 1).ignored_sha256 = "0".repeat(64);
        observation.workspaces[0].ignored_sha256 = "0".repeat(64);
      })],
      ["an ignored file no longer ignored by Git", (value) => all(value, (observation) => { observation.workspaces[0].ignored_by_git = false; })],
      ["ignored bytes becoming tracked", (value) => all(value, (observation) => { observation.workspaces[0].status = observation.workspaces[0].status.replace("!! ignored.bin", "A  ignored.bin"); })],
      ["a replacement repository with the same branch", (value) => all(value, (observation) => { observation.workspaces[0].common_directory = "/different/base/.git"; })],
      ["a missing worktree registration", (value) => all(value, (observation) => { observation.workspaces[0].registration = null; })],
      ["a wrong retained HEAD", (value) => all(value, (observation) => { observation.workspaces[0].head = "0".repeat(40); })],
      ["an unrelated registered worktree", (value) => all(value, (observation) => { observation.base.registrations.push({ root: "/extra", head: value.baseHead, branch: "refs/heads/extra" }); })],
      ["base changes hidden by a later restoration", (value) => { value.checkpoints[3].observation.base.tracked_files["implementation.txt"] = "0".repeat(64); }],
      ["a changed base index at an intermediate boundary", (value) => { value.checkpoints[3].observation.base.index_sha256 = "0".repeat(64); }],
      ["ignored execution debris in the base", (value) => all(value, (observation) => { observation.base.work_files["ignored.bin"] = "0".repeat(64); })],
      ["changed retained successful report bytes", (value) => all(value, (observation) => { observation.workspaces[0].report_sha256 = "0".repeat(64); })],
      ["a fabricated report in failed work", (value) => all(value, (observation) => { if (observation.workspaces[1].exists) observation.workspaces[1].report_sha256 = "0".repeat(64); })],
      ["omitted typed retention despite a legacy diagnostic", (value) => all(value, (observation) => {
        observation.bundle.events = observation.bundle.events.filter((event) => event.id !== retained(observation)?.id);
      })],
      ["duplicate typed retention", (value) => all(value, (observation) => { observation.bundle.events.push(structuredClone(retained(observation))); })],
      ["runtime output substituted for typed retention", (value) => all(value, (observation) => {
        const event = retained(observation); event.type = "run.output"; event.payload = { stream: "stderr", text: `Worktree retained for recovery: ${JSON.stringify(event.payload)}` };
      })],
      ...[
        ["wrong retained event task", (event) => { event.task_id = "wrong-task"; }],
        ["wrong retained event organization", (event) => { event.organization_id = "wrong-org"; }],
        ["runtime agent attribution for a worker report", (event) => { event.actor.type = "agent"; }],
        ["wrong reporter computer", (event) => { event.payload.reporter_computer_id = "wrong-computer"; }],
        ["wrong retention root", (event) => { event.payload.workspace_root = "/wrong-root"; }],
        ["wrong retention branch", (event) => { event.payload.workspace_branch = "wrong-branch"; }],
        ["unsupported report version", (event) => { event.payload.version = 2; }],
        ["incomplete delivery presented as a successful fixture outcome", (event) => { event.payload.outcome = "incomplete_delivery"; }],
      ].map(([name, mutate]) => [name, (value) => all(value, (observation) => { const event = retained(observation); mutate(event); syncProjection(observation, event); })]),
      ["a projection from a different event", (value) => all(value, (observation) => { observation.run_reads[0].workspace_retention.event_id = "wrong-event"; })],
      ["retention sequence after completed", (value) => all(value, (observation) => {
        const event = retained(observation); event.sequence = observation.bundle.events.find((item) => item.run_id === event.run_id && item.type === "run.completed").sequence + 1;
        syncProjection(observation, event);
      })],
      ["retention durable position after completed", (value) => all(value, (observation) => {
        const event = retained(observation); event.position = observation.bundle.events.find((item) => item.run_id === event.run_id && item.type === "run.completed").position + 1;
        syncProjection(observation, event);
      })],
      ["missing completed lifecycle with retention alone", (value) => all(value, (observation) => { observation.bundle.events = observation.bundle.events.filter((event) => event.run_id !== runAt(observation).id || event.type !== "run.completed"); })],
      ["a duplicate completed lifecycle", (value) => all(value, (observation) => { observation.bundle.events.push(structuredClone(observation.bundle.events.find((event) => event.run_id === runAt(observation).id && event.type === "run.completed"))); })],
      ["an older favorable projection after a delivery correction", (value) => all(value, (observation) => {
        const event = structuredClone(retained(observation)); event.id += "_correction"; event.position = Math.max(...observation.bundle.events.map((item) => item.position)) + 1;
        event.sequence += 100; event.payload.outcome = "incomplete_delivery"; observation.bundle.events.push(event);
      })],
      ["a malformed latest report hidden by an older completed one", (value) => all(value, (observation) => {
        const event = structuredClone(retained(observation)); event.id += "_malformed"; event.position = Math.max(...observation.bundle.events.map((item) => item.position)) + 1;
        event.sequence += 100; event.payload.exists_now = true; observation.bundle.events.push(event);
      })],
      ["rewritten historical retention after a later attempt", (value) => {
        const observation = value.checkpoints[4].observation, event = retained(observation); event.id += "_rewritten"; syncProjection(observation, event);
      }],
      ["lease evidence changed during the terminal stable window", (value) => {
        for (const observation of [value.checkpoints.at(-1).observation, value.final]) observation.leases.push({ id: "extra-lease", run_id: runAt(observation).id, status: "released", path: "extra" });
      }],
    ];
    const rejectedMutations = [];
    for (const [name, mutate] of mutations) await t.test(`rejects ${name}`, () => {
      const changed = structuredClone(original); mutate(changed);
      assert.throws(() => verifyCorrectionResults(changed), /Execution correction verification failed/);
      rejectedMutations.push(name);
    });
    assert.equal(rejectedMutations.length, mutations.length);
    // Validator-only counterfactual: the HTTP cancellation is allowed to settle
    // first, then the owning node reports retention and a reconciled lifecycle.
    // This is not substituted into the original production observation/export.
    const httpFirst = structuredClone(original);
    for (const observation of [...httpFirst.checkpoints.filter((item) => item.name.startsWith("stopped")).map((item) => item.observation), httpFirst.final]) {
      const held = runAt(observation, 4), event = retained(observation, 4);
      observation.bundle.events = observation.bundle.events.filter((item) => item.run_id !== held.id || item.type !== "run.reconciled");
      const terminal = observation.bundle.events.find((item) => item.run_id === held.id && item.type === "run.cancelled");
      const pivot = Math.min(event.position, terminal.position);
      for (const item of observation.bundle.events) if (item.position >= pivot) item.position++;
      terminal.position = pivot; terminal.sequence = null; terminal.actor = { type: "user", id: fields.user_id };
      const sequence = Math.max(...observation.bundle.events.filter((item) => item.run_id === held.id && Number.isSafeInteger(item.sequence)).map((item) => item.sequence)) + 1;
      observation.bundle.events.push({ ...structuredClone(terminal), id: `${terminal.id}_worker`, type: "run.reconciled",
        actor: { type: "agent", id: held.agent_instance_id }, sequence,
        position: Math.max(...observation.bundle.events.map((item) => item.position)) + 1,
        payload: { run_id: held.id, observed_phase: "cancelled", settled_status: "cancelled" } });
      observation.bundle.events.sort((a, b) => a.position - b.position); syncProjection(observation, event);
      observation.snapshot.version_cursor = observation.bundle.events.at(-1).position;
      assert.ok(terminal.position < event.position);
    }
    assert.equal(verifyCorrectionResults(httpFirst).passed, true);
    report.validator_mutations = { rejected: rejectedMutations, accepted_http_cancel_before_metadata_variant: true,
      variant_scope: "In-memory validator case only; original observed events and exports remain unchanged" };
  } catch (error) {
    report.error = error.message;
    if (fixture) {
      const observation = await fixture.scenario.observe().catch(() => null);
      t.diagnostic(JSON.stringify({ recipient_device_id: fixture.scenario.fields.recipient_device_id,
        task_status: observation?.snapshot?.task.status, cancellation: observation?.cancellation,
        live_pids: observation?.live_pids, exits: observation?.exits }));
    }
    throw error;
  } finally {
    const cleanup = { fixture_closed: false, server_closed: false, temporary_directory_removed: false, exported_copy_verified_after_cleanup: false };
    try {
      try { await fixture?.close(); cleanup.fixture_closed = true; }
      finally { await server?.close(); cleanup.server_closed = true; }
      rmSync(temporary, { recursive: true, force: true }); cleanup.temporary_directory_removed = !existsSync(temporary);
      if (evidenceDirectory && exported) {
        for (const file of exported.files) assert.equal(correctionHash(readFileSync(file.copy)), file.sha256);
        cleanup.exported_copy_verified_after_cleanup = true;
      }
    } finally {
      report.cleanup = cleanup; report.finished_at = new Date().toISOString();
      report.input_at_finish = copiedInputs(); report.input_stable = report.input_at_finish.sha256 === input.sha256;
      report.passed = !report.error && cleanup.fixture_closed && cleanup.server_closed && cleanup.temporary_directory_removed && report.input_stable
        && (!evidenceDirectory || !exported || cleanup.exported_copy_verified_after_cleanup);
      if (evidenceDirectory) writeFileSync(join(evidenceDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      assert.equal(report.input_stable, true, "Copied source/build inputs changed during protocol integration");
    }
  }
});
