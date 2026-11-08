import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { eventLog, goals, plans, tasks, goalResearchDestinationPools as pools,
  goalResearchDestinationSlots as slots, goalResearchRevisions as revisions } from "@artoo/db";
import { ResearchDestinationPoolSnapshotV1Schema, ResearchRevisionIntentV1Schema, ProductResearchRevisionContextV1Schema, TaskSpecSchema,
  canonicalResearchRevisionValueV1 as canonical, type ResearchRevisionIntentV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { canonicalAutomationWorkspace } from "./automation-workspace.js";

export const researchRevisionHash = (value: unknown): string => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
export const researchRevisionGoalDigest = (goal: Pick<typeof goals.$inferSelect, "id" | "projectId" | "objective" | "acceptanceCriteria">) =>
  researchRevisionHash({ id: goal.id, project_id: goal.projectId, objective: goal.objective, acceptance_criteria: goal.acceptanceCriteria });
export const researchRevisionPlanDigest = (plan: Pick<typeof plans.$inferSelect, "id" | "goalId" | "version" | "rationale" | "taskSpecs">) =>
  researchRevisionHash({ id: plan.id, goal_id: plan.goalId, version: plan.version, rationale: plan.rationale, task_specs: plan.taskSpecs });
export const researchDestinationWorkspaceKey = (root: string): string => canonicalAutomationWorkspace(root, "windows");
export type ResearchRevision = typeof revisions.$inferSelect;

export function researchRevisionContext(intent: ResearchRevisionIntentV1, intentDigest: string, authorRunId: string) {
  const checked = ResearchRevisionIntentV1Schema.parse(intent);
  if (researchRevisionHash(checked) !== intentDigest) throw AppError.conflict("Research revision context changed its authorization intent");
  return ProductResearchRevisionContextV1Schema.parse({ version: 1, revision_id: checked.revision_id, intent_digest: intentDigest,
    author_run_id: authorRunId, original_research_task_id: checked.base_research_task_id, goal_id: checked.goal_id, plan_id: checked.plan_id,
    parent_review: { review_id: checked.parent_review.review_id, request_digest: checked.parent_review.request_digest, result_digest: checked.parent_review.result_digest },
    baseline: checked.baseline });
}

/** Identity resolution only. Callers still enforce live authorization, consent, budgets and node ownership. */
export async function readResearchDestinationPool(ctx: ServerContext, tx: DrizzleDb, poolId: string) {
  const [pool] = await tx.select().from(pools).where(and(eq(pools.id, poolId), eq(pools.organizationId, ctx.organizationId)));
  if (!pool) throw AppError.conflict("Research destination pool is unavailable");
  const snapshot = ResearchDestinationPoolSnapshotV1Schema.parse(pool.snapshot);
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, pool.goalId), eq(goals.organizationId, ctx.organizationId)));
  const [plan] = await tx.select().from(plans).where(and(eq(plans.id, pool.planId), eq(plans.organizationId, ctx.organizationId)));
  const [baseTask] = await tx.select().from(tasks).where(and(eq(tasks.id, pool.baseResearchTaskId), eq(tasks.organizationId, ctx.organizationId)));
  const spec = plan && Array.isArray(plan.taskSpecs) ? TaskSpecSchema.safeParse(plan.taskSpecs[0]) : undefined;
  if (!goal || !plan || !baseTask || !spec?.success || spec.data.development_stage !== "research"
    || plan.goalId !== goal.id || pool.goalId !== snapshot.goal_id || pool.planId !== snapshot.plan_id
    || pool.nextTaskId !== snapshot.next_task_id || pool.baseResearchTaskId !== snapshot.base_research_task_id
    || pool.actorUserId !== snapshot.actor_user_id || pool.consentId !== snapshot.consent_id || pool.policyVersion !== snapshot.policy_version
    || goal.projectId !== snapshot.project_id || pool.sourceComputerId !== snapshot.source.computer_id
    || pool.sourceWorkspaceRoot !== snapshot.source.workspace_root || pool.maxRetries !== snapshot.max_retries
    || researchRevisionHash(snapshot) !== pool.snapshotDigest || researchRevisionGoalDigest(goal) !== snapshot.goal_digest
    || researchRevisionPlanDigest(plan) !== snapshot.plan_digest || baseTask.goalId !== goal.id || baseTask.projectId !== goal.projectId
    || baseTask.sourcePlanId !== plan.id || baseTask.sourcePlanSpecRef !== "0" || baseTask.status !== "done"
    || baseTask.parentTaskId !== null || baseTask.executionPolicyTaskId !== null
    || baseTask.title !== spec.data.title || baseTask.description !== spec.data.description
    || canonical(baseTask.acceptanceCriteria) !== canonical(spec.data.acceptance_criteria)
    || canonical(baseTask.requiredCapabilities) !== canonical(spec.data.required_capabilities)) {
    throw AppError.conflict("Research pool lost its exact original goal, plan, research specification or authorization");
  }
  return { pool, snapshot, goal, plan, baseTask, spec: spec.data, specRef: "0" as const };
}

