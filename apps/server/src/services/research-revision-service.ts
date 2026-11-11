import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { agentInstances, appendEvent, computers, fileLeases, goalAutomations, goals, tasks, runs,
  goalImportedProductReviews as reviews, goalProductHandoffs as handoffs,
  goalResearchDestinationPools as pools, goalResearchDestinationSlots as slots, goalResearchRevisions as revisions } from "@artoo/db";
import { AutonomousSourceHandoffV1Schema, ImportedProductReviewRequestV1Schema, ImportedProductReviewResultV1Schema,
  PRODUCT_RESEARCH_REVISION_FEATURE_V1, ResearchDestinationSlotV1Schema,
  ResearchRevisionIntentV1Schema, ProductSourceHandoffIntentV1Schema, importedProductReviewRequestDigestV1, inspectImportedProductReviewResultV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { readContentAddressedBlob } from "../content-addressed-blob.js";
import { assertSemanticCapsuleResearch } from "../product-source-semantic-transfer-routes.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { requireActiveMember } from "./member-status.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { admitProductSourceSemanticTransferInTransaction } from "./product-source-transfer-service.js";
import { unsettledGoalRunIds, unsettledStandaloneExecutions, unconfirmedDisconnectRunIds } from "./execution-state.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";
import { assertSourceLineageDispatch } from "./source-lineage-fence.js";
import { readCurrentResearchHandoff, resolveResearchRevisionOrigin,
  researchRevisionHash as hash, researchDestinationWorkspaceKey, type ResearchRevision } from "./research-revision-origin-service.js";

type Automation = typeof goalAutomations.$inferSelect;
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function grant(ctx: ServerContext, tx: DrizzleDb, automation: Automation) {
  if (ctx.automationActor?.id !== "goal_runner" || ctx.actorUserId !== automation.actorUserId)
    throw AppError.permissionDenied("Only the initiating user's GoalRunner owns research revisions");
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [current] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, automation.goalId), eq(goalAutomations.organizationId, ctx.organizationId)));
  if (!goal || !current || current.actorUserId !== automation.actorUserId || current.planId !== automation.planId
    || current.consentId !== automation.consentId || current.policyVersion !== automation.policyVersion
    || current.executionMode !== "agent_team" || !current.releaseProfileId || !["executing", "waiting"].includes(current.status)
    || !AutonomousSourceHandoffV1Schema.safeParse(current.sourceHandoff).data?.research_revision
    || goal.status !== "running" || !current.planId || goal.currentPlanId !== current.planId)
    throw AppError.conflict("Research revision requires its original explicit configured-pool grant and running plan");
  await requireActiveMember(ctx, current.actorUserId, tx);
  await requireAiSharingAuthorization(ctx, tx, { consentId: current.consentId, policyVersion: current.policyVersion });
  const { budgets } = supportedGoalPolicy(goal.budgets, goal.stopConditions);
  if (budgets.max_elapsed_ms !== null && goal.runningSince !== null
    && Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(goal.runningSince)) >= budgets.max_elapsed_ms)
    throw AppError.conflict("Research revision reached the original elapsed goal budget", { budget: "max_elapsed_ms" });
  return { goal, automation: current, budgets };
}

