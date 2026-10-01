import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createCorrectionFixture } from "../ios-ui-correction-fixture.mjs";
import { verifyCorrectionResults } from "./execution-correction-results.mjs";

// Production protocol integration and evidence-validator regressions. Commands
// in this test intentionally use HTTP. It is not client UI/E2E certification.
const root = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(100); }
  throw new Error(message);
}

test("actual four-run protocol produces verifiable correction evidence and rejects altered evidence", { timeout: 120_000 }, async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "artoo-correction-integration-"));
  let server, fixture;
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
    const before = await scenario.checkpoint("keep_running_before");
    await sleep(3150); await scenario.checkpoint("keep_running_after");
    const run = before.observation.receipts.find((receipt) => receipt.slot === 4);
    await command(`/api/v1/runs/${run.run_id}/cancel`, {});
    await scenario.waitForCheckpoint("stopped", 15_000);
    await sleep(3150); await scenario.checkpoint("stopped_stable");
    const original = { fields: scenario.fields, configuration: fixture.setup.configuration,
      baseHead: fixture.setup.baseHead, checkpoints: scenario.evidence(), final: await scenario.observe() };
    assert.equal(verifyCorrectionResults(original).passed, true);
    const all = (value, mutate) => { for (const entry of value.checkpoints) mutate(entry.observation); mutate(value.final); };
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
    ];
    for (const [name, mutate] of mutations) await t.test(`rejects ${name}`, () => {
      const changed = structuredClone(original); mutate(changed);
      assert.throws(() => verifyCorrectionResults(changed), /Execution correction verification failed/);
    });
  } catch (error) {
    if (fixture) {
      const observation = await fixture.scenario.observe().catch(() => null);
      t.diagnostic(JSON.stringify({ recipient_device_id: fixture.scenario.fields.recipient_device_id,
        task_status: observation?.snapshot?.task.status, cancellation: observation?.cancellation,
        live_pids: observation?.live_pids, exits: observation?.exits }));
    }
    throw error;
  } finally {
    try { await fixture?.close(); } finally { await server?.close(); rmSync(temporary, { recursive: true, force: true }); }
  }
});
