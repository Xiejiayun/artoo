import { eventLog, goalAutomations, goals, productReleases, productReleaseHealthReports, runs, tasks } from "@artoo/db";
import { type ProductReleaseHealthReport, type ProductReleaseReceipt, type RunVerificationPayload } from "@artoo/domain";
import { createInProcessChannel } from "@artoo/testkit";
import type { ServerToNodeMessage } from "@artoo/protocol";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";
import { createGoal } from "./services/goal-service.js";
import { acceptPlan, proposePlan } from "./services/plan-service.js";
import { assignTask, markReady, reviewTask } from "./services/lifecycle-service.js";
import { ingestWireRunEvent } from "./services/run-service.js";
import { cancelGoalProductRelease, ensureGoalProductRelease, getGoalProductRelease, ingestProductReleaseReceipt, ingestProductReleaseHealthReport } from "./services/product-release-service.js";
import { attachNodeBinding } from "./node-binding.js";
import { parseNodeToServer } from "./ws/ws-node-transport.js";

const digest = `sha256:${"a".repeat(64)}`, workspace = "/workspace/publish";
describe("durable target-product publication", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer({ workspaceRoot: workspace }); });
  afterEach(async () => { await server.close(); });
  async function prepared() {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Publish tested product" });
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: [{ title: "Final verification", acceptance_criteria: ["Product works"] }] });
    const materialized = await acceptPlan(server.ctx, plan.id), taskId = materialized.task_ids[0]!;
    await markReady(server.ctx, taskId);
    const assigned = await assignTask(server.ctx, taskId, { mode: "auto" });
    const runId = assigned.run.id;
    const requirement = { version: 1 as const, request_id: "verify-final", profile_id: "default" };
    await server.db.db.update(runs).set({ verificationRequirement: requirement }).where(eq(runs.id, runId));
    const [run] = await server.db.db.select().from(runs).where(eq(runs.id, runId));
    const evidence: RunVerificationPayload = { ...requirement, profile_digest: digest, subject_digest: digest, outcome: "passed",
      checks: [{ id: "acceptance", exit_code: 0, duration_ms: 10, output_digest: digest }], required_files: [] };
    for (const [sequence, event] of [
      { type: "run.lifecycle", payload: { phase: "started" } },
      { type: "run.verification", payload: evidence },
      { type: "run.lifecycle", payload: { phase: "completed" } },
    ].entries()) await ingestWireRunEvent(server.ctx, { kind: "run.event", node_id: run!.computerId, run_id: runId, sequence, event });
    await reviewTask(server.ctx, taskId, { outcome: "accepted" });
    // Fixture starts at the accepted delivery boundary; actual team review is tested separately.
    await server.db.db.update(goals).set({ status: "running" }).where(eq(goals.id, goal.id));
    await server.db.db.insert(goalAutomations).values({ goalId: goal.id, organizationId: server.ctx.organizationId,
      actorUserId: server.ctx.actorUserId, policyVersion: "fixture", status: "executing", planId: plan.id,
      agentInstanceId: run!.agentInstanceId, computerId: run!.computerId, workspaceRoot: workspace,
      verificationProfileId: "default", releaseProfileId: "site", createdAt: server.ctx.clock.nowIso(), updatedAt: server.ctx.clock.nowIso() });
    server.ctx.supportsReleaseProfile = () => true;
    const [automation] = await server.db.db.select().from(goalAutomations).where(eq(goalAutomations.goalId, goal.id));
    return { goal, run: run!, taskId, automation: automation! };
  }
  const queue = (automation: typeof goalAutomations.$inferSelect) => server.db.transaction((tx) => ensureGoalProductRelease(server.ctx, tx, automation));
  const published = async (goalId: string): Promise<ProductReleaseReceipt> => {
    const release = (await getGoalProductRelease(server.ctx, goalId))!;
    return { request: release.request, release_profile_digest: digest, artifact_digest: release.request.subject_digest,
      outcome: "published", endpoint: "https://product.example", previous_release_id: null,
      health_checks: [{ path: "/", status_code: 200, body_digest: digest, passed: true, checked_at: server.ctx.clock.nowIso() }] };
  };
  const health = (receipt: ProductReleaseReceipt, sequence: number, patch: Partial<ProductReleaseHealthReport> = {}): ProductReleaseHealthReport => ({
    version: 1, event_id: `health_${sequence}`, sequence, request: receipt.request, release_profile_digest: receipt.release_profile_digest,
    artifact_digest: receipt.artifact_digest!, state: "healthy", active_release_id: receipt.request.release_id,
    active_artifact_digest: receipt.artifact_digest!, consecutive_failures: 0, health_checks: receipt.health_checks,
    recovery_checks: [], checked_at: server.ctx.clock.nowIso(), ...patch,
  });
  it("queues once after accepted verified work and binds exact evidence without completing before endpoint health", async () => {
    const f = await prepared();
    await expect(queue(f.automation)).resolves.toMatchObject({ status: "pending" });
    await expect(queue(f.automation)).resolves.toMatchObject({ status: "pending" });
    expect(await server.db.db.select().from(productReleases)).toHaveLength(1);
    expect((await server.app.inject({ url: `/api/v1/goals/${f.goal.id}/release` })).json().release).toMatchObject({ status: "queued", receipt: null });
    const receipt = await published(f.goal.id);
    await ingestProductReleaseReceipt(server.ctx, f.run.computerId, receipt);
    await ingestProductReleaseReceipt(server.ctx, f.run.computerId, receipt);
    await expect(queue(f.automation)).resolves.toMatchObject({ status: "succeeded", endpoint: receipt.endpoint });
    expect(await server.db.db.select().from(eventLog).where(eq(eventLog.type, "product.release.completed"))).toHaveLength(1);
  });
  it("refuses missing work/evidence, absent profile discovery and stale node receipts", async () => {
    const f = await prepared();
    await server.db.db.update(tasks).set({ status: "review" }).where(eq(tasks.id, f.taskId));
    await expect(queue(f.automation)).rejects.toThrow(/All required work/);
    await server.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, f.taskId));
    server.ctx.supportsReleaseProfile = () => false;
    await expect(queue(f.automation)).resolves.toMatchObject({ status: "pending", reason: expect.stringContaining("advertising") });
    expect(await server.db.db.select().from(productReleases)).toHaveLength(0);
    server.ctx.supportsReleaseProfile = () => true; await queue(f.automation);
    const receipt = await published(f.goal.id);
    await expect(ingestProductReleaseReceipt(server.ctx, "wrong-node", receipt)).rejects.toThrow(/owned/);
    await expect(ingestProductReleaseReceipt(server.ctx, f.run.computerId, { ...receipt, request: { ...receipt.request, run_id: "old-run" } })).rejects.toThrow(/persisted immutable/);
    await server.db.db.update(runs).set({ verificationRequirement: { version: 1, request_id: "changed", profile_id: "default" } }).where(eq(runs.id, f.run.id));
    await expect(ingestProductReleaseReceipt(server.ctx, f.run.computerId, receipt)).rejects.toThrow(/verified source evidence/);
    expect((await getGoalProductRelease(server.ctx, f.goal.id))!.status).toBe("queued");
  });
  it("keeps failed health terminal and prevents changed or forged replay from overriding it", async () => {
    const f = await prepared(); await queue(f.automation);
    const passed = await published(f.goal.id);
    const failed: ProductReleaseReceipt = { ...passed, outcome: "rolled_back", endpoint: null, reason: "Critical path failed",
      health_checks: passed.health_checks.map((check) => ({ ...check, passed: false })) };
    await ingestProductReleaseReceipt(server.ctx, f.run.computerId, failed);
    await expect(queue(f.automation)).resolves.toMatchObject({ status: "failed", reason: "Critical path failed" });
    await expect(ingestProductReleaseReceipt(server.ctx, f.run.computerId, passed)).rejects.toThrow(/immutable/);
    expect((await server.app.inject({ url: "/api/v1/goals/missing/release" })).statusCode).toBe(404);
  });
  it("does not commit a first publication receipt when its node session expires inside the transaction", async () => {
    const f = await prepared(); await queue(f.automation);
    const receipt = await published(f.goal.id); let checks = 0;
    await expect(ingestProductReleaseReceipt(server.ctx, f.run.computerId, receipt, () => ++checks < 4)).rejects.toThrow(/session is no longer current/);
    expect(checks).toBe(4);
    expect((await getGoalProductRelease(server.ctx, f.goal.id))!).toMatchObject({ status: "queued", receipt: null });
    expect(await server.db.db.select().from(eventLog).where(eq(eventLog.type, "product.release.completed"))).toHaveLength(0);
    await ingestProductReleaseReceipt(server.ctx, f.run.computerId, receipt);
    await expect(ingestProductReleaseReceipt(server.ctx, f.run.computerId, receipt, () => false)).rejects.toThrow(/session is no longer current/);
    expect((await getGoalProductRelease(server.ctx, f.goal.id))!).toMatchObject({ status: "published", receipt });
  });
  it("dispatches only current profile-bound commands and accepts receipt only on the owning live session", async () => {
    const f = await prepared(); await queue(f.automation);
    const channel = createInProcessChannel(), commands: unknown[] = []; let current = true;
    channel.node.subscribe((command) => commands.push(command));
    const binding = attachNodeBinding(server.ctx, channel.serverTransport, f.run.computerId,
      ["run-verification.v1", "product-release.static.v1"], () => current,
      [{ profile_id: "default", project_id: "proj_artoo", workspace_root: workspace }],
      [{ profile_id: "site", project_id: "proj_artoo", workspace_root: workspace, verification_profile_id: "default", target_kind: "static_site" }]);
    try {
      const release = (await getGoalProductRelease(server.ctx, f.goal.id))!;
      await binding.dispatchProductRelease!(release.id);
      expect(commands).toContainEqual(expect.objectContaining({ type: "product.release", idempotency_key: `release:${release.id}`, payload: release.request }));
      current = false;
      expect(binding.supportsReleaseProfile!("site", "proj_artoo", workspace, "default")).toBe(false);
      await expect(binding.dispatchProductRelease!(release.id)).rejects.toThrow(/no longer current/);
      await channel.node.send({ kind: "product.release.receipt", node_id: f.run.computerId, payload: await published(f.goal.id) }); await binding.drain();
      expect((await getGoalProductRelease(server.ctx, f.goal.id))!.status).toBe("queued");
      current = true;
      await channel.node.send({ kind: "product.release.receipt", node_id: f.run.computerId, payload: await published(f.goal.id) }); await binding.drain();
      expect((await getGoalProductRelease(server.ctx, f.goal.id))!.status).toBe("published");
    } finally { binding.close(); }
  });
  it("does not report cancellation until the node's durable terminal receipt exists", async () => {
    const f = await prepared(); await queue(f.automation);
    server.ctx.onProductReleaseCancel = async () => {};
    await expect(cancelGoalProductRelease(server.ctx, f.goal.id)).rejects.toThrow(/not been confirmed/);
    server.ctx.onProductReleaseCancel = async () => {
      const pass = await published(f.goal.id);
      await ingestProductReleaseReceipt(server.ctx, f.run.computerId, { ...pass, outcome: "failed", endpoint: null,
        artifact_digest: null, health_checks: [], reason: "Cancelled before activation" });
    };
    await expect(cancelGoalProductRelease(server.ctx, f.goal.id)).resolves.toBeUndefined();
    expect((await getGoalProductRelease(server.ctx, f.goal.id))!.status).toBe("failed");
  });
  it("stores ordered later health independently from the publication receipt and survives API reload", async () => {
    const f = await prepared(); await queue(f.automation);
    const receipt = await published(f.goal.id), first = health(receipt, 1);
    await expect(ingestProductReleaseHealthReport(server.ctx, f.run.computerId, first)).rejects.toThrow(/confirmed published/);
    await ingestProductReleaseReceipt(server.ctx, f.run.computerId, receipt);
    await ingestProductReleaseHealthReport(server.ctx, f.run.computerId, first);
    await ingestProductReleaseHealthReport(server.ctx, f.run.computerId, first);
    const degraded = health(receipt, 3, { state: "degraded", consecutive_failures: 1,
      health_checks: receipt.health_checks.map((check) => ({ ...check, passed: false, status_code: 503 })) });
    await ingestProductReleaseHealthReport(server.ctx, f.run.computerId, degraded);
    await expect(queue(f.automation)).resolves.toMatchObject({ status: "pending", reason: expect.stringContaining("degraded") });
    await ingestProductReleaseHealthReport(server.ctx, f.run.computerId, first);
    await expect(ingestProductReleaseHealthReport(server.ctx, f.run.computerId, health(receipt, 2))).rejects.toThrow(/older/);
    await expect(ingestProductReleaseHealthReport(server.ctx, f.run.computerId, { ...degraded, reason: "different" })).rejects.toThrow(/identity is immutable/);
    await expect(ingestProductReleaseHealthReport(server.ctx, f.run.computerId, { ...degraded, event_id: "different" })).rejects.toThrow(/identity is immutable/);
    const recovered = health(receipt, 4);
    await ingestProductReleaseHealthReport(server.ctx, f.run.computerId, recovered);
    const response = (await server.app.inject({ url: `/api/v1/goals/${f.goal.id}/release` })).json().release;
    expect(response).toMatchObject({ status: "published", receipt, health: recovered });
    expect(await server.db.db.select().from(productReleaseHealthReports)).toHaveLength(3);
    expect(await server.db.db.select().from(eventLog).where(eq(eventLog.type, "product.release.health"))).toHaveLength(3);
    expect(await server.db.db.select().from(eventLog).where(eq(eventLog.type, "product.release.completed"))).toHaveLength(1);
    await expect(queue(f.automation)).resolves.toMatchObject({ status: "succeeded" });
  });
  it("rejects health with changed request, configuration, artifact, endpoint paths or measured content", async () => {
    const f = await prepared(); await queue(f.automation);
    const receipt = await published(f.goal.id), report = health(receipt, 1);
    await ingestProductReleaseReceipt(server.ctx, f.run.computerId, receipt);
    await expect(ingestProductReleaseHealthReport(server.ctx, "wrong-node", report)).rejects.toThrow(/owned/);
    for (const patch of [
      { request: { ...report.request, goal_id: "wrong-goal" } },
      { release_profile_digest: `sha256:${"b".repeat(64)}` },
      { artifact_digest: `sha256:${"b".repeat(64)}` },
      { health_checks: receipt.health_checks.map((check) => ({ ...check, path: "/unmeasured" })) },
      { health_checks: receipt.health_checks.map((check) => ({ ...check, body_digest: `sha256:${"b".repeat(64)}` })) },
    ]) await expect(ingestProductReleaseHealthReport(server.ctx, f.run.computerId, { ...report, ...patch })).rejects.toThrow();
    expect(await server.db.db.select().from(productReleaseHealthReports)).toHaveLength(0);
    expect((await getGoalProductRelease(server.ctx, f.goal.id))!.health).toBeNull();
  });
  it("validates the restored version and never changes the original publication receipt", async () => {
    const f = await prepared(); await queue(f.automation);
    const previousGoal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Previously published product" });
    const [current] = await server.db.db.select().from(productReleases).where(eq(productReleases.goalId, f.goal.id));
    const previousDigest = `sha256:${"b".repeat(64)}`, previousId = "previous_release";
    const original = await published(f.goal.id);
    // Fixture begins at a recorded prior publication; its initial validation is covered by the tests above.
    const priorReceipt: ProductReleaseReceipt = { ...original, request: { ...original.request, release_id: previousId,
      goal_id: previousGoal.id, subject_digest: previousDigest }, artifact_digest: previousDigest,
      health_checks: original.health_checks.map((check) => ({ ...check, body_digest: previousDigest })) };
    await server.db.db.insert(productReleases).values({ ...current!, id: previousId, goalId: previousGoal.id,
      status: "published", request: priorReceipt.request, receipt: priorReceipt });
    const receipt = { ...original, previous_release_id: previousId };
    await ingestProductReleaseReceipt(server.ctx, f.run.computerId, receipt);
    const report = health(receipt, 1, { state: "rolled_back", consecutive_failures: 2, active_release_id: previousId,
      active_artifact_digest: previousDigest, health_checks: receipt.health_checks.map((check) => ({ ...check, passed: false, status_code: 503 })),
      recovery_checks: priorReceipt.health_checks });
    await expect(ingestProductReleaseHealthReport(server.ctx, f.run.computerId, { ...report, active_release_id: "unknown" })).rejects.toThrow(/previous version/);
    await expect(ingestProductReleaseHealthReport(server.ctx, f.run.computerId, { ...report, active_artifact_digest: digest })).rejects.toThrow(/previous-version evidence/);
    await expect(ingestProductReleaseHealthReport(server.ctx, f.run.computerId, { ...report, recovery_checks: receipt.health_checks })).rejects.toThrow(/endpoint paths and content/);
    await ingestProductReleaseHealthReport(server.ctx, f.run.computerId, report);
    await expect(queue(f.automation)).resolves.toMatchObject({ status: "failed" });
    await expect(ingestProductReleaseHealthReport(server.ctx, f.run.computerId, health(receipt, 2))).rejects.toThrow(/quarantined/);
    expect((await getGoalProductRelease(server.ctx, f.goal.id))!).toMatchObject({ status: "published", receipt, health: report });
  });
  it("requires no active version for unavailability and rolls back an ingest if its session expires mid-transaction", async () => {
    const f = await prepared(); await queue(f.automation);
    const receipt = await published(f.goal.id), report = health(receipt, 1);
    await ingestProductReleaseReceipt(server.ctx, f.run.computerId, receipt);
    let checks = 0;
    await expect(ingestProductReleaseHealthReport(server.ctx, f.run.computerId, report, () => ++checks < 4)).rejects.toThrow(/session is no longer current/);
    expect(checks).toBe(4);
    expect(await server.db.db.select().from(productReleaseHealthReports)).toHaveLength(0);
    expect(await server.db.db.select().from(eventLog).where(eq(eventLog.type, "product.release.health"))).toHaveLength(0);
    const unavailable = health(receipt, 2, { state: "unavailable", active_release_id: null, active_artifact_digest: null, consecutive_failures: 2,
      health_checks: receipt.health_checks.map((check) => ({ ...check, passed: false, status_code: 503 })) });
    await ingestProductReleaseHealthReport(server.ctx, f.run.computerId, unavailable);
    await ingestProductReleaseHealthReport(server.ctx, f.run.computerId, unavailable);
    await expect(queue(f.automation)).resolves.toMatchObject({ status: "failed" });
    expect((await getGoalProductRelease(server.ctx, f.goal.id))!).toMatchObject({ receipt, health: unavailable });
  });
  it("admits health frames only from the current feature/profile-bound owner session", async () => {
    const f = await prepared(); await queue(f.automation);
    const receipt = await published(f.goal.id), payload = health(receipt, 1);
    await ingestProductReleaseReceipt(server.ctx, f.run.computerId, receipt);
    const frame = { kind: "product.release.health" as const, node_id: f.run.computerId, payload };
    expect(parseNodeToServer(JSON.stringify(frame))).toEqual(frame);
    expect(parseNodeToServer(JSON.stringify({ ...frame, payload: { ...payload, active_release_id: "other" } }))).toBeNull();
    const channel = createInProcessChannel(), acknowledgements: ServerToNodeMessage[] = []; let current = true;
    channel.node.subscribe((command) => { if (command.type === "product.release.health.ack") acknowledgements.push(command); });
    const profile = { profile_id: "site", project_id: "proj_artoo", workspace_root: workspace, verification_profile_id: "default", target_kind: "static_site" as const };
    const binding = attachNodeBinding(server.ctx, channel.serverTransport, f.run.computerId,
      ["run-verification.v1", "product-release.static.v1", "product-release.health.v1"], () => current,
      [{ profile_id: "default", project_id: "proj_artoo", workspace_root: workspace }], [profile]);
    try {
      await channel.node.send({ ...frame, node_id: "other-node" }); await binding.drain();
      expect(acknowledgements).toHaveLength(0);
      current = false; await channel.node.send(frame); await binding.drain();
      expect((await getGoalProductRelease(server.ctx, f.goal.id))!.health).toBeNull();
      expect(acknowledgements).toEqual([expect.objectContaining({ type: "product.release.health.ack",
        payload: expect.objectContaining({ event_id: payload.event_id, release_id: payload.request.release_id, sequence: 1, status: "rejected" }) })]);
      current = true; await channel.node.send(frame); await binding.drain();
      expect((await getGoalProductRelease(server.ctx, f.goal.id))!.health).toEqual(payload);
      expect(acknowledgements.at(-1)).toMatchObject({ type: "product.release.health.ack",
        payload: { event_id: payload.event_id, release_id: payload.request.release_id, sequence: 1, status: "accepted" } });
    } finally { binding.close(); }
    const old = attachNodeBinding(server.ctx, channel.serverTransport, f.run.computerId,
      ["run-verification.v1", "product-release.static.v1"], () => true,
      [{ profile_id: "default", project_id: "proj_artoo", workspace_root: workspace }], [profile]);
    try { await channel.node.send({ ...frame, payload: health(receipt, 2) }); await old.drain(); }
    finally { old.close(); }
    const changed = attachNodeBinding(server.ctx, channel.serverTransport, f.run.computerId,
      ["run-verification.v1", "product-release.static.v1", "product-release.health.v1"], () => true,
      [{ profile_id: "default", project_id: "proj_artoo", workspace_root: workspace }], [{ ...profile, workspace_root: `${workspace}/changed` }]);
    try { await channel.node.send({ ...frame, payload: health(receipt, 2) }); await changed.drain(); }
    finally { changed.close(); }
    expect((await getGoalProductRelease(server.ctx, f.goal.id))!.health).toEqual(payload);
    expect(acknowledgements.slice(-2)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ sequence: 2, status: "rejected" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ sequence: 2, status: "rejected" }) }),
    ]);
  });
});
