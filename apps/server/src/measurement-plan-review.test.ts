import { agentInstances, agents, assistantTurns, autonomousReviews, contextPacks, eventLog, goals, messages, rooms, runEvidence, runs, tasks } from "@artoo/db";
import { ContextPackSchema, evaluateDeclaredMeasurementPlanV1, ProductResearchReportSchema, type RunVerificationPayload } from "@artoo/domain";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectIndependentReview } from "./services/independent-review-service.js";
import { persistRunVerificationEvidence, readRunVerificationEvidence, type RunVerificationEvidence } from "./services/verification-service.js";
import { measurementPlanEvidenceFixture } from "./test-fixtures/measurement-plan.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const other = `sha256:${"9".repeat(64)}`;
const nativeCriterion = "A native screen reader announces every saved entry";
describe("independent review of declared measurement feasibility", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer({ workspaceRoot: "/workspace/product" }); });
  afterEach(async () => { await server.close(); });

  // Controlled database/node receipts: this exercises qualification and review decisions,
  // not a real provider, browser, research source, process exit or product publication.
  async function prepare(f = measurementPlanEvidenceFixture()) {
    const db = server.db.db, organizationId = server.ctx.organizationId, now = server.ctx.clock.nowIso();
    const [writer] = await db.select().from(agentInstances), [agent] = await db.select().from(agents);
    await db.insert(agents).values({ ...agent!, id: "review_agent", kind: "reviewer" });
    await db.insert(agentInstances).values({ ...writer!, id: "review_instance", agentId: "review_agent" });
    await db.insert(rooms).values({ id: "measurement_room", organizationId, projectId: "proj_artoo", type: "goal", name: "Controlled review", createdAt: now });
    await db.insert(goals).values({ id: "measurement_goal", organizationId, projectId: "proj_artoo", roomId: "measurement_room",
      ownerUserId: server.ctx.actorUserId, title: "Preserve original product requirements", objective: nativeCriterion, status: "running", createdAt: now, updatedAt: now });
    for (const id of ["measurement_author_task", "measurement_review_task"]) {
      await db.insert(tasks).values({ id, organizationId, projectId: "proj_artoo", goalId: "measurement_goal", roomId: "measurement_room",
        title: id, description: nativeCriterion, status: "review", acceptanceCriteria: [nativeCriterion],
        createdByType: "system", createdById: "goal_runner", createdAt: now, updatedAt: now });
    }
    async function record(id: string, instanceId: string, context: typeof f.context, payload: RunVerificationPayload, peer = false) {
      const taskId = peer ? "measurement_review_task" : "measurement_author_task", contextPackId = `${id}_context`;
      context.task.id = taskId;
      await db.insert(contextPacks).values({ id: contextPackId, organizationId, taskId, runId: id, payload: ContextPackSchema.parse(context), createdAt: now });
      const requirement = { ...f.requirement, request_id: payload.request_id, ...(peer ? { expected_subject_digest: payload.subject_digest! } : {}) };
      const [run] = await db.insert(runs).values({ id, organizationId, taskId, computerId: writer!.computerId, agentInstanceId: instanceId,
        runtimeId: "controlled_fixture", status: "running", contextPackId, verificationRequirement: requirement, workspaceRoot: "/workspace/product", createdAt: now }).returning();
      const eventId = `${id}_event`;
      await db.insert(eventLog).values({ id: eventId, organizationId, projectId: "proj_artoo", taskId, runId: id,
        type: "run.verification", schemaVersion: "2026-06-11", actorType: "system", actorId: writer!.computerId,
        correlationId: id, payload, occurredAt: now });
      const evidence = await persistRunVerificationEvidence(server.ctx, db, { run: run!, payload, eventId });
      const [completed] = await db.update(runs).set({ status: "completed", endedAt: now }).where(eq(runs.id, id)).returning();
      return { run: completed!, evidence, context };
    }
    const source = await record("measurement_author_run", writer!.id, structuredClone(f.context), structuredClone(f.payload));
    const context = structuredClone(f.context), payload = structuredClone(f.payload);
    delete context.product_development;
    context.policy.execution_mode = "discussion"; context.policy.filesystem_write_scope = [];
    context.review_subject = { version: 1, task_id: source.run.taskId, run_id: source.run.id, evidence_id: source.evidence.id,
      subject_digest: f.payload.subject_digest!, development_stage: "research", verification: { version: 1,
        request_id: f.payload.request_id, profile_id: f.payload.profile_id, profile_digest: f.payload.profile_digest,
        measurement_plan: structuredClone(f.payload.measurement_plan),
        checks: f.payload.checks.map(({ id, output_digest, observation }) => ({ id, output_digest, observation })) } };
    payload.request_id = "measurement_peer_request";
    const peer = await record("measurement_peer_run", "review_instance", context, payload, true);
    const verdict = { version: 1, reviewed_run_id: source.run.id, verification_evidence_id: source.evidence.id,
      subject_digest: source.evidence.payload.subject_digest, outcome: "accepted", summary: "Controlled substantive review accepted", findings: [] };
    await db.insert(messages).values([
      { id: "measurement_request", organizationId, roomId: "measurement_room", taskId: peer.run.taskId,
        actorType: "system", actorId: "goal_runner", kind: "text", body: "Inspect the original requirement and actual source", createdAt: now },
      { id: "measurement_response", organizationId, roomId: "measurement_room", taskId: peer.run.taskId, runId: peer.run.id,
        actorType: "agent", actorId: "review_instance", kind: "text", body: JSON.stringify(verdict), createdAt: now },
    ]);
    await db.insert(assistantTurns).values({ id: "measurement_turn", organizationId, roomId: "measurement_room", taskId: peer.run.taskId,
      actorUserId: server.ctx.actorUserId, clientRequestId: "measurement_review", agentInstanceId: "review_instance",
      userMessageId: "measurement_request", responseMessageId: "measurement_response", runId: peer.run.id, status: "completed", createdAt: now, updatedAt: now });
    await db.insert(autonomousReviews).values({ id: "measurement_review", organizationId, goalId: "measurement_goal", taskId: source.run.taskId,
      subjectRunId: source.run.id, evidenceId: source.evidence.id, subjectDigest: f.payload.subject_digest!, reviewerInstanceId: "review_instance",
      reviewTaskId: peer.run.taskId, turnId: "measurement_turn", status: "pending", createdAt: now, updatedAt: now });
    return { source, peer, verdict, inspect: () => inspectIndependentReview(server.ctx, db, source.run, source.evidence) };
  }
  async function replaceReceipt(evidence: RunVerificationEvidence, payload: RunVerificationPayload) {
    await server.db.db.update(runEvidence).set({ payload }).where(eq(runEvidence.id, evidence.id));
    await server.db.db.update(eventLog).set({ payload }).where(eq(eventLog.id, evidence.eventId));
  }

  it("requires both independently qualified receipts before accepting a bound substantive verdict", async () => {
    const f = await prepare();
    expect(await f.inspect()).toMatchObject({ status: "accepted", reviewerRunId: f.peer.run.id, reviewerEvidenceId: f.peer.evidence.id });
    expect(f.source.evidence.payload.measurement_plan!.claim).toBe("declared-mapping-feasibility");
    const missing = structuredClone(f.peer.evidence.payload); delete missing.measurement_plan;
    await replaceReceipt(f.peer.evidence, missing);
    expect(await f.inspect()).toMatchObject({ status: "failed", reason: expect.stringContaining("source verification failed") });
  });

  it("compares the real source even when the peer receipt and its persisted source projection agree on changed facts", async () => {
    const f = await prepare();
    for (const mode of ["digest", "counts"] as const) {
      const context = structuredClone(f.peer.context), payload = structuredClone(f.peer.evidence.payload);
      if (mode === "digest") payload.measurement_plan!.measurement_plan_digest = other;
      else { payload.measurement_plan!.must_criterion_count++; payload.measurement_plan!.mapped_criterion_count++; }
      context.review_subject!.verification!.measurement_plan = structuredClone(payload.measurement_plan);
      await server.db.db.update(contextPacks).set({ payload: context }).where(eq(contextPacks.id, f.peer.run.contextPackId!));
      await replaceReceipt(f.peer.evidence, payload);
      expect(await readRunVerificationEvidence(server.ctx, server.db.db, f.peer.run.id)).not.toBeNull();
      expect(await f.inspect()).toMatchObject({ status: "failed", reason: "Independent measurement-plan summary differs from the verified source" });
    }
  });

  it("requalifies current source evidence and context instead of trusting an earlier caller read", async () => {
    const f = await prepare(), payload = structuredClone(f.source.evidence.payload);
    delete payload.measurement_plan;
    await replaceReceipt(f.source.evidence, payload);
    expect(await f.inspect()).toMatchObject({ status: "failed", reason: "Independent review source evidence is no longer qualified" });
    await replaceReceipt(f.source.evidence, f.source.evidence.payload);
    await server.db.db.update(contextPacks).set({ payload: { invalid: true } }).where(eq(contextPacks.id, f.source.run.contextPackId!));
    expect(await f.inspect()).toMatchObject({ status: "failed", reason: "Independent review source evidence is no longer qualified" });
  });

  it("does not turn a structurally feasible declaration into semantic acceptance of an omitted native requirement", async () => {
    const fixture = measurementPlanEvidenceFixture(), configured = fixture.capabilities.checks[0]!;
    const research = ProductResearchReportSchema.parse({ version: 1, objective: nativeCriterion, assumptions: [],
      requirements: [{ id: "announce", description: nativeCriterion, priority: "must", acceptance_criteria: [nativeCriterion] }],
      sources: [{ id: "user", url: "https://example.com/controlled-requirement", title: "Controlled fixture", retrieved_at: "2026-11-05T00:00:00Z", content_digest: other }],
      findings: [{ summary: "Native announcement is explicitly required", source_ids: ["user"] }], decisions: [],
      measurement_plan: { version: 1, profile_digest: fixture.capabilities.profile_digest, entries: [{
        ...fixture.requirement.capability_binding!.checks[0], requirement_id: "announce", criterion_index: 0,
        actions: ["navigate", "assert_text"], keys: [], viewports: configured.contract.viewports, needs: [],
      }] } });
    // The omission is intentional: the pure evaluator can attest only to this declaration.
    const policy = fixture.capabilities.measurement_plan_policy;
    if (policy?.version !== 1) throw new Error("Expected the legacy measurement-policy fixture");
    const facts = evaluateDeclaredMeasurementPlanV1({ research, policy, capabilities: fixture.capabilities });
    const bytes = Buffer.from(JSON.stringify(research)), digest = (input: string | Buffer) => `sha256:${createHash("sha256").update(input).digest("hex")}`;
    const researchFact = { path: ".artoo/product/research.json" as const, checksum: digest(bytes), size: bytes.length };
    fixture.payload.required_files = fixture.payload.required_files.map(file => file.path === researchFact.path ? researchFact : file);
    fixture.payload.measurement_plan = { ...fixture.payload.measurement_plan!, research: researchFact,
      measurement_plan_digest: digest(facts.canonical_plan), must_criterion_count: facts.must_criterion_count,
      mapped_criterion_count: facts.mapped_criterion_count, used_checks: facts.used_checks };
    const f = await prepare(fixture);
    const findings = [{ severity: "blocking", file: ".artoo/product/research.json",
      description: "The original criterion requires native screen-reader announcements; the mapping declares only DOM text and omits the unsupported native need." }];
    await server.db.db.update(messages).set({ body: JSON.stringify({ ...f.verdict, outcome: "changes_requested", summary: "Original requirement is not covered", findings }) })
      .where(eq(messages.id, "measurement_response"));
    expect(await f.inspect()).toMatchObject({ status: "changes_requested", reason: expect.stringContaining("omits the unsupported native need") });
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, f.source.run.taskId)))[0]?.status).toBe("review");
    await server.db.db.update(messages).set({ body: JSON.stringify({ ...f.verdict, findings }) }).where(eq(messages.id, "measurement_response"));
    expect(await f.inspect()).toMatchObject({ status: "failed", failure: "invalid_verdict" });
  });
});
