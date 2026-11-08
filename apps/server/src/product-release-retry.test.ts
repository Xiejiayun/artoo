import { agentInstances, computers, eventLog, goalAutomations, goals, productReleases, productReleaseRetrySources, runs } from "@artoo/db";
import { PRODUCT_RELEASE_RETRY_FEATURE_V1, parseDeviceToken, ProductReleaseRequestSchema, type ProductReleaseReceipt, type RunVerificationPayload } from "@artoo/domain";
import { createInProcessChannel } from "@artoo/testkit";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect } from "vitest";
import { settledServerFixture } from "./test-fixtures/settled-server-fixture.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { createPairing } from "./services/device-service.js";
import { cancelGoal, createGoal } from "./services/goal-service.js";
import { createGoalAutomationDispatcher } from "./services/goal-automation-service.js";
import { acceptPlan, proposePlan } from "./services/plan-service.js";
import { assignTask, markReady, reviewTask } from "./services/lifecycle-service.js";
import { ingestWireRunEvent } from "./services/run-service.js";
import { ensureGoalProductRelease, getGoalProductRelease, ingestProductReleaseReceipt } from "./services/product-release-service.js";
import { assertProductReleaseRetryDispatch, releaseReceiptDigest, releaseRequestDigest, type ProductReleasePairedSession } from "./services/product-release-retry-service.js";
import { attachNodeBinding } from "./node-binding.js";