/** Parent and scope are read from protected rows. No caller supplies a claimed verdict or a destination root. */
export async function ensureGoalResearchRevision(ctx: ServerContext, tx: DrizzleDb, original: Automation, parentReviewId: string): Promise<ResearchRevision> {
  const authorized = await grant(ctx, tx, original), { goal, automation, budgets } = authorized;
  const [parent] = await tx.select().from(reviews).where(and(eq(reviews.id, parentReviewId), eq(reviews.organizationId, ctx.organizationId)));
  if (!parent || parent.goalId !== goal.id || parent.planId !== automation.planId || parent.actorUserId !== automation.actorUserId
    || parent.consentId !== automation.consentId || parent.policyVersion !== automation.policyVersion || parent.stopRequested)
    throw AppError.conflict("Research revision has no matching original imported review");
  const current = await readCurrentResearchHandoff(ctx, tx, goal.id, parent.planId, parent.nextTaskId);
  if (!current) throw AppError.conflict("Research revision requires the original preconfigured destination pool");
  const { pool, snapshot, baseTask, plan } = current;
  if (pool.maxRetries !== budgets.max_retries || pool.actorUserId !== automation.actorUserId || pool.consentId !== automation.consentId
    || pool.policyVersion !== automation.policyVersion || automation.computerId !== pool.sourceComputerId || automation.workspaceRoot !== pool.sourceWorkspaceRoot
    || automation.verificationProfileId !== snapshot.source.release.binding.verification_profile_id || automation.releaseProfileId !== snapshot.source.release.binding.release_profile_id
    || plan.status !== "accepted") throw AppError.conflict("Research pool no longer matches the original execution grant");
  const [existing] = await tx.select().from(revisions).where(and(eq(revisions.parentReviewId, parent.id), eq(revisions.organizationId, ctx.organizationId)));
  if (existing) {
    if (existing.poolId !== pool.id || pool.currentRevisionId !== existing.id) throw AppError.conflict("An older research parent cannot replace the current successor");
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, existing.auxiliaryTaskId));
    if (!task || !await resolveResearchRevisionOrigin(ctx, tx, task)) throw AppError.conflict("Existing research successor lost its original auxiliary task");
    return existing;
  }
  if (current.handoffId !== parent.handoffId) throw AppError.conflict("Only the current leaf H2 may request a research successor");
  const request = ImportedProductReviewRequestV1Schema.parse(parent.request), result = ImportedProductReviewResultV1Schema.parse(parent.result);
  if (result.outcome !== "reviewed" || result.verdict.outcome !== "changes_requested" || !result.closed
    || parent.requestDigest !== importedProductReviewRequestDigestV1(request, sha) || result.request_digest !== parent.requestDigest)
    throw AppError.conflict("Research revision requires a closed substantive H2 rejection");
  const transfer = request.operation.intent.request, source = transfer.byte_request.source;
  const parentSlot = snapshot.members[current.revision?.generation ?? 0];
  if (!isDeepStrictEqual(transfer.source_export.measurement_v2?.source_release, snapshot.source.release)
    || source.node_id !== pool.sourceComputerId || source.workspace_root !== pool.sourceWorkspaceRoot
    || source.task_id !== (current.revision?.auxiliaryTaskId ?? baseTask.id)
    || source.run_id !== parent.sourceRunId || request.source_author.instance_id !== snapshot.source.writer.instance_id
    || request.source_author.agent_id !== snapshot.source.writer.agent_id || !parentSlot
    || request.reviewer.instance_id !== parentSlot.reviewer.instance_id || request.reviewer.agent_id !== parentSlot.reviewer.agent_id
    || request.operation.intent.destination_start.agent_instance_id !== parentSlot.writer.instance_id
    || !isDeepStrictEqual(transfer.measurement_v2?.destination_release, parentSlot.mapping.destination_release)
    || !isDeepStrictEqual(transfer.command_pairs, parentSlot.mapping.command_pairs))
    throw AppError.conflict("Rejected H2 no longer binds the original source lineage and author");
  // Repeat the existing transfer's independent source acceptance and current credential checks.
  await admitProductSourceSemanticTransferInTransaction(ctx, tx, transfer);
  const [parentHandoff] = await tx.select().from(handoffs).where(and(eq(handoffs.id, parent.handoffId), eq(handoffs.organizationId, ctx.organizationId)));
  if (!parentHandoff?.qualifiedReceipt || parentHandoff.stopRequested || hash(parentHandoff.intent) !== hash(request.operation.intent))
    throw AppError.conflict("Rejected H2 lost its qualified immutable transfer");
  const artifactStore = ctx.artifactStore ?? ctx.productSourceArtifactDir;
  if (!artifactStore) throw AppError.conflict("Research revision requires the protected capsule store");
  const capsule = await readContentAddressedBlob(artifactStore, source.capsule_digest, source.capsule_bytes);
  assertSemanticCapsuleResearch(capsule, transfer);
  const content = JSON.parse(capsule.toString("utf8")) as { files: Array<{ path: string; base64: string }> };
  const research = Buffer.from(content.files.find(file => file.path === ".artoo/product/research.json")!.base64, "base64");
  inspectImportedProductReviewResultV1(request, result, research, sha);
  if (budgets.max_retries === null || goal.retryCount >= budgets.max_retries)
    throw AppError.conflict("Goal retry budget would be exceeded", { budget: "max_retries" });
  const [next] = await tx.select().from(tasks).where(and(eq(tasks.id, pool.nextTaskId), eq(tasks.organizationId, ctx.organizationId))).for("update");
  if (!next || next.status !== "ready" || next.goalId !== goal.id || next.sourcePlanId !== plan.id || next.sourcePlanSpecRef !== "1")
    throw AppError.conflict("Research revision must precede the original dependent design task");
  const generation = (current.revision?.generation ?? 0) + 1;
  const [slot] = await tx.select().from(slots).where(and(eq(slots.poolId, pool.id), eq(slots.slotIndex, generation))).for("update");
  if (!slot || slot.status !== "reserved" || slot.revisionId || slot.handoffId || slot.organizationId !== ctx.organizationId)
    throw AppError.conflict("The next fresh research destination is unavailable; retained slots cannot be reused");
  const descriptor = ResearchDestinationSlotV1Schema.parse(slot.descriptor), member = snapshot.members[generation];
  if (!member || !isDeepStrictEqual(descriptor, member) || descriptor.slot_id !== slot.id || slot.mappingDigest !== hash(descriptor.mapping)
    || slot.workspaceRoot !== descriptor.mapping.destination_release.binding.workspace_root || slot.workspaceKey !== researchDestinationWorkspaceKey(slot.workspaceRoot)
    || slot.computerId !== snapshot.destination.computer_id || slot.writerInstanceId !== descriptor.writer.instance_id || slot.reviewerInstanceId !== descriptor.reviewer.instance_id)
    throw AppError.conflict("Reserved research destination differs from the original frozen pool");
  const roles = [snapshot.source.writer, snapshot.source.reviewer, descriptor.writer, descriptor.reviewer];
  for (const role of [...roles].sort((a, b) => a.instance_id.localeCompare(b.instance_id))) {
    const [instance] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, role.instance_id), eq(agentInstances.organizationId, ctx.organizationId))).for("update");
    const sourceRole = role.instance_id === snapshot.source.writer.instance_id || role.instance_id === snapshot.source.reviewer.instance_id;
    if (!instance || instance.agentId !== role.agent_id || instance.runtime !== role.runtime || instance.runtime === "mock"
      || instance.modelProfileId !== role.model_profile_id || instance.effortProfileId !== role.effort_profile_id
      || instance.computerId !== (sourceRole ? pool.sourceComputerId : slot.computerId)
      || instance.workspaceRoot !== (sourceRole ? pool.sourceWorkspaceRoot : slot.workspaceRoot) || instance.status !== "idle")
      throw AppError.conflict("Research revision's original participants are not available in their fixed scopes");
  }
  for (const computerId of [pool.sourceComputerId, slot.computerId].sort()) {
    const [computer] = await tx.select().from(computers).where(and(eq(computers.id, computerId), eq(computers.organizationId, ctx.organizationId))).for("update");
    if (!computer || computer.status !== "online" || !["windows", "win32"].includes(computer.os)) throw AppError.conflict("Research revision requires its paired native Windows nodes");
  }
  await assertSourceLineageDispatch(ctx, tx, pool.sourceComputerId, pool.sourceWorkspaceRoot);
  const sourceSession = ctx.getPairedNodeSession?.(pool.sourceComputerId), destinationSession = ctx.getPairedNodeSession?.(slot.computerId);
  const assertCurrent = () => {
    const binding = snapshot.source.release.binding, target = descriptor.mapping.destination_release.binding;
    if (!sourceSession || !destinationSession || !isDeepStrictEqual(sourceSession, ctx.getPairedNodeSession?.(pool.sourceComputerId))
      || !isDeepStrictEqual(destinationSession, ctx.getPairedNodeSession?.(slot.computerId))
      || ctx.supportsExecutionFeature?.(pool.sourceComputerId, PRODUCT_RESEARCH_REVISION_FEATURE_V1) !== true
      || !isDeepStrictEqual(ctx.getReleaseCapabilities?.(pool.sourceComputerId, binding.release_profile_id, snapshot.project_id, pool.sourceWorkspaceRoot, binding.verification_profile_id), snapshot.source.release)
      || !isDeepStrictEqual(ctx.getReleaseCapabilities?.(slot.computerId, target.release_profile_id, snapshot.project_id, slot.workspaceRoot, target.verification_profile_id), descriptor.mapping.destination_release)
      || !ctx.getProductSourceRouting?.(slot.computerId)?.destination_mappings.some(mapping => isDeepStrictEqual(mapping, descriptor.mapping)))
      throw AppError.conflict("Research revision lost its exact current local baseline feature or configured route");
  };
  assertCurrent();
  const live = await unsettledGoalRunIds(ctx, tx, goal.id), standalone = await unsettledStandaloneExecutions(ctx, tx, { goalId: goal.id });
  if (live.length || standalone.length) throw AppError.conflict("Research revision waits for actual closure of all original goal work");
  const uncertain = await unconfirmedDisconnectRunIds(ctx, tx, { computerId: pool.sourceComputerId });
  const occupied = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, pool.sourceComputerId),
    or(notInArray(runs.status, ["completed", "failed", "cancelled"]), uncertain.length ? inArray(runs.id, uncertain) : undefined)));
  if (occupied.some(run => !run.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, pool.sourceWorkspaceRoot, "windows")))
    throw AppError.conflict("The original research source workspace still has live or uncertain work");
  const leases = await tx.select({ run: runs }).from(fileLeases).leftJoin(runs, eq(runs.id, fileLeases.runId))
    .where(and(eq(fileLeases.organizationId, ctx.organizationId), eq(fileLeases.status, "held"),
      or(eq(runs.computerId, pool.sourceComputerId), and(isNull(fileLeases.runId), eq(fileLeases.projectId, goal.projectId)))));
  const sourceOperations = await unsettledStandaloneExecutions(ctx, tx, { computerId: pool.sourceComputerId });
  if (leases.some(({ run }) => !run?.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, pool.sourceWorkspaceRoot, "windows"))
    || sourceOperations.some(operation => !operation.workspaceRoot || automationWorkspacesOverlap(operation.workspaceRoot, pool.sourceWorkspaceRoot, "windows")))
    throw AppError.conflict("The original research source workspace has a retained lease or standalone operation");
  const id = ctx.idGen.generate("research_revision"), auxiliaryTaskId = ctx.idGen.generate("task"), now = ctx.clock.nowIso(), attempt = goal.retryCount + 1;
  const event = buildEvent(ctx, { type: "goal.research-revision.authorized", actorType: "system", actorId: "goal_runner", correlationId: id,
    projectId: goal.projectId, goalId: goal.id, taskId: auxiliaryTaskId });
  const intent = ResearchRevisionIntentV1Schema.parse({ version: 1, revision_id: id, project_id: goal.projectId, goal_id: goal.id, plan_id: plan.id,
    next_task_id: next.id, base_research_task_id: baseTask.id, auxiliary_task_id: auxiliaryTaskId, actor_user_id: automation.actorUserId,
    consent_id: automation.consentId, policy_version: automation.policyVersion, goal_digest: snapshot.goal_digest, plan_digest: snapshot.plan_digest,
    pool_id: pool.id, pool_digest: pool.snapshotDigest, slot_id: slot.id, generation, attempt_index: attempt, authorization_event_id: event.id,
    predecessor_revision_id: current.revision?.id ?? null,
    parent_review: { review_id: parent.id, handoff_id: parent.handoffId, request_digest: parent.requestDigest, result_digest: hash(result) },
    baseline: { version: 1, source_task_id: source.task_id, source_run_id: source.run_id, evidence_id: source.evidence_id,
      computer_id: source.node_id, workspace_root: source.workspace_root, profile_id: source.profile_id, profile_digest: source.profile_digest,
      subject_digest: source.subject_digest, capsule_digest: source.capsule_digest, capsule_bytes: source.capsule_bytes,
      export_digest: transfer.source_export_digest, provenance_digest: transfer.source_export.research_provenance_digest,
      research: transfer.source_export.research_provenance.research }, execution_authorized: false });
  const intentDigest = hash(intent);
  await tx.insert(tasks).values({ id: auxiliaryTaskId, organizationId: ctx.organizationId, projectId: goal.projectId, goalId: goal.id,
    roomId: baseTask.roomId, parentTaskId: baseTask.id, executionPolicyTaskId: baseTask.id, sourcePlanId: null, sourcePlanSpecRef: null,
    title: `Research revision ${generation}: ${baseTask.title}`.slice(0, 300), description: baseTask.description, status: "ready", priority: baseTask.priority,
    requiredCapabilities: baseTask.requiredCapabilities, acceptanceCriteria: baseTask.acceptanceCriteria,
    createdByType: "system", createdById: "goal_runner", createdAt: now, updatedAt: now });
  await appendEvent(tx, { ...event, payload: { revision_id: id, parent_review_id: parent.id, parent_request_digest: parent.requestDigest,
    parent_result_digest: hash(result), intent_digest: intentDigest, actor_user_id: automation.actorUserId, attempt_index: attempt, previous_retry_count: goal.retryCount,
    summary: result.verdict.summary, findings: result.verdict.findings, subsequent_stage_authorized: false } });
  const changed = await tx.update(goals).set({ retryCount: attempt, updatedAt: now }).where(and(eq(goals.id, goal.id), eq(goals.retryCount, goal.retryCount))).returning({ id: goals.id });
  if (changed.length !== 1) throw AppError.conflict("Original research retry counter changed");
  const [revision] = await tx.insert(revisions).values({ id, organizationId: ctx.organizationId, goalId: goal.id, planId: plan.id,
    nextTaskId: next.id, baseResearchTaskId: baseTask.id, auxiliaryTaskId, parentReviewId: parent.id,
    predecessorRevisionId: current.revision?.id ?? null, poolId: pool.id, slotId: slot.id, generation, attemptIndex: attempt,
    actorUserId: automation.actorUserId, consentId: automation.consentId, policyVersion: automation.policyVersion,
    authorizationEventId: event.id, intentDigest, intent, createdAt: now }).returning();
  const reserved = await tx.update(slots).set({ revisionId: id }).where(and(eq(slots.id, slot.id), isNull(slots.revisionId), isNull(slots.handoffId), eq(slots.status, "reserved"))).returning({ id: slots.id });
  const advanced = await tx.update(pools).set({ currentRevisionId: id }).where(and(eq(pools.id, pool.id), pool.currentRevisionId ? eq(pools.currentRevisionId, pool.currentRevisionId) : isNull(pools.currentRevisionId))).returning({ id: pools.id });
  if (reserved.length !== 1 || advanced.length !== 1) throw AppError.conflict("Research successor reservation changed");
  assertCurrent();
  return revision!;
}

