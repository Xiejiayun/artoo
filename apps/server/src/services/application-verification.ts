import { agentInstances, autonomousReviews, eventLog, goalAutomations, runs, tasks } from "@artoo/db";
import { ApplicationDeliveryV1Schema, ContextPackSchema, type ApplicationCapabilitiesV1, type ApplicationRequirementV1,
  APPLICATION_PUBLICATION_FEATURE_V1, ApplicationPublicationAuthorizationV1Schema, ApplicationPublicationCapabilitiesV1Schema,
  ApplicationPublicationGrantV1Schema, ApplicationPublicationIdentifierV1Schema,
  type ApplicationPublicationContextV1, type ApplicationPublicationVerificationBindingV1,
  type RunVerificationPayload, type VerificationRequirement } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { readRunVerificationEvidence } from "./verification-service.js";

export function applicationRequirement(capabilities: ApplicationCapabilitiesV1,
  source?: NonNullable<RunVerificationPayload["application"]>): ApplicationRequirementV1 {
  return { version: 1, config_digest: capabilities.config_digest, contract_digest: capabilities.contract_digest,
    ...(source ? { expected_candidate: { candidate: source.candidate, origin_run_id: source.origin_run_id,
      origin_request_id: source.origin_request_id } } : {}) };
}

/** Read the immutable user event, never infer a grant or replacement session from a live advertisement. */
export async function originalApplicationPublication(ctx: ServerContext, db: DrizzleDb,
  automation: typeof goalAutomations.$inferSelect, projectId: string): Promise<Omit<ApplicationPublicationContextV1, "agent_id" | "agent_instance_id">> {
  const grant = ApplicationPublicationGrantV1Schema.safeParse(automation.appPublication);
  const [event] = automation.applicationPublicationAuthorizationEventId ? await db.select().from(eventLog).where(and(
    eq(eventLog.id, automation.applicationPublicationAuthorizationEventId), eq(eventLog.organizationId, ctx.organizationId))) : [];
  const payload = event?.payload as Record<string, unknown> | undefined;
  const authorization = ApplicationPublicationAuthorizationV1Schema.safeParse(payload?.authorization);
  const capabilities = ApplicationPublicationCapabilitiesV1Schema.safeParse(payload?.capabilities);
  const session = ApplicationPublicationIdentifierV1Schema.safeParse(payload?.publisher_session_id);
  if (!grant.success || !event || !authorization.success || !capabilities.success || !session.success
    || automation.executionMode !== "agent_team" || automation.appDelivery != null || automation.sourceHandoff != null || automation.releaseProfileId != null
    || event.type !== "goal.application-publication.authorized" || event.actorType !== "user" || event.actorId !== automation.actorUserId
    || event.goalId !== automation.goalId || event.projectId !== projectId || payload?.verification_profile_id !== automation.verificationProfileId
    || authorization.data.event_id !== event.id || authorization.data.actor_user_id !== automation.actorUserId
    || authorization.data.consent_id !== automation.consentId || authorization.data.policy_version !== automation.policyVersion
    || !isDeepStrictEqual(authorization.data.grant, grant.data) || !isDeepStrictEqual(payload?.app_publication, grant.data)
    || capabilities.data.binding.project_id !== projectId || capabilities.data.binding.verification_profile_id !== automation.verificationProfileId
    || capabilities.data.binding.publication_profile_id !== grant.data.publication_profile_id
    || automation.computerId !== null && capabilities.data.binding.computer_id !== automation.computerId) {
    throw AppError.conflict("Application publication lost its original user's authorization event, capability or paired session");
  }
  return { version: 1, authorization: authorization.data, capabilities: capabilities.data, publisher_session_id: session.data };
}

export function assertCurrentApplicationPublication(ctx: ServerContext,
  publication: Omit<ApplicationPublicationContextV1, "agent_id" | "agent_instance_id">): void {
  const binding = publication.capabilities.binding, current = ctx.getPairedNodeSession?.(binding.computer_id);
  if (!current || current.computerId !== binding.computer_id || current.sessionId !== publication.publisher_session_id
    || ctx.supportsExecutionFeature?.(binding.computer_id, APPLICATION_PUBLICATION_FEATURE_V1) !== true
    || !isDeepStrictEqual(ctx.getApplicationPublicationCapabilities?.(binding.computer_id, binding.publication_profile_id, binding.project_id), publication.capabilities)) {
    throw AppError.conflict("Application publication requires its original paired connection and unchanged protected profile");
  }
}