/** Non-plan tasks are never implicitly research. Only the append-only revision relation can resolve one. */
export async function resolveResearchRevisionOrigin(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect,
  options: { requireCurrent?: boolean } = {}) {
  const [revision] = await tx.select().from(revisions).where(and(eq(revisions.auxiliaryTaskId, task.id), eq(revisions.organizationId, ctx.organizationId)));
  if (!revision) return undefined;
  const root = await readResearchDestinationPool(ctx, tx, revision.poolId), { pool, snapshot, baseTask } = root;
  const intent = ResearchRevisionIntentV1Schema.parse(revision.intent);
  const [event] = await tx.select().from(eventLog).where(and(eq(eventLog.id, revision.authorizationEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = event?.payload as Record<string, unknown> | undefined;
  if (task.organizationId !== ctx.organizationId || task.projectId !== baseTask.projectId || task.goalId !== pool.goalId
    || task.sourcePlanId !== null || task.sourcePlanSpecRef !== null || task.parentTaskId !== baseTask.id || task.executionPolicyTaskId !== baseTask.id
    || task.description !== baseTask.description || task.title !== `Research revision ${revision.generation}: ${baseTask.title}`.slice(0, 300)
    || canonical(task.acceptanceCriteria) !== canonical(baseTask.acceptanceCriteria) || canonical(task.requiredCapabilities) !== canonical(baseTask.requiredCapabilities)
    || revision.goalId !== pool.goalId || revision.planId !== pool.planId || revision.nextTaskId !== pool.nextTaskId || revision.baseResearchTaskId !== baseTask.id
    || revision.actorUserId !== pool.actorUserId || revision.consentId !== pool.consentId || revision.policyVersion !== pool.policyVersion
    || revision.intentDigest !== researchRevisionHash(intent) || intent.revision_id !== revision.id || intent.auxiliary_task_id !== task.id
    || intent.goal_id !== revision.goalId || intent.plan_id !== revision.planId || intent.next_task_id !== revision.nextTaskId
    || intent.base_research_task_id !== baseTask.id || intent.project_id !== task.projectId || intent.pool_id !== pool.id || intent.pool_digest !== pool.snapshotDigest
    || intent.slot_id !== revision.slotId || intent.generation !== revision.generation || intent.attempt_index !== revision.attemptIndex
    || intent.actor_user_id !== revision.actorUserId || intent.consent_id !== revision.consentId || intent.policy_version !== revision.policyVersion
    || intent.goal_digest !== snapshot.goal_digest || intent.plan_digest !== snapshot.plan_digest
    || intent.predecessor_revision_id !== revision.predecessorRevisionId || intent.parent_review.review_id !== revision.parentReviewId
    || intent.authorization_event_id !== revision.authorizationEventId || !event || event.type !== "goal.research-revision.authorized"
    || event.actorType !== "system" || event.actorId !== "goal_runner" || event.goalId !== revision.goalId || event.taskId !== task.id || event.projectId !== task.projectId
    || payload?.revision_id !== revision.id || payload.parent_review_id !== revision.parentReviewId || payload.intent_digest !== revision.intentDigest
    || payload.actor_user_id !== revision.actorUserId || payload.attempt_index !== revision.attemptIndex
    || payload.parent_request_digest !== intent.parent_review.request_digest || payload.parent_result_digest !== intent.parent_review.result_digest
    || payload.subsequent_stage_authorized !== false
    || payload.previous_retry_count !== revision.attemptIndex - 1
    || options.requireCurrent !== false && pool.currentRevisionId !== revision.id) {
    throw AppError.conflict("Auxiliary research task is not the exact authorized revision origin");
  }
  return { ...root, revision, intent };
}

/** null handoff means a current revision is authoring: the old H2 must stay fenced. */
export async function readCurrentResearchHandoff(ctx: ServerContext, tx: DrizzleDb, goalId: string, planId: string, nextTaskId: string) {
  const [initial] = await tx.select().from(pools).where(and(eq(pools.organizationId, ctx.organizationId), eq(pools.goalId, goalId),
    eq(pools.planId, planId), eq(pools.nextTaskId, nextTaskId)));
  if (!initial) return undefined;
  const root = await readResearchDestinationPool(ctx, tx, initial.id);
  if (!root.pool.currentRevisionId) {
    const [slot] = await tx.select().from(slots).where(and(eq(slots.poolId, initial.id), eq(slots.slotIndex, 0)));
    if (!slot) throw AppError.conflict("Initial research pool slot is missing");
    return { ...root, revision: undefined, handoffId: slot.handoffId };
  }
  const [revision] = await tx.select().from(revisions).where(and(eq(revisions.id, root.pool.currentRevisionId), eq(revisions.poolId, root.pool.id)));
  const [task] = revision ? await tx.select().from(tasks).where(eq(tasks.id, revision.auxiliaryTaskId)) : [];
  if (!revision || !task || !await resolveResearchRevisionOrigin(ctx, tx, task)) throw AppError.conflict("Current research revision is missing its auxiliary origin");
  return { ...root, revision, handoffId: revision.handoffId };
}
