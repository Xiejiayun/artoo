import { agentInstances, agents, assistantTurns, autonomousReviews, contextPacks, eventLog, goals, messages, rooms, runs, tasks } from "@artoo/db";
import { ContextPackSchema, type RunVerificationPayload } from "@artoo/domain";
import { eq } from "drizzle-orm";
import { inspectIndependentReview } from "../services/independent-review-service.js";
import { persistRunVerificationEvidence } from "../services/verification-service.js";
import { measurementPlanEvidenceFixture } from "./measurement-plan.js";
import type { TestServer } from "../test-support.js";
import type { AiSharingAuthorization } from "../services/ai-data-sharing-service.js";
const nativeCriterion = "A native screen reader announces every saved entry";
// Adapted from measurement-plan-review.test.ts. Controlled persisted node receipts only:
// this deliberately exercises the real qualifier, not a provider or process execution.
export async function prepareTransferReviewFixture(server: TestServer, f = measurementPlanEvidenceFixture(), authorization?: AiSharingAuthorization) {
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
        ...(authorization ? { requestedByUserId: server.ctx.actorUserId, aiDataSharingConsentId: authorization.consentId,
          aiDataSharingPolicyVersion: authorization.policyVersion } : {}),
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