export function applicationPublicationRequirement(context: Omit<ApplicationPublicationContextV1, "agent_id" | "agent_instance_id">): ApplicationPublicationVerificationBindingV1 {
  const binding = context.capabilities.binding;
  return { version: 1, authorization_event_id: context.authorization.event_id, publication_profile_id: binding.publication_profile_id,
    publication_profile_digest: binding.publication_profile_digest, publication_contract_digest: binding.publication_contract_digest,
    publisher_session_id: context.publisher_session_id };
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
  const grant = automation?.appDelivery, publicationGrant = automation?.appPublication;
  if (grant == null && publicationGrant == null) return requirement.application || requirement.application_publication
    || context?.app_delivery || context?.app_publication || context?.application_publication || payload.application
    ? "Application verification lacks original goal authorization" : undefined;
  if (!owner || !automation || !context || automation.executionMode !== "agent_team"
    || automation.sourceHandoff != null || automation.releaseProfileId != null
    || owner.run.workspaceBranch != null || owner.run.computerId !== automation.computerId
    || owner.run.workspaceRoot !== automation.workspaceRoot || context.workspace.root !== automation.workspaceRoot
    || context.project.id !== owner.task.projectId || context.goal_context?.goal_id !== goalId
    || context.goal_context?.plan?.id !== automation.planId) return "Application verification lost its original goal or ordinary workspace binding";
  if (publicationGrant != null) {
    let original;
    try { original = await originalApplicationPublication(ctx, db, automation, owner.task.projectId); }
    catch (error) { if (error instanceof AppError) return error.message; throw error; }
    const [instance] = await db.select().from(agentInstances).where(and(eq(agentInstances.id, owner.run.agentInstanceId),
      eq(agentInstances.organizationId, ctx.organizationId), eq(agentInstances.computerId, owner.run.computerId)));
    if (!instance || grant != null || context.app_delivery || !isDeepStrictEqual(context.app_publication, publicationGrant)
      || !isDeepStrictEqual(context.application_publication, { ...original, agent_id: instance.agentId, agent_instance_id: instance.id })
      || !isDeepStrictEqual(requirement.application_publication, applicationPublicationRequirement(original))) {
      return "Application publication verification differs from its original authorization, agent or paired connection";
    }
    const binding = original.capabilities.binding, selected = context.verification_capabilities;
    if (binding.computer_id !== owner.run.computerId || binding.verification_profile_digest !== selected?.profile_digest
      || binding.application_config_digest !== selected?.application?.config_digest || binding.application_contract_digest !== selected?.application?.contract_digest) {
      return "Application publication verification differs from its protected application capability";
    }
  } else {
    if (!ApplicationDeliveryV1Schema.safeParse(grant).success || !isDeepStrictEqual(grant, context.app_delivery)
      || context.app_publication || context.application_publication || requirement.application_publication || payload.application?.publication) {
      return "Development-only authorization cannot acquire application publication authority";
    }
    const [authorization] = await db.select().from(eventLog).where(and(eq(eventLog.organizationId, ctx.organizationId),
      eq(eventLog.goalId, goalId!), eq(eventLog.type, "goal.application-development.authorized"),
      eq(eventLog.actorType, "user"), eq(eventLog.actorId, automation.actorUserId))).limit(1);
    if (!authorization || authorization.projectId !== owner.task.projectId || !isDeepStrictEqual(authorization.payload,
      { version: 1, app_delivery: grant, consent_id: automation.consentId, policy_version: automation.policyVersion })) {
      return "Application verification lacks its original user's authorization event";
    }
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
  if (publicationGrant != null) {
    const measurement = actual.publication, publication = context.application_publication!;
    if (!measurement || measurement.authorization_event_id !== publication.authorization.event_id
      || measurement.publication_contract_digest !== publication.capabilities.binding.publication_contract_digest
      || source && !isDeepStrictEqual(source.publication, measurement)) return "Application publication lacks its original complete criterion measurement";
    for (const [path, checksum] of [[".artoo/product/research.json", measurement.research_digest],
      [".artoo/product/design.json", measurement.design_digest]] as const) {
      const observed = payload.required_files.find(file => file.path === path);
      const accepted = context.product_development?.accepted_inputs?.files.find(file => file.path === path);
      if (!observed || observed.checksum !== checksum || !review && (!accepted || accepted.checksum !== checksum || accepted.size !== observed.size)) {
        return "Application publication criterion measurement differs from its original accepted research or design";
      }
    }
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
