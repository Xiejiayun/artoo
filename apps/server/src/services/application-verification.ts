import { autonomousReviews, eventLog, goalAutomations, runs, tasks } from "@artoo/db";
import { ApplicationDeliveryV1Schema, ContextPackSchema, type ApplicationCapabilitiesV1, type ApplicationRequirementV1,
  type RunVerificationPayload, type VerificationRequirement } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { readRunVerificationEvidence } from "./verification-service.js";

export function applicationRequirement(capabilities: ApplicationCapabilitiesV1,
  source?: NonNullable<RunVerificationPayload["application"]>): ApplicationRequirementV1 {
  return { version: 1, config_digest: capabilities.config_digest, contract_digest: capabilities.contract_digest,
    ...(source ? { expected_candidate: { candidate: source.candidate, origin_run_id: source.origin_run_id,
      origin_request_id: source.origin_request_id } } : {}) };
}

/** Re-qualify the original authorization and current node receipt; model output never grants application execution. */
export async function applicationVerificationQualificationError(ctx: ServerContext, db: DrizzleDb, runId: string,
  payload: RunVerificationPayload, requirement: VerificationRequirement, persistedContext: unknown): Promise<string | undefined> {
  const parsed = ContextPackSchema.safeParse(persistedContext), context = parsed.success ? parsed.data : undefined;
  const [owner] = await db.select({ run: runs, task: tasks, review: autonomousReviews, automation: goalAutomations }).from(runs).innerJoin(tasks,
    and(eq(tasks.id, runs.taskId), eq(tasks.organizationId, ctx.organizationId)))
    .leftJoin(autonomousReviews, and(eq(autonomousReviews.reviewTaskId, tasks.id), eq(autonomousReviews.organizationId, ctx.organizationId)))
    .leftJoin(goalAutomations, and(eq(goalAutomations.goalId, sql`coalesce(${autonomousReviews.goalId}, ${tasks.goalId})`),
      eq(goalAutomations.organizationId, ctx.organizationId)))
    .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)));
  const review = owner?.review, automation = owner?.automation, goalId = automation?.goalId;
  const grant = automation?.appDelivery;
  if (grant == null) return requirement.application || context?.app_delivery || payload.application
    ? "Application verification lacks original goal authorization" : undefined;
  if (!owner || !automation || !context || !ApplicationDeliveryV1Schema.safeParse(grant).success
    || !isDeepStrictEqual(grant, context.app_delivery) || automation.executionMode !== "agent_team"
    || automation.sourceHandoff != null || automation.releaseProfileId != null
    || owner.run.workspaceBranch != null || owner.run.computerId !== automation.computerId
    || owner.run.workspaceRoot !== automation.workspaceRoot || context.workspace.root !== automation.workspaceRoot
    || context.project.id !== owner.task.projectId || context.goal_context?.goal_id !== goalId
    || context.goal_context?.plan?.id !== automation.planId) return "Application verification lost its original goal or ordinary workspace binding";
  const [authorization] = await db.select().from(eventLog).where(and(eq(eventLog.organizationId, ctx.organizationId),
    eq(eventLog.goalId, goalId!), eq(eventLog.type, "goal.application-development.authorized"),
    eq(eventLog.actorType, "user"), eq(eventLog.actorId, automation.actorUserId))).limit(1);
  if (!authorization || authorization.projectId !== owner.task.projectId || !isDeepStrictEqual(authorization.payload,
    { version: 1, app_delivery: grant, consent_id: automation.consentId, policy_version: automation.policyVersion })) {
    return "Application verification lacks its original user's authorization event";
  }
  const capabilities = context.verification_capabilities, selected = capabilities?.application;
  const stage = context.product_development?.stage ?? context.review_subject?.development_stage;
  if (!capabilities || !selected || !requirement.application || !stage || capabilities.measurement_plan_policy || payload.measurement_plan
    || context.release_capabilities || requirement.release_capability_binding || !requirement.capability_binding
    || capabilities.profile_id !== requirement.profile_id || payload.outcome === "passed" && payload.profile_digest !== capabilities.profile_digest
    || automation.verificationProfileId !== requirement.profile_id
    || requirement.application.config_digest !== selected.config_digest || requirement.application.contract_digest !== selected.contract_digest) {
    return "Application verification differs from its fixed development capability";
  }
  const needed = stage === "implementation" || stage === "validation", source = context.review_subject?.verification?.application;
  if (!!review !== !!context.review_subject || review && (context.review_subject!.run_id !== review.subjectRunId
    || context.review_subject!.evidence_id !== review.evidenceId || context.review_subject!.subject_digest !== review.subjectDigest
    || review.reviewerInstanceId !== owner.run.agentInstanceId || review.subjectRunId === runId)) return "Application review context differs from its independent reviewer";
  const expected = review && needed ? source && applicationRequirement(selected, source) : applicationRequirement(selected);
  if (!expected || !isDeepStrictEqual(requirement.application, expected)
    || review && (requirement.expected_subject_digest !== review.subjectDigest || needed && (source!.origin_run_id !== review.subjectRunId
      || source!.run_id !== review.subjectRunId || source!.origin_request_id !== source!.request_id))) {
    return "Application review lacks the exact original candidate and author request";
  }
  if (payload.outcome !== "passed") return payload.application ? "Failed application verification cannot carry successful observation" : undefined;
  if (requirement.expected_subject_digest && payload.subject_digest !== requirement.expected_subject_digest) return "Application verification source changed";
  if (!needed) return payload.application ? "Application execution evidence is not valid for this development stage" : undefined;
  const actual = payload.application;
  if (!actual || actual.run_id !== runId || actual.request_id !== requirement.request_id || actual.stage !== stage
    || actual.candidate.subject_digest !== payload.subject_digest
    || actual.origin_run_id !== (review?.subjectRunId ?? runId)
    || actual.origin_request_id !== (source?.request_id ?? requirement.request_id)) {
    return "Application development lacks successful evidence bound to the current node run and original author";
  }
  if (source && (!isDeepStrictEqual(actual.candidate, source.candidate)
    || actual.acceptance.test_store_id === source.acceptance.test_store_id)) {
    return "Independent application review must reproduce the exact candidate using a fresh test store";
  }
  if (review && source) {
    // Review evidence cannot bootstrap another review or qualify a copied context after its author receipt changes.
    const [origin] = await db.select({ run: runs, review: autonomousReviews }).from(runs)
      .leftJoin(autonomousReviews, and(eq(autonomousReviews.reviewTaskId, runs.taskId), eq(autonomousReviews.organizationId, ctx.organizationId)))
      .where(and(eq(runs.id, review.subjectRunId), eq(runs.organizationId, ctx.organizationId)));
    if (!origin || origin.review || origin.run.taskId !== review.taskId || origin.run.status !== "completed"
      || origin.run.agentInstanceId === owner.run.agentInstanceId) return "Application review lost its original independent author";
    const evidence = await readRunVerificationEvidence(ctx, db, origin.run.id);
    if (!evidence || evidence.id !== review.evidenceId || evidence.payload.outcome !== "passed"
      || !isDeepStrictEqual(evidence.payload.application, source)) return "Application review source evidence is no longer qualified";
  }
  return undefined;
}