const digest = `sha256:${"a".repeat(64)}`, workspace = "/workspace/retry";
describe("bounded publication attempts (controlled DB and paired transport, no native publisher)", () => {
  const lifecycle = settledServerFixture<{ server?: TestServer }>(() => ({})), it = lifecycle.it;
  lifecycle.beforeEach(async state => { state.server = await lifecycle.acquire(buildTestServer({ workspaceRoot: workspace,
    onResourceAcquired: resource => lifecycle.own(resource) })); });
  lifecycle.afterEach();
  const fixture = () => { const server = lifecycle.current().server; if (!server) throw Error("Original fixture is not ready"); return server; };
  async function prepared(maxRetries = 2, reusedSession?: ProductReleasePairedSession) {
    const server = fixture(), ctx = server.ctx;
    const session = reusedSession ?? await (async () => {
    const pairing = await createPairing(ctx, { pepper: ctx.deviceAuth.pairingPepper, ttlMs: 60000 }, { createdByUserId: ctx.actorUserId });
    const claim = await server.app.inject({ method: "POST", url: "/api/v1/devices/claim", payload: {
      code: pairing.code, platform: "windows", app_version: "controlled-H8", display_name: "Publication computer" } });
    expect(claim.statusCode).toBe(201);
    const credentials = claim.json() as { device: { id: string }; node_token: string; control_token: string };
    const enrollment = await server.app.inject({ method: "POST", url: `/api/v1/devices/${credentials.device.id}/enroll`, payload: {},
      headers: { authorization: `Bearer ${credentials.control_token}` } });
    expect(enrollment.statusCode).toBe(200);
    const computerId = enrollment.json().computer_id as string;
    return { computerId, deviceId: credentials.device.id, tokenLookup: parseDeviceToken(credentials.node_token)!.lookup, sessionId: "controlled-H8-session" };
    })();
    const { computerId } = session;
    await server.db.db.update(computers).set({ status: "online" }).where(eq(computers.id, computerId));
    await server.db.db.update(agentInstances).set({ computerId }).where(eq(agentInstances.id, "instance_mock_coder"));
    ctx.getPairedNodeSession = id => id === computerId ? session : undefined;
    ctx.supportsExecutionFeature = (id, feature) => id === computerId && feature === PRODUCT_RELEASE_RETRY_FEATURE_V1;
    ctx.supportsReleaseProfile = () => true;
    const goal = await createGoal(ctx, { project_id: "proj_artoo", title: "Retry configured product publication", budgets: { max_retries: maxRetries } });
    const plan = await proposePlan(ctx, goal.id, { task_specs: [{ title: "Final verification", acceptance_criteria: ["Product works"] }] });
    const materialized = await acceptPlan(ctx, plan.id), taskId = materialized.task_ids[0]!;
    await markReady(ctx, taskId); const assigned = await assignTask(ctx, taskId, { mode: "auto" });
    expect(assigned.run.computer_id).toBe(computerId);
    const requirement = { version: 1 as const, request_id: "retry-final", profile_id: "default" };
    await server.db.db.update(runs).set({ verificationRequirement: requirement }).where(eq(runs.id, assigned.run.id));
    const [run] = await server.db.db.select().from(runs).where(eq(runs.id, assigned.run.id));
    if (!run || !run.aiDataSharingPolicyVersion) throw Error("Controlled original author must retain its actual sharing policy");
    const evidence: RunVerificationPayload = { ...requirement, profile_digest: digest, subject_digest: digest, outcome: "passed",
      checks: [{ id: "acceptance", exit_code: 0, duration_ms: 10, output_digest: digest }], required_files: [] };
    for (const [sequence, event] of [
      { type: "run.lifecycle", payload: { phase: "started" } }, { type: "run.verification", payload: evidence },
      { type: "run.lifecycle", payload: { phase: "completed" } },
    ].entries()) await ingestWireRunEvent(ctx, { kind: "run.event", node_id: computerId, run_id: run!.id, sequence, event });
    await reviewTask(ctx, taskId, { outcome: "accepted" });
    await server.db.db.update(goals).set({ status: "running" }).where(eq(goals.id, goal.id));
    await server.db.db.insert(goalAutomations).values({ goalId: goal.id, organizationId: ctx.organizationId, actorUserId: ctx.actorUserId,
      consentId: run.aiDataSharingConsentId, policyVersion: run.aiDataSharingPolicyVersion, status: "executing", planId: plan.id,
      agentInstanceId: run!.agentInstanceId, computerId, workspaceRoot: workspace, verificationProfileId: "default", releaseProfileId: "site",
      createdAt: ctx.clock.nowIso(), updatedAt: ctx.clock.nowIso() });
    const [automation] = await server.db.db.select().from(goalAutomations).where(eq(goalAutomations.goalId, goal.id));
    const queue = () => server.db.transaction(tx => ensureGoalProductRelease(ctx, tx, automation!));
    await queue();
    const all = () => server.db.db.select().from(productReleases).where(eq(productReleases.goalId, goal.id)).orderBy(asc(productReleases.publicationGeneration));
    const failed = async (): Promise<ProductReleaseReceipt> => {
      const current = (await getGoalProductRelease(ctx, goal.id))!;
      return { request: current.request, release_profile_digest: digest, artifact_digest: digest, outcome: "failed", endpoint: null,
        previous_release_id: null, health_checks: [], reason: "Controlled listener closed after failed publication",
        retry_source: { version: 1, source_id: "source-" + current.id, closure: "local-release-settled.v1",
          recovery: { kind: "listener-closed", active_release_id: null, active_artifact_digest: null } } };
    };
    return { server, ctx, goal, run: run!, session, automation: automation!, queue, all, failed };
  }

  it("creates exactly one new attempt after a committed failure and later publishes without rerunning the author", async () => {
    const f = await prepared(), first = await f.failed(), originalRuns = await f.server.db.db.select().from(runs);
    await ingestProductReleaseReceipt(f.ctx, f.session.computerId, first, () => true, f.session);
    await Promise.all([f.queue(), f.queue()]);
    const releases = await f.all(); expect(releases).toHaveLength(2); expect(releases[0]!.receipt).toEqual(first);
    const next = releases[1]!, request = ProductReleaseRequestSchema.parse(next.request);
    expect(request.retry).toMatchObject({ root_release_id: releases[0]!.id, previous_release_id: releases[0]!.id, generation: 1,
      source_id: first.retry_source!.source_id, previous_request_digest: releaseRequestDigest(first.request), previous_receipt_digest: releaseReceiptDigest(first),
      authorization: { actor_user_id: f.ctx.actorUserId, goal_id: f.goal.id, attempt_index: 1 } });
    expect(next.runId).toBe(f.run.id); expect(await f.server.db.db.select().from(runs)).toEqual(originalRuns);
    expect((await f.server.db.db.select().from(goals).where(eq(goals.id, f.goal.id)))[0]!.retryCount).toBe(1);
    expect(await f.server.db.db.select().from(eventLog).where(eq(eventLog.type, "product.release.retry-authorized"))).toHaveLength(1);
    await f.server.db.transaction(tx => assertProductReleaseRetryDispatch(f.ctx, tx, next, f.session));
    await ingestProductReleaseReceipt(f.ctx, f.session.computerId, first, () => true, f.session);
    const published: ProductReleaseReceipt = { request, release_profile_digest: digest, artifact_digest: digest, outcome: "published",
      endpoint: "http://127.0.0.1:18182/", previous_release_id: null,
      health_checks: [{ path: "/", status_code: 200, body_digest: digest, passed: true, checked_at: f.ctx.clock.nowIso() }] };
    await expect(ingestProductReleaseReceipt(f.ctx, f.session.computerId, published, () => true,
      { ...f.session, sessionId: "another-session" })).rejects.toThrow("original paired executor session");
    expect((await f.all())[1]!.receipt).toBeNull();
    await ingestProductReleaseReceipt(f.ctx, f.session.computerId, published, () => true, f.session);
    await expect(f.queue()).resolves.toMatchObject({ status: "succeeded" });
    expect((await getGoalProductRelease(f.ctx, f.goal.id))!.id).toBe(next.id);
    expect((await f.all())[0]!.receipt).toEqual(first);
    await expect(ingestProductReleaseReceipt(f.ctx, f.session.computerId, { ...first, reason: "changed" }, () => true, f.session)).rejects.toThrow("immutable");
  });

  it("bounds all generations by the original cumulative retry budget", async () => {
    const f = await prepared(1), first = await f.failed();
    await ingestProductReleaseReceipt(f.ctx, f.session.computerId, first, () => true, f.session); await f.queue();
    const second = await f.failed(); await ingestProductReleaseReceipt(f.ctx, f.session.computerId, second, () => true, f.session);
    await expect(f.queue()).resolves.toMatchObject({ status: "failed", reason: expect.stringContaining("retry budget") });
    expect(await f.all()).toHaveLength(2);
    expect((await f.server.db.db.select().from(goals).where(eq(goals.id, f.goal.id)))[0]!.retryCount).toBe(1);
  });

  it("admits healthy previous-version recovery while preserving the failed receipt's null endpoint", async () => {
    const prior = await prepared(), priorRelease = (await getGoalProductRelease(prior.ctx, prior.goal.id))!;
    const healthy: ProductReleaseReceipt = { request: priorRelease.request, release_profile_digest: digest, artifact_digest: digest, outcome: "published",
      endpoint: "http://127.0.0.1:18182/", previous_release_id: null,
      health_checks: [{ path: "/", status_code: 200, body_digest: digest, passed: true, checked_at: prior.ctx.clock.nowIso() }] };
    await ingestProductReleaseReceipt(prior.ctx, prior.session.computerId, healthy);
    // Publication does not itself release the autonomous workspace reservation.
    // Cancel the settled prior goal through its real cancellation/runner gates;
    // the cancelled goal's published version remains available for recovery.
    await expect(cancelGoal(prior.ctx, prior.goal.id)).resolves.toMatchObject({ status: "cancelled" });
    const errors: unknown[] = [], dispatcher = createGoalAutomationDispatcher(prior.ctx,
      async () => { throw Error("The settled prior publication must not need a process stop"); }, error => errors.push(error));
    try { await dispatcher.pump(); } finally { await dispatcher.stop(); }
    expect(errors).toEqual([]);
    expect((await prior.server.db.db.select().from(goalAutomations).where(eq(goalAutomations.goalId, prior.goal.id)))[0]!.status).toBe("cancelled");
    expect(await getGoalProductRelease(prior.ctx, prior.goal.id)).toMatchObject({ status: "published", receipt: healthy });
    const f = await prepared(2, prior.session), base = await f.failed();
    const recovered: ProductReleaseReceipt = { ...base, outcome: "rolled_back", previous_release_id: priorRelease.id,
      recovery_checks: healthy.health_checks, retry_source: { ...base.retry_source!,
        recovery: { kind: "previous-restored", active_release_id: priorRelease.id, active_artifact_digest: digest } } };
    await ingestProductReleaseReceipt(f.ctx, f.session.computerId, recovered, () => true, f.session);
    await expect(f.queue()).resolves.toMatchObject({ status: "pending" });
    expect(await f.all()).toHaveLength(2);
    expect((await f.all())[0]!.receipt).toEqual(recovered);
    expect((await getGoalProductRelease(f.ctx, prior.goal.id))!.receipt).toEqual(healthy);
  });

  it.each(["missing-source", "unpaired", "session-replaced", "feature-removed", "paused"])("does not create an attempt for %s", async change => {
    const f = await prepared(), receipt = await f.failed();
    if (change === "missing-source") delete receipt.retry_source;
    await ingestProductReleaseReceipt(f.ctx, f.session.computerId, receipt, () => true, change === "unpaired" ? undefined : f.session);
    if (change === "session-replaced") f.ctx.getPairedNodeSession = () => ({ ...f.session, sessionId: "replacement" });
    if (change === "feature-removed") f.ctx.supportsExecutionFeature = () => false;
    if (change === "paused") {
      await f.server.db.db.update(goals).set({ status: "paused" }).where(eq(goals.id, f.goal.id));
      await expect(f.queue()).rejects.toThrow("original running goal");
    } else await expect(f.queue()).resolves.toMatchObject({ status: "failed" });
    expect(await f.all()).toHaveLength(1);
    expect((await f.server.db.db.select().from(goals).where(eq(goals.id, f.goal.id)))[0]!.retryCount).toBe(0);
  });

  it("checks exact paired retry ancestry on the ordinary product.release transport", async () => {
    const f = await prepared(), channel = createInProcessChannel(), messages: unknown[] = [];
    channel.node.subscribe(message => messages.push(message));
    const binding = attachNodeBinding(f.ctx, channel.serverTransport, f.session.computerId,
      ["run-verification.v1", "product-release.static.v1", PRODUCT_RELEASE_RETRY_FEATURE_V1], () => true,
      [{ profile_id: "default", project_id: "proj_artoo", workspace_root: workspace }],
      [{ profile_id: "site", project_id: "proj_artoo", workspace_root: workspace, verification_profile_id: "default", target_kind: "static_site" }],
      [], () => false, "win32", { identity: f.session, sessionId: f.session.sessionId, artifactDir: await lifecycle.temporary("artoo-retry-wire-") });
    try {
      expect(binding.supportsReleaseProfile?.("site", "proj_artoo", workspace, "default")).toBe(true);
      const receipt = await f.failed();
      await channel.node.send({ kind: "product.release.receipt", node_id: f.session.computerId, payload: receipt }); await binding.drain();
      expect(await f.server.db.db.select().from(productReleaseRetrySources)).toHaveLength(1);
      await f.queue(); const next = (await f.all())[1]!;
      await binding.dispatchProductRelease!(next.id);
      expect(messages).toContainEqual(expect.objectContaining({ type: "product.release", payload: next.request, idempotency_key: "release:" + next.id }));
      f.ctx.getPairedNodeSession = () => ({ ...f.session, sessionId: "replacement" });
      await expect(binding.dispatchProductRelease!(next.id)).rejects.toThrow("original current paired session");
      expect(await f.server.db.db.select().from(productReleases).where(and(eq(productReleases.goalId, f.goal.id), eq(productReleases.status, "queued")))).toHaveLength(1);
    } finally { binding.close(); }
  });
});
