import { agentInstances, appendEvent, computers, goalResearchDestinationPools as pools,
  goalResearchDestinationSlots as slots, goals, plans, runs, tasks, goalAutomations, goalProductHandoffs, goalProductHandoffOperations } from "@artoo/db";
import { AutonomousSourceHandoffV1Schema, GoalBudgetsSchema, PRODUCT_RESEARCH_REVISION_FEATURE_V1,
  ResearchDestinationPoolSnapshotV1Schema, ResearchDestinationSlotV1Schema, ProductSourceHandoffIntentV1Schema,
  type ResearchDestinationSlotV1, type ResearchDestinationPoolSnapshotV1, type ProductSourceExportV2,
  type ProductSourceDestinationMappingV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { automationWorkspacesOverlap, canonicalAutomationWorkspace } from "./automation-workspace.js";
import { mappedCapabilities, routing, vacant, type ProductHandoffRoutingContext } from "./product-handoff-routing.js";
import { researchRevisionGoalDigest, researchRevisionPlanDigest, researchRevisionHash } from "./research-revision-origin-service.js";
import type { SchedulerCandidate } from "./scheduler.js";

type Instance = typeof agentInstances.$inferSelect;
type ScopedInstance = Pick<Instance, "id" | "computerId" | "workspaceRoot" | "agentId" | "runtime" | "modelProfileId" | "effortProfileId">;
type Role = ResearchDestinationSlotV1["writer"];
export const researchPoolRole = (candidate: SchedulerCandidate): Role => ({ instance_id: candidate.agent_instance_id,
  agent_id: candidate.agent_id, runtime: candidate.runtime, model_profile_id: candidate.model_profile_id,
  effort_profile_id: candidate.effort_profile_id });
const instanceRole = (instance: ScopedInstance): Role => ({ instance_id: instance.id, agent_id: instance.agentId,
  runtime: instance.runtime, model_profile_id: instance.modelProfileId, effort_profile_id: instance.effortProfileId });
const sameRole = (candidate: SchedulerCandidate, original: SchedulerCandidate) => candidate.agent_id === original.agent_id
  && candidate.runtime === original.runtime && candidate.model_profile_id === original.model_profile_id
  && candidate.effort_profile_id === original.effort_profile_id;
const runMatchesInstance = (run: typeof runs.$inferSelect, instance: Instance) => run.runtimeId === instance.runtime
  && run.modelProfileId === instance.modelProfileId && run.effortProfileId === instance.effortProfileId;

/** Select only prepared mappings and the exact logical roles selected for the
 * first hop. Newly advertised mappings cannot enlarge an already stored pool. */
export function selectResearchDestinationSlots(ctx: ProductHandoffRoutingContext & Pick<ServerContext, "idGen">, input: {
  computerId: string; maxRetries: number; proof: Pick<ProductSourceExportV2, "source_capabilities" | "measurement_v2">; firstMapping: ProductSourceDestinationMappingV1;
  writer: SchedulerCandidate; reviewer: SchedulerCandidate; writers: readonly SchedulerCandidate[];
  reviewers: readonly SchedulerCandidate[]; instances: readonly ScopedInstance[];
}): ResearchDestinationSlotV1[] {
  if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 10) {
    throw AppError.conflict("Research revision requires a finite retry budget of at most ten");
  }
  const configured = routing(ctx, input.computerId);
  if (!configured || !configured.destination_mappings.some(mapping => isDeepStrictEqual(mapping, input.firstMapping))) {
    throw AppError.conflict("The initial destination mapping is no longer prepared");
  }
  const mappings = [input.firstMapping, ...configured.destination_mappings
    .filter(mapping => !isDeepStrictEqual(mapping, input.firstMapping))
    .sort((a, b) => canonicalAutomationWorkspace(a.destination_release.binding.workspace_root, "windows")
      .localeCompare(canonicalAutomationWorkspace(b.destination_release.binding.workspace_root, "windows")))];
  const selected: ResearchDestinationSlotV1[] = [];
  for (const mapping of mappings) {
    const root = mapping.destination_release.binding.workspace_root;
    if (!mappedCapabilities(ctx, input.computerId, mapping, input.proof)) continue;
    const atRoot = (candidate: SchedulerCandidate) => candidate.computer_id === input.computerId
      && input.instances.some(instance => instance.id === candidate.agent_instance_id && instance.computerId === input.computerId
        && instance.workspaceRoot === root && isDeepStrictEqual(instanceRole(instance), researchPoolRole(candidate)));
    const writer = input.writers.find(candidate => atRoot(candidate) && sameRole(candidate, input.writer)
      && (selected.length > 0 || candidate.agent_instance_id === input.writer.agent_instance_id));
    const reviewer = input.reviewers.find(candidate => atRoot(candidate) && sameRole(candidate, input.reviewer)
      && (selected.length > 0 || candidate.agent_instance_id === input.reviewer.agent_instance_id));
    if (!writer || !reviewer) continue;
    if (selected.some(slot => automationWorkspacesOverlap(slot.mapping.destination_release.binding.workspace_root, root, "windows"))) {
      throw AppError.conflict("Configured research destinations must have disjoint physical scopes");
    }
    selected.push(ResearchDestinationSlotV1Schema.parse({ slot_id: ctx.idGen.generate("research_slot"), index: selected.length,
      mapping, writer: researchPoolRole(writer), reviewer: researchPoolRole(reviewer) }));
    if (selected.length === input.maxRetries + 1) break;
  }
  if (selected.length !== input.maxRetries + 1 || !isDeepStrictEqual(selected[0]?.mapping, input.firstMapping)) {
    throw AppError.conflict("Research revision requires a complete prepared destination pool and the original two logical contributors");
  }
  return selected;
}