/** Called only after the new source task was independently accepted and its H1 intent admitted. */
export async function bindResearchRevisionHandoff(ctx: ServerContext, tx: DrizzleDb, revisionId: string, handoffId: string): Promise<void> {
  const [initial] = await tx.select().from(revisions).where(and(eq(revisions.id, revisionId), eq(revisions.organizationId, ctx.organizationId)));
  if (!initial) throw AppError.notFound("Research revision not found");
  const [automation] = await tx.select().from(goalAutomations).where(eq(goalAutomations.goalId, initial.goalId));
  if (!automation) throw AppError.conflict("Research revision automation disappeared");
  await grant(ctx, tx, automation);
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, initial.auxiliaryTaskId));
  const origin = task ? await resolveResearchRevisionOrigin(ctx, tx, task) : undefined;
  const [handoff] = await tx.select().from(handoffs).where(and(eq(handoffs.id, handoffId), eq(handoffs.organizationId, ctx.organizationId)));
  const [slot] = await tx.select().from(slots).where(eq(slots.id, initial.slotId)).for("update");
  if (!origin || !task || task.status !== "done" || !handoff || handoff.goalId !== initial.goalId || handoff.planId !== initial.planId
    || handoff.nextTaskId !== initial.nextTaskId || !slot || slot.revisionId !== initial.id || slot.status === "uncertain")
    throw AppError.conflict("Research successor handoff lost its accepted origin or reserved slot");
  if (initial.handoffId !== null || slot.handoffId !== null) {
    if (initial.handoffId !== handoffId || slot.handoffId !== handoffId) throw AppError.conflict("Research successor is already bound to another handoff");
    return;
  }
  const intent = ProductSourceHandoffIntentV1Schema.parse(handoff.intent);
  // Existing transfer admission performs complete source/run/evidence/independent-review checks.
  await admitProductSourceSemanticTransferInTransaction(ctx, tx, intent.request);
  if (intent.request.byte_request.source.task_id !== task.id || intent.request.byte_request.destination.node_id !== slot.computerId
    || intent.request.byte_request.destination.workspace_root !== slot.workspaceRoot) throw AppError.conflict("Research successor transfer changed its exact source or destination");
  const bound = await tx.update(revisions).set({ handoffId }).where(and(eq(revisions.id, initial.id), isNull(revisions.handoffId))).returning({ id: revisions.id });
  const consumed = await tx.update(slots).set({ handoffId, status: "consumed" }).where(and(eq(slots.id, slot.id), isNull(slots.handoffId), eq(slots.status, "reserved"))).returning({ id: slots.id });
  if (bound.length !== 1 || consumed.length !== 1) throw AppError.conflict("Research successor handoff reservation changed");
}

export { researchRevisionContext } from "./research-revision-origin-service.js";