export function researchRevisionPoolRequested(automation: typeof goalAutomations.$inferSelect): boolean {
  return automation.sourceHandoff != null
    && AutonomousSourceHandoffV1Schema.parse(automation.sourceHandoff).research_revision?.strategy === "configured_pool";
}

/** Read under the same computer lock as assignment. Even a closed/failed import
 * retains its reservation; another goal or ordinary writer cannot borrow it. */
export async function assertResearchDestinationUnreserved(ctx: ServerContext, tx: DrizzleDb,
  computerId: string, workspaceRoot: string | null | undefined): Promise<void> {
  const [computer] = await tx.select().from(computers).where(and(eq(computers.id, computerId),
    eq(computers.organizationId, ctx.organizationId))).for("update");
  if (!computer) throw AppError.conflict("Destination computer is unavailable");
  const reserved = await tx.select().from(slots).where(and(eq(slots.organizationId, ctx.organizationId), eq(slots.computerId, computerId)));
  if (reserved.some(slot => !workspaceRoot || automationWorkspacesOverlap(slot.workspaceRoot, workspaceRoot, computer.os))) {
    throw AppError.conflict("The workspace belongs to a retained research destination reservation");
  }
}

/** Called inside initial handoff admission, after locking ALL selected instance
 * rows in ID order and then the destination computer. This avoids acquiring a
 * second instance lock behind the ordinary assignment computer fence. */
export async function persistResearchDestinationPool(ctx: ServerContext, tx: DrizzleDb, input: {
  automation: typeof goalAutomations.$inferSelect; goal: typeof goals.$inferSelect; plan: typeof plans.$inferSelect;
  sourceTask: typeof tasks.$inferSelect; sourceRun: typeof runs.$inferSelect; sourceReviewerRunId: string;
  members: ResearchDestinationSlotV1[]; destinationComputer: typeof computers.$inferSelect; handoffId: string;
}): Promise<ResearchDestinationPoolSnapshotV1> {
  const { automation, goal, plan, sourceTask, sourceRun, members, destinationComputer } = input;
  if (!researchRevisionPoolRequested(automation) || ctx.automationActor?.id !== "goal_runner" || ctx.actorUserId !== automation.actorUserId
    || automation.goalId !== goal.id || automation.planId !== plan.id || automation.executionMode !== "agent_team"
    || goal.status !== "running" || goal.currentPlanId !== plan.id || plan.status !== "accepted"
    || sourceTask.sourcePlanId !== plan.id || sourceTask.sourcePlanSpecRef !== "0" || sourceTask.status !== "done"
    || sourceRun.taskId !== sourceTask.id || sourceRun.status !== "completed" || sourceRun.computerId !== automation.computerId
    || sourceRun.workspaceRoot !== automation.workspaceRoot || !sourceRun.workspaceRoot
    || ctx.supportsExecutionFeature?.(sourceRun.computerId, PRODUCT_RESEARCH_REVISION_FEATURE_V1) !== true) {
    throw AppError.conflict("Research pool admission requires its original running grant and revision-capable source");
  }
  const [handoff] = await tx.select().from(goalProductHandoffs).where(and(eq(goalProductHandoffs.id, input.handoffId),
    eq(goalProductHandoffs.organizationId, ctx.organizationId)));
  if (!handoff || handoff.goalId !== goal.id || handoff.planId !== plan.id || handoff.sourceRunId !== sourceRun.id
    || handoff.actorUserId !== automation.actorUserId || handoff.consentId !== automation.consentId || handoff.policyVersion !== automation.policyVersion) {
    throw AppError.conflict("Research pool has no exact initial handoff");
  }
  const intent = ProductSourceHandoffIntentV1Schema.parse(handoff.intent), base = intent.request.byte_request, first = members[0];
  if (!first || base.source.reviewer_run_id !== input.sourceReviewerRunId || base.destination.node_id !== destinationComputer.id
    || base.destination.workspace_root !== first.mapping.destination_release.binding.workspace_root
    || intent.destination_start.agent_instance_id !== first.writer.instance_id
    || !isDeepStrictEqual(intent.request.measurement_v2?.destination_release, first.mapping.destination_release)) {
    throw AppError.conflict("Research pool first slot differs from the admitted handoff");
  }
  const sourceRelease = intent.request.source_export.measurement_v2?.source_release;
  const [reviewRun] = await tx.select().from(runs).where(and(eq(runs.id, input.sourceReviewerRunId), eq(runs.organizationId, ctx.organizationId)));
  const allInstances = await tx.select().from(agentInstances).where(and(eq(agentInstances.organizationId, ctx.organizationId), eq(agentInstances.projectId, goal.projectId)));
  const author = allInstances.find(instance => instance.id === sourceRun.agentInstanceId);
  const reviewer = allInstances.find(instance => instance.id === reviewRun?.agentInstanceId);
  if (!sourceRelease || !reviewRun || reviewRun.status !== "completed" || !author || !reviewer
    || [author, reviewer].some(instance => instance.computerId !== sourceRun.computerId || instance.workspaceRoot !== sourceRun.workspaceRoot)
    || !runMatchesInstance(sourceRun, author) || !runMatchesInstance(reviewRun, reviewer)) {
    throw AppError.conflict("Research pool source participants changed after the accepted research");
  }
  const snapshot = ResearchDestinationPoolSnapshotV1Schema.parse({ version: 1, project_id: goal.projectId, goal_id: goal.id,
    plan_id: plan.id, next_task_id: handoff.nextTaskId, base_research_task_id: sourceTask.id,
    actor_user_id: automation.actorUserId, consent_id: automation.consentId, policy_version: automation.policyVersion,
    goal_digest: researchRevisionGoalDigest(goal), plan_digest: researchRevisionPlanDigest(plan),
    max_retries: GoalBudgetsSchema.parse(goal.budgets).max_retries,
    source: { computer_id: sourceRun.computerId, workspace_root: sourceRun.workspaceRoot, release: sourceRelease,
      writer: instanceRole(author), reviewer: instanceRole(reviewer) },
    destination: { computer_id: destinationComputer.id, writer_agent_id: first.writer.agent_id, reviewer_agent_id: first.reviewer.agent_id }, members });
  const ownOperations = (await tx.select({ id: goalProductHandoffOperations.id }).from(goalProductHandoffOperations)
    .where(eq(goalProductHandoffOperations.handoffId, handoff.id))).map(operation => operation.id);
  for (const slot of snapshot.members) {
    const root = slot.mapping.destination_release.binding.workspace_root;
    await assertResearchDestinationUnreserved(ctx, tx, destinationComputer.id, root);
    if (!await vacant(ctx, tx, destinationComputer, root, goal.id, ownOperations)
      || !routing(ctx, destinationComputer.id)?.destination_mappings.some(mapping => isDeepStrictEqual(mapping, slot.mapping))
      || !mappedCapabilities(ctx, destinationComputer.id, slot.mapping, intent.request.source_export)
      || [slot.writer, slot.reviewer].some(role => !allInstances.some(instance => instance.computerId === destinationComputer.id
        && instance.workspaceRoot === root && isDeepStrictEqual(instanceRole(instance), role)))) {
      throw AppError.conflict("Research destination pool changed or became occupied during admission");
    }
  }
  const id = ctx.idGen.generate("research_pool"), now = ctx.clock.nowIso(), digest = researchRevisionHash(snapshot);
  await tx.insert(pools).values({ id, organizationId: ctx.organizationId, goalId: goal.id, planId: plan.id,
    nextTaskId: handoff.nextTaskId, baseResearchTaskId: sourceTask.id, actorUserId: automation.actorUserId,
    consentId: automation.consentId, policyVersion: automation.policyVersion, sourceComputerId: sourceRun.computerId,
    sourceWorkspaceRoot: sourceRun.workspaceRoot, maxRetries: snapshot.max_retries, snapshotDigest: digest, snapshot, createdAt: now });
  await tx.insert(slots).values(snapshot.members.map(slot => ({ id: slot.slot_id, poolId: id, organizationId: ctx.organizationId,
    slotIndex: slot.index, computerId: destinationComputer.id, workspaceRoot: slot.mapping.destination_release.binding.workspace_root,
    workspaceKey: canonicalAutomationWorkspace(slot.mapping.destination_release.binding.workspace_root, destinationComputer.os),
    mappingDigest: researchRevisionHash(slot.mapping), descriptor: slot, writerInstanceId: slot.writer.instance_id,
    reviewerInstanceId: slot.reviewer.instance_id, status: "reserved", createdAt: now })));
  await tx.update(slots).set({ status: "consumed", handoffId: handoff.id }).where(eq(slots.id, first.slot_id));
  await appendEvent(tx, buildEvent(ctx, { type: "goal.research-destination-pool.reserved", actorType: "system", actorId: "goal_runner",
    goalId: goal.id, projectId: goal.projectId, correlationId: id,
    payload: { version: 1, pool_id: id, snapshot_digest: digest, actor_user_id: automation.actorUserId, slot_count: snapshot.members.length } }));
  return snapshot;
}
