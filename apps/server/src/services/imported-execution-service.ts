import { assertSourceLineageDispatch } from "./source-lineage-fence.js";
import { agentInstances, approvals, appendEvent, computers, contextPacks, devices, deviceTokens, eventLog, goalAutomations, goals, plans, runs, tasks,
  goalImportedDesignContinuations, goalImportedDesignReviews, goalImportedDesignReviewReceipts,
  goalImportedProductReviews, goalProductHandoffs, goalImportedExecutions as executions,
  goalImportedExecutionDeliveries as deliveries, goalImportedExecutionCompletions as completions, goalImportedExecutionReceipts } from "@artoo/db";
import { AutonomousTeamSchema, ContextPackSchema, TaskSpecSchema, ImportedDesignReviewRequestV1Schema, ImportedDesignReviewResultV1Schema,
  ImportedExecutionRequestV1Schema, ImportedExecutionResultV1Schema, IMPORTED_EXECUTION_FEATURE_V1,
  importedExecutionContextV1, importedExecutionAcceptedInputsV1, importedExecutionRequestDigestV1,
  inspectImportedExecutionRequestV1, inspectImportedExecutionResultV1, inspectImportedCompletedExecutionV1,
  importedDesignReviewRequestDigestV1, inspectImportedDesignReviewResultV1, productDevelopmentContext,
  canonicalProductSourceTransferValueV1 as canonical, type Capability } from "@artoo/domain";
import { importedExecutionAckSchema, importedExecutionResultSchema, type ImportedExecutionAck, type ImportedExecutionResult,
  type NodeTransport, type ServerToNodeMessage } from "@artoo/protocol";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, isNull } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { readContentAddressedBlob } from "../content-addressed-blob.js";
import { assertSemanticCapsuleResearch } from "../product-source-semantic-transfer-routes.js";
import { admitProductSourceSemanticTransferInTransaction, assertMeasurementV2TransferSessions, type AuthenticatedTransferNode } from "./product-source-transfer-service.js";
import { requireActiveMember } from "./member-status.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { scheduleTask } from "./scheduler.js";
import { unsettledGoalExecutionCount, unsettledStandaloneExecutions, unconfirmedDisconnectRunIds } from "./execution-state.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";
import { assertSupportedPlanTaskControls } from "./plan-policy.js";
import { assertExecutionApprovalGranted, bindExecutionApprovalToRun, EXECUTION_GATE_CURRENT, EXECUTION_GATE_SUPERSEDED } from "./approval-service.js";
import { transitionRun, transitionTask } from "./transition-service.js";
import { releaseRunLeases } from "./lease-service.js";
import { inspectRunVerification } from "./verification-service.js";
import { readCompletedImportedDesign, importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";

type Execution = typeof executions.$inferSelect;
type Automation = typeof goalAutomations.$inferSelect;
type Control = "start" | "stop" | "status";
const closed = (result: unknown) => ImportedExecutionResultV1Schema.safeParse(result).data?.closed === true;
const actorContext = (ctx: ServerContext, actorUserId: string): ServerContext => ({ ...ctx, actorUserId, automationActor: { type: "system", id: "goal_runner" } });
function originalActor(ctx: ServerContext, actor: string) {
  if (ctx.automationActor?.id !== "goal_runner" || ctx.actorUserId !== actor) throw AppError.permissionDenied("Only the initiating user's GoalRunner owns H5 execution");
}
async function researchBytes(ctx: ServerContext, request: ReturnType<typeof ImportedDesignReviewRequestV1Schema.parse>) {
  if (!ctx.productSourceArtifactDir) throw AppError.conflict("H5 requires the protected source artifact store");
  const transfer = request.continuation_request.review_request.operation.intent.request, source = transfer.byte_request.source;
  const bytes = await readContentAddressedBlob(ctx.productSourceArtifactDir, source.capsule_digest, source.capsule_bytes);
  assertSemanticCapsuleResearch(bytes, transfer);
  const capsule = JSON.parse(bytes.toString("utf8")) as { files: { path: string; base64: string }[] };
  return Buffer.from(capsule.files.find(file => file.path === ".artoo/product/research.json")!.base64, "base64");
}
async function credential(ctx: ServerContext, tx: DrizzleDb, identity: AuthenticatedTransferNode) {
  const [observed] = await tx.select().from(devices).where(and(eq(devices.id, identity.deviceId), eq(devices.organizationId, ctx.organizationId)));
  if (!observed) throw AppError.permissionDenied("H5 requires a paired device");
  await requireActiveMember(ctx, observed.enrolledByUserId, tx);
  const [device] = await tx.select().from(devices).where(and(eq(devices.id, identity.deviceId), eq(devices.organizationId, ctx.organizationId))).for("update");
  const [token] = await tx.select().from(deviceTokens).where(and(eq(deviceTokens.deviceId, identity.deviceId), eq(deviceTokens.organizationId, ctx.organizationId),
    eq(deviceTokens.tokenLookup, identity.tokenLookup), eq(deviceTokens.kind, "node"), eq(deviceTokens.status, "active"), isNull(deviceTokens.revokedAt))).for("update");
  if (!device || device.trust !== "active" || device.revokedAt !== null || device.computerId !== identity.computerId || device.enrolledByUserId !== observed.enrolledByUserId
    || !token || token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.parse(ctx.clock.nowIso())) throw AppError.permissionDenied("H5 paired credential is no longer current");
}

/** Admission preserves A's research and B's accepted design; it never retargets the automation row. */
async function facts(ctx: ServerContext, tx: DrizzleDb, reviewId: string, own?: Execution, completion = false, implementationReview = false) {
  const [initial] = await tx.select().from(goalImportedDesignReviews).where(and(eq(goalImportedDesignReviews.id, reviewId), eq(goalImportedDesignReviews.organizationId, ctx.organizationId)));
  if (!initial) throw AppError.notFound("H4 review not found");
  originalActor(ctx, initial.actorUserId);
  const request = ImportedDesignReviewRequestV1Schema.parse(initial.request), result = ImportedDesignReviewResultV1Schema.parse(initial.result);
  const original = request.continuation_request, transfer = original.review_request.operation.intent.request, base = transfer.byte_request;
  await admitProductSourceSemanticTransferInTransaction(ctx, tx, transfer);
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, initial.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [designTask] = await tx.select().from(tasks).where(and(eq(tasks.id, initial.taskId), eq(tasks.organizationId, ctx.organizationId))).for("update");
  const [continuation] = await tx.select().from(goalImportedDesignContinuations).where(and(eq(goalImportedDesignContinuations.id, initial.continuationId), eq(goalImportedDesignContinuations.organizationId, ctx.organizationId))).for("update");
  const [review] = await tx.select().from(goalImportedDesignReviews).where(eq(goalImportedDesignReviews.id, reviewId));
  const [automation] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, initial.goalId), eq(goalAutomations.organizationId, ctx.organizationId)));
  const [plan] = await tx.select().from(plans).where(and(eq(plans.id, initial.planId), eq(plans.organizationId, ctx.organizationId)));
  if (!goal || goal.status !== "running" || goal.currentPlanId !== initial.planId || !plan || plan.status !== "accepted"
    || !automation || automation.executionMode !== "agent_team" || !["executing", "waiting"].includes(automation.status) || automation.planId !== plan.id
    || automation.actorUserId !== initial.actorUserId || automation.consentId !== initial.consentId || automation.policyVersion !== initial.policyVersion
    || !designTask || designTask.status !== "done" || designTask.goalId !== goal.id || designTask.sourcePlanId !== plan.id || designTask.projectId !== base.project_id
    || !continuation || continuation.stopRequested || canonical(continuation.request) !== canonical(original) || canonical(continuation.result) !== canonical(request.continuation_result)
    || !review || canonical(review) !== canonical(initial) || review.stopRequested || !review.acceptedAt || !review.acceptanceEventId
    || result.outcome !== "reviewed" || !result.closed || result.verdict.outcome !== "accepted" || review.requestDigest !== importedDesignReviewRequestDigestV1(request, sha)
    || review.resultDigest !== hash(result) || own?.stopRequested) throw AppError.conflict("H5 requires the exact current authorized accepted H4 design");
  const completed = await readCompletedImportedDesign(ctx, tx, continuation);
  const [accepted] = await tx.select().from(eventLog).where(and(eq(eventLog.id, review.acceptanceEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const [receipt] = await tx.select().from(goalImportedDesignReviewReceipts).where(and(eq(goalImportedDesignReviewReceipts.reviewId, review.id), eq(goalImportedDesignReviewReceipts.organizationId, ctx.organizationId)));
  const payload = accepted?.payload as Record<string, unknown> | undefined;
  if (!accepted || accepted.type !== "goal.imported-design-review.accepted" || accepted.actorType !== "system" || accepted.actorId !== "goal_runner"
    || accepted.goalId !== goal.id || accepted.taskId !== designTask.id || accepted.runId !== continuation.runId
    || payload?.review_id !== review.id || payload.result_digest !== review.resultDigest || payload.actor_user_id !== review.actorUserId
    || payload.completed_design_digest !== completed.provenance.completedDesignDigest || payload.verification_evidence_id !== completed.evidence.id
    || !receipt || receipt.deliveryId !== review.resultDeliveryId || receipt.requestDigest !== review.requestDigest || receipt.resultDigest !== review.resultDigest
    || receipt.sessionId !== review.resultSessionId || canonical(receipt.sessionBindings) !== canonical(review.sessionBindings)) throw AppError.conflict("H5 lacks distinct trusted H4 acceptance and receipt provenance");
  const source = ctx.getPairedNodeSession?.(base.source.node_id), destination = ctx.getPairedNodeSession?.(base.destination.node_id);
  if (!source || !destination) throw AppError.conflict("H5 requires both current paired sessions");
  const sessionBindings = { source, destination };
  if (canonical(sessionBindings) !== canonical(review.sessionBindings)
    || destination.sessionId !== completed.provenance.sessionId || own && canonical(own.sessionBindings) !== canonical(sessionBindings)) throw AppError.conflict("H5 cannot reuse H4 authority in a new session");
  const team = AutonomousTeamSchema.parse(automation.team);
  if (team.members.find(member => member.stage === "design")?.agent_instance_id !== continuation.writerInstanceId
    || !team.reviewer_instance_ids.includes(review.reviewerInstanceId)) throw AppError.conflict("Accepted design participants are no longer in the authorized team");
  const siblings = await tx.select().from(tasks).where(and(eq(tasks.goalId, goal.id), eq(tasks.sourcePlanId, plan.id), eq(tasks.organizationId, ctx.organizationId)));
  const specs = (plan.taskSpecs as unknown[]).map(value => TaskSpecSchema.parse(value));
  const designIndex = Number(designTask.sourcePlanSpecRef), designSpec = specs[designIndex], sourceTask = siblings.find(task => task.id === base.source.task_id);
  const designDependencies = designSpec?.dependencies.filter(edge => edge.type !== "soft_context");
  const designRuns = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.taskId, designTask.id), eq(runs.organizationId, ctx.organizationId)));
  if (designTask.sourcePlanSpecRef === null || String(designIndex) !== designTask.sourcePlanSpecRef || designSpec?.development_stage !== "design"
    || !sourceTask || sourceTask.status !== "done" || designDependencies?.length !== 1 || designDependencies[0]!.ref !== sourceTask.sourcePlanSpecRef
    || !["blocks", "artifact_required"].includes(designDependencies[0]!.type)
    || designTask.title !== designSpec.title || designTask.description !== designSpec.description
    || canonical(designTask.acceptanceCriteria) !== canonical(designSpec.acceptance_criteria) || canonical(designTask.requiredCapabilities) !== canonical(designSpec.required_capabilities)
    || canonical(original.run_start.context_pack.payload.task) !== canonical({ id: designTask.id, title: designTask.title, description: designTask.description, acceptance_criteria: designTask.acceptanceCriteria })
    || designRuns.length !== 1 || designRuns[0]!.id !== continuation.runId) throw AppError.conflict("H5 accepted design task/specification or original author changed");
  assertSupportedPlanTaskControls(designSpec, designIndex);
  const eligible = siblings.filter(task => {
    const index = Number(task.sourcePlanSpecRef), spec = specs[index];
    return task.sourcePlanSpecRef !== null && String(index) === task.sourcePlanSpecRef && spec?.development_stage === "implementation"
      && spec.dependencies.some(edge => edge.ref === designTask.sourcePlanSpecRef && edge.type !== "soft_context")
      && spec.dependencies.filter(edge => edge.type !== "soft_context").every(edge => siblings.some(item => item.sourcePlanSpecRef === edge.ref && item.status === "done"));
  }).sort((a, b) => Number(a.sourcePlanSpecRef) - Number(b.sourcePlanSpecRef));
  const chosen = own ? eligible.find(task => task.id === own.taskId) : eligible[0];
  const [task] = chosen ? await tx.select().from(tasks).where(eq(tasks.id, chosen.id)).for("update") : [];
  const index = Number(task?.sourcePlanSpecRef), spec = specs[index];
  if (!task || !spec || task.projectId !== base.project_id || task.executionPolicyTaskId !== null || task.parentTaskId !== null
    || !(implementationReview ? ["assigned", "running", "review", "done"] : own ? completion ? ["running", "review"] : ["assigned"] : ["backlog", "ready"]).includes(task.status)
    || task.title !== spec.title || task.description !== spec.description || canonical(task.acceptanceCriteria) !== canonical(spec.acceptance_criteria)
    || canonical(task.requiredCapabilities) !== canonical(spec.required_capabilities)) throw AppError.conflict("H5 needs one exact implementation successor of its accepted design");
  assertSupportedPlanTaskControls(spec, index);
  const expectedGoal = { version: 1, goal_id: goal.id, objective: goal.objective, acceptance_criteria: goal.acceptanceCriteria,
    plan: { id: plan.id, version: plan.version, rationale: plan.rationale ?? "", spec_ref: designTask.sourcePlanSpecRef } };
  if (canonical(original.run_start.context_pack.payload.goal_context) !== canonical(expectedGoal)) throw AppError.conflict("H5 original goal/plan changed");
  const { budgets } = supportedGoalPolicy(goal.budgets, goal.stopConditions);
  if (budgets.max_elapsed_ms !== null && goal.runningSince !== null && Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(goal.runningSince)) >= budgets.max_elapsed_ms
    || budgets.max_retries !== null && goal.retryCount > budgets.max_retries) throw AppError.conflict("H5 goal budget reached");
  const count = await unsettledGoalExecutionCount(ctx, tx, goal.id);
  if (!completion && budgets.max_concurrent_runs !== null && count + (own ? 0 : 1) > budgets.max_concurrent_runs) throw AppError.conflict("H5 concurrent run budget reached");
  const writerId = team.members.find(member => member.stage === "implementation")?.agent_instance_id;
  if (!writerId) throw AppError.conflict("H5 has no configured implementation author");
  const [writer] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, writerId), eq(agentInstances.organizationId, ctx.organizationId))).for("update");
  const [computer] = writer ? await tx.select().from(computers).where(and(eq(computers.id, writer.computerId), eq(computers.organizationId, ctx.organizationId))).for("update") : [];
  if (!writer || !computer || !["windows", "win32"].includes(computer.os) || computer.status !== "online" || writer.runtime === "mock"
    || writer.computerId !== base.destination.node_id || writer.workspaceRoot !== base.destination.workspace_root
    || own && (writer.id !== own.writerInstanceId || writer.agentId !== own.writerAgentId || writer.runtime !== ImportedExecutionRequestV1Schema.parse(own.request).run_start.runtime)
    || ctx.supportsExecutionFeature?.(computer.id, IMPORTED_EXECUTION_FEATURE_V1) !== true) throw AppError.conflict("H5 requires its configured native Windows implementation author on B");
  const options = { mode: "manual" as const, projectId: task.projectId, agentInstanceId: writer.id, branchBacked: false, allowedRuntimes: budgets.allowed_runtimes,
    ...(own ? { importedExecutionRunId: own.runId } : {}) };
  const selected = completion ? undefined : (await scheduleTask(tx, ctx, [...new Set([...spec.required_capabilities, "code.read", "code.modify"])] as Capability[], options)).selected;
  const uncertain = new Set(await unconfirmedDisconnectRunIds(ctx, tx, { computerId: computer.id }));
  const neighbors = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computer.id)));
  if (!implementationReview && neighbors.some(run => run.id !== own?.runId && (!['completed', 'failed', 'cancelled'].includes(run.status) || uncertain.has(run.id))
    && (run.agentInstanceId === writer.id || !run.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, writer.workspaceRoot!, computer.os)))) throw AppError.conflict("H5 writer/workspace has another execution");
  if (!implementationReview && (await unsettledStandaloneExecutions(ctx, tx, { computerId: computer.id })).some(operation => (operation.kind !== "execution" || operation.id !== own?.id)
    && (operation.participantInstanceIds.includes(writer.id) || automationWorkspacesOverlap(operation.workspaceRoot, writer.workspaceRoot!, computer.os)))) throw AppError.conflict("H5 workspace has an unsettled dedicated operation");
  const reservations = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.organizationId, ctx.organizationId), eq(goalAutomations.computerId, computer.id)));
  if (reservations.some(row => row.goalId !== goal.id && ["planning", "executing", "waiting"].includes(row.status) && row.workspaceRoot
    && automationWorkspacesOverlap(row.workspaceRoot, writer.workspaceRoot!, computer.os))) throw AppError.conflict("H5 workspace is reserved by another goal");
  if (!own) await assertExecutionApprovalGranted(ctx, tx, task.id);
  else if (!implementationReview) {
    const gates = await tx.select().from(approvals).where(and(eq(approvals.taskId, task.id), eq(approvals.organizationId, ctx.organizationId), eq(approvals.action, "execution.start")));
    const active = gates.filter(gate => gate.payloadRef !== EXECUTION_GATE_SUPERSEDED);
    if (gates.length && (active.length !== 1 || active[0]!.payloadRef !== EXECUTION_GATE_CURRENT || active[0]!.status !== "approved" || active[0]!.runId !== own.runId)) throw AppError.conflict("H5 execution approval changed");
  }
  for (const identity of [source, destination].sort((a, b) => a.deviceId.localeCompare(b.deviceId))) await credential(ctx, tx, identity);
  const [h2] = await tx.select().from(goalImportedProductReviews).where(eq(goalImportedProductReviews.id, continuation.reviewId)).for("update");
  const [h1] = h2 ? await tx.select().from(goalProductHandoffs).where(eq(goalProductHandoffs.id, h2.handoffId)).for("update") : [];
  if (!h2 || !h1 || h2.stopRequested || h1.stopRequested || !h1.qualifiedReceipt || canonical(h2.request) !== canonical(original.review_request)
    || canonical(h2.result) !== canonical(original.review_result)) throw AppError.conflict("H5 source transfer/review changed");
  const bytes = await researchBytes(ctx, request); inspectImportedDesignReviewResultV1(request, result, bytes, sha);
  assertMeasurementV2TransferSessions(ctx, transfer);
  if (canonical({ source: ctx.getPairedNodeSession?.(base.source.node_id), destination: ctx.getPairedNodeSession?.(base.destination.node_id) }) !== canonical(sessionBindings)) throw AppError.conflict("H5 sessions changed during admission");
  return { review, request, result, goal, automation, plan, task, spec, writer, selected, completed, sessionBindings, bytes, expectedGoal };
}

/** Shared immutable H1-H5 authorization. H6 separately owns current task/source/occupancy/gate checks. */
export async function readImportedExecutionRootFacts(ctx: ServerContext, tx: DrizzleDb, executionId: string) {
  const [initial] = await tx.select().from(executions).where(and(eq(executions.id, executionId), eq(executions.organizationId, ctx.organizationId)));
  if (!initial?.reviewReadyAt || initial.stopRequested) throw AppError.conflict("H6 requires an unstopped review-ready original implementation");
  const value = await facts(ctx, tx, initial.reviewId, initial, true, true);
  const [row] = await tx.select().from(executions).where(eq(executions.id, initial.id)).for("update");
  if (!row || canonical(row) !== canonical(initial)) throw AppError.conflict("H6 original implementation changed during admission");
  return { ...value, execution: row };
}

export { originalActor as assertImportedImplementationActor, actorContext as importedImplementationActorContext,
  credential as assertImportedImplementationCredential, researchBytes as readImportedImplementationResearch };

export async function ensureGoalImportedExecution(ctx: ServerContext, tx: DrizzleDb, automation: Automation, reviewId: string) {
  originalActor(ctx, automation.actorUserId);
  const [existing] = await tx.select().from(executions).where(and(eq(executions.reviewId, reviewId), eq(executions.organizationId, ctx.organizationId)));
  if (existing) {
    if (existing.goalId !== automation.goalId || existing.planId !== automation.planId || existing.actorUserId !== automation.actorUserId) throw AppError.permissionDenied("H5 belongs to another automation");
    return existing;
  }
  const value = await facts(ctx, tx, reviewId), { review, task, writer, spec } = value;
  if (review.goalId !== automation.goalId || review.planId !== automation.planId) throw AppError.permissionDenied("H4 belongs to another automation");
  const execution_id = ctx.idGen.generate("imported_execution"), runId = ctx.idGen.generate("run"), contextId = ctx.idGen.generate("context");
  const original = value.request.continuation_request.run_start, root = review.workspaceRoot;
  const binding = { execution_id, review_request: value.request, review_result: value.result, acceptance_event_id: review.acceptanceEventId! };
  const development = productDevelopmentContext("implementation", original.context_pack.payload.verification_capabilities, original.context_pack.payload.release_capabilities);
  const requiredApproval = [...new Set([...original.policy_snapshot.requires_approval, "git.push", "external.post"])];
  const context = ContextPackSchema.parse({ ...original.context_pack.payload, review_subject: undefined, imported_review_subject: undefined, imported_design_review_subject: undefined,
    conversation: undefined, review_feedback: undefined, imported_execution: importedExecutionContextV1(binding, sha),
    task: { id: task.id, title: task.title, description: task.description, acceptance_criteria: task.acceptanceCriteria },
    goal_context: { ...value.expectedGoal, plan: { ...value.expectedGoal.plan, spec_ref: task.sourcePlanSpecRef } },
    policy: { filesystem_write_scope: [root], requires_approval: requiredApproval },
    product_development: { ...development, accepted_inputs: importedExecutionAcceptedInputsV1({ review_request: value.request, design_evidence_id: value.completed.evidence.id }) },
    artifacts: { expected: spec.expected_artifacts.map(item => item.description ?? item.type) } });
  const { expected_subject_digest: _baselineOnly, ...verification } = original.verification!;
  const request = ImportedExecutionRequestV1Schema.parse({ version: 1, stage: "implementation", ...binding, design_evidence_id: value.completed.evidence.id,
    writer: { instance_id: writer.id, agent_id: writer.agentId }, run_start: { run_id: runId, task_id: task.id, agent_instance_id: writer.id, runtime: writer.runtime,
      workspace: { root, branch: null }, verification: { ...verification, request_id: ctx.idGen.generate("verify") }, context_pack: { id: contextId, payload: context },
      policy_snapshot: { filesystem_write_scope: [root], requires_approval: requiredApproval }, artifact_rules: { paths: [".artoo/product/**", "artifacts/**"] } } });
  inspectImportedExecutionRequestV1(request, value.bytes, sha);
  const [locked] = await tx.select().from(goalImportedDesignReviews).where(eq(goalImportedDesignReviews.id, review.id)).for("update");
  if (!locked || canonical(locked) !== canonical(review)) throw AppError.conflict("H4 changed before one-use H5 reservation");
  const now = ctx.clock.nowIso();
  // Only this exact successor becomes ready; ordinary DAG activation stays fenced.
  if (task.status === "backlog") await transitionTask(tx, ctx, { taskId: task.id, from: "backlog", trigger: "triage", now });
  await transitionTask(tx, ctx, { taskId: task.id, from: "ready", trigger: "assign", now });
  await tx.insert(contextPacks).values({ id: contextId, organizationId: ctx.organizationId, taskId: task.id, runId, payload: context, createdAt: now });
  await tx.insert(runs).values({ id: runId, organizationId: ctx.organizationId, requestedByUserId: review.actorUserId, aiDataSharingConsentId: review.consentId,
    aiDataSharingPolicyVersion: review.policyVersion, taskId: task.id, computerId: writer.computerId, agentInstanceId: writer.id, runtimeId: writer.runtime,
    modelProfileId: value.selected!.model_profile_id, effortProfileId: value.selected!.effort_profile_id, status: "queued", contextPackId: contextId, workspaceRoot: root,
    workspaceBranch: null, verificationRequirement: request.run_start.verification, createdAt: now });
  await bindExecutionApprovalToRun(ctx, tx, task.id, runId);
  await tx.update(tasks).set({ assigneeType: "agent", assigneeId: writer.agentId, updatedAt: now }).where(eq(tasks.id, task.id));
  const [row] = await tx.insert(executions).values({ id: execution_id, reviewId, organizationId: ctx.organizationId, goalId: review.goalId, planId: review.planId,
    taskId: task.id, runId, contextPackId: contextId, writerInstanceId: writer.id, writerAgentId: writer.agentId, computerId: writer.computerId, workspaceRoot: root,
    actorUserId: review.actorUserId, consentId: review.consentId, policyVersion: review.policyVersion, acceptanceEventId: review.acceptanceEventId!, designEvidenceId: value.completed.evidence.id,
    sessionBindings: value.sessionBindings, requestDigest: importedExecutionRequestDigestV1(request, sha), request, createdAt: now }).returning();
  await appendEvent(tx, buildEvent(ctx, { type: "task.updated", actorType: "system", actorId: "goal_runner", correlationId: execution_id,
    goalId: review.goalId, taskId: task.id, projectId: task.projectId, roomId: task.roomId, runId,
    payload: { status: "assigned", assignee_type: "agent", assignee_id: writer.agentId, imported_execution_id: execution_id } }));
  await appendEvent(tx, buildEvent(ctx, { type: "goal.imported-execution.queued", actorType: "system", actorId: "goal_runner", correlationId: execution_id,
    goalId: review.goalId, taskId: task.id, projectId: task.projectId, runId, payload: { execution_id, h4_review_id: review.id, actor_user_id: review.actorUserId, acceptance_event_id: review.acceptanceEventId, subsequent_stage_authorized: false } }));
  return row!;
}

export async function inspectImportedExecutionCompletion(ctx: ServerContext, tx: DrizzleDb, row: Execution, input: unknown) {
  const request = ImportedExecutionRequestV1Schema.parse(row.request), result = ImportedExecutionResultV1Schema.parse(input);
  if (result.outcome !== "finished" || !result.verified_execution) throw AppError.conflict("H5 lifecycle alone cannot authorize review readiness");
  const completed = inspectImportedCompletedExecutionV1(request, result.verified_execution, sha);
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId))).for("update");
  const [pack] = await tx.select().from(contextPacks).where(and(eq(contextPacks.id, row.contextPackId), eq(contextPacks.organizationId, ctx.organizationId)));
  if (!run || !pack || run.status !== "completed" || run.taskId !== row.taskId || run.agentInstanceId !== row.writerInstanceId || run.computerId !== row.computerId
    || run.runtimeId !== request.run_start.runtime || run.contextPackId !== pack.id || pack.runId !== run.id || pack.taskId !== row.taskId
    || run.requestedByUserId !== row.actorUserId || run.aiDataSharingConsentId !== row.consentId || run.aiDataSharingPolicyVersion !== row.policyVersion
    || run.workspaceRoot !== row.workspaceRoot || run.workspaceBranch !== null || run.workspaceAllocation !== null
    || canonical(pack.payload) !== canonical(request.run_start.context_pack.payload) || canonical(run.verificationRequirement) !== canonical(request.run_start.verification)) throw AppError.conflict("H5 completion lost its exact author/context");
  const measured = await inspectRunVerification(ctx, tx, run);
  if (!measured.passed || !measured.evidence || canonical(measured.evidence.payload) !== canonical(completed.verification)) throw AppError.conflict("H5 lacks exact committed passed node evidence");
  return { request, result, completed, run, evidence: measured.evidence };
}
const inspectCompletion = inspectImportedExecutionCompletion;

export async function advanceGoalImportedExecution(ctx: ServerContext, tx: DrizzleDb, automation: Automation, reviewId: string) {
  const row = await ensureGoalImportedExecution(ctx, tx, automation, reviewId), result = ImportedExecutionResultV1Schema.safeParse(row.result).data;
  if (row.reviewReadyAt) return { reason: "Imported implementation is awaiting dedicated H6 review; no validation or release authority exists." };
  if (!result) { await ctx.onImportedExecutionQueued?.(row.id, row.stopRequested ? "stop" : "start"); return { reason: "Waiting for the dedicated implementation author and confirmed closure." }; }
  if (row.stopRequested || result.outcome !== "finished" || !result.verified_execution) return { reason: `Imported implementation ${result.outcome}; verified review readiness remains fenced.` };
  const value = await facts(ctx, tx, reviewId, row, true), completed = await inspectCompletion(ctx, tx, row, result);
  const [proof] = await tx.select().from(completions).where(and(eq(completions.executionId, row.id), eq(completions.organizationId, ctx.organizationId)));
  const [fresh] = await tx.select().from(executions).where(eq(executions.id, row.id)).for("update");
  if (!fresh || fresh.stopRequested || fresh.reviewReadyAt || canonical(fresh.result) !== canonical(result) || fresh.resultDigest !== hash(result)
    || !proof || proof.evidenceId !== completed.evidence.id || proof.resultDigest !== hash(result) || proof.completedExecutionDigest !== hash(completed.completed)
    || proof.sessionId !== value.sessionBindings.destination.sessionId || proof.deliveryId !== fresh.resultDeliveryId || proof.sessionId !== fresh.resultSessionId) throw AppError.conflict("H5 review readiness provenance changed");
  const now = ctx.clock.nowIso();
  const changed = await transitionTask(tx, ctx, { taskId: row.taskId, from: "running", trigger: "run_completed", now,
    events: status => [buildEvent(ctx, { type: "task.updated", actorType: "system", actorId: "goal_runner", correlationId: row.id,
      goalId: row.goalId, taskId: row.taskId, projectId: value.task.projectId, roomId: value.task.roomId, payload: { status, imported_execution_id: row.id } })] });
  if (!changed.changed) throw AppError.conflict("H5 task is no longer awaiting verified completion");
  const event = buildEvent(ctx, { type: "goal.imported-execution.review-ready", actorType: "system", actorId: "goal_runner", correlationId: row.id,
    goalId: row.goalId, taskId: row.taskId, projectId: value.task.projectId, runId: row.runId,
    payload: { execution_id: row.id, result_digest: fresh.resultDigest, actor_user_id: row.actorUserId, verification_evidence_id: proof.evidenceId, subsequent_stage_authorized: false } });
  await appendEvent(tx, event); await tx.update(executions).set({ reviewReadyAt: now, reviewReadyEventId: event.id }).where(eq(executions.id, row.id));
  return { reason: "Imported implementation is awaiting dedicated H6 review; no validation or release authority exists." };
}

export async function stopGoalImportedExecutions(ctx: ServerContext, goalId: string) {
  const rows = await ctx.db.transaction(async tx => {
    await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
    const rows = await tx.select().from(executions).where(and(eq(executions.goalId, goalId), eq(executions.organizationId, ctx.organizationId)));
    for (const row of rows) { originalActor(ctx, row.actorUserId); if (!closed(row.result)) await tx.update(executions).set({ stopRequested: true }).where(eq(executions.id, row.id)); }
    return rows.filter(row => !closed(row.result));
  });
  for (const row of rows) await ctx.onImportedExecutionQueued?.(row.id, "stop");
}

export function createImportedExecutionBinding(ctx: ServerContext, options: { identity: AuthenticatedTransferNode; sessionId: string; transport: NodeTransport; isCurrent: () => boolean }) {
  const identity = Object.freeze({ ...options.identity });
  const current = () => { if (!options.isCurrent()) throw AppError.permissionDenied("H5 node session is no longer current"); };
  const qualify = async (tx: DrizzleDb) => { current(); await credential(ctx, tx, identity); current(); };
  async function load(tx: DrizzleDb, id: string) {
    const [row] = await tx.select().from(executions).where(and(eq(executions.id, id), eq(executions.organizationId, ctx.organizationId)));
    if (!row || row.computerId !== identity.computerId) throw AppError.permissionDenied("H5 belongs to another node"); return row;
  }
  async function startFence(tx: DrizzleDb, row: Execution) {
    const value = await facts(actorContext(ctx, row.actorUserId), tx, row.reviewId, row), request = ImportedExecutionRequestV1Schema.parse(row.request);
    await qualify(tx);
    const [fresh] = await tx.select().from(executions).where(eq(executions.id, row.id)).for("update");
    const [run] = await tx.select().from(runs).where(eq(runs.id, row.runId)).for("update");
    const [pack] = await tx.select().from(contextPacks).where(eq(contextPacks.id, row.contextPackId));
    if (!fresh || fresh.stopRequested || fresh.result !== null || canonical(fresh) !== canonical(row) || row.requestDigest !== importedExecutionRequestDigestV1(request, sha)
      || canonical(request.review_request) !== canonical(value.request) || canonical(request.review_result) !== canonical(value.result)
      || request.acceptance_event_id !== value.review.acceptanceEventId || request.design_evidence_id !== value.completed.evidence.id
      || canonical(value.sessionBindings.destination) !== canonical({ ...identity, sessionId: options.sessionId })
      || !run || run.status !== "queued" || run.taskId !== row.taskId || run.agentInstanceId !== row.writerInstanceId || run.computerId !== row.computerId
      || run.runtimeId !== value.writer.runtime || run.modelProfileId !== value.selected!.model_profile_id || run.effortProfileId !== value.selected!.effort_profile_id
      || run.requestedByUserId !== row.actorUserId || run.aiDataSharingConsentId !== row.consentId || run.aiDataSharingPolicyVersion !== row.policyVersion
      || run.contextPackId !== row.contextPackId || run.workspaceRoot !== row.workspaceRoot || run.workspaceBranch !== null || run.workspaceAllocation !== null
      || !pack || pack.runId !== row.runId || pack.taskId !== row.taskId || canonical(pack.payload) !== canonical(request.run_start.context_pack.payload)
      || canonical(run.verificationRequirement) !== canonical(request.run_start.verification)) throw AppError.conflict("H5 unused writer binding changed");
    const starts = await tx.select().from(deliveries).where(and(eq(deliveries.executionId, row.id), eq(deliveries.control, "start")));
    if (starts.some(item => item.sessionId !== options.sessionId)) throw AppError.conflict("Exposed H5 cannot restart in another session");
    inspectImportedExecutionRequestV1(request, value.bytes, sha); current();
    await assertSourceLineageDispatch(ctx, tx, row.computerId, row.workspaceRoot);
  }
  return {
    async requestStop(id: string) { await ctx.db.transaction(async tx => { const row = await load(tx, id);
      await tx.select().from(goals).where(eq(goals.id, row.goalId)).for("update"); await qualify(tx);
      await tx.update(executions).set({ stopRequested: true }).where(eq(executions.id, id)); }); },
    async dispatch(id: string, control: Control = "start") {
      const record = await ctx.db.transaction(async tx => {
        const row = await load(tx, id); if (control === "start") await startFence(tx, row); else { await qualify(tx); if (control === "stop" && !row.stopRequested) throw AppError.conflict("Persist H5 stop before sending it"); }
        const [prior] = await tx.select().from(deliveries).where(and(eq(deliveries.executionId, id), eq(deliveries.sessionId, options.sessionId), eq(deliveries.control, control)));
        const delivery = prior ?? (await tx.insert(deliveries).values({ id: ctx.idGen.generate("execution_delivery"), executionId: id, sessionId: options.sessionId, control, createdAt: ctx.clock.nowIso() }).returning())[0]!;
        return { row, delivery };
      });
      const common = { kind: "command" as const, id: record.delivery.id, idempotency_key: `${id}:${control}:${record.row.requestDigest}` };
      const command: ServerToNodeMessage = control === "start" ? { ...common, type: "product.source.execution.v1", payload: ImportedExecutionRequestV1Schema.parse(record.row.request) }
        : { ...common, type: control === "stop" ? "product.source.execution.stop.v1" : "product.source.execution.status.v1", payload: { version: 1, execution_id: id, request_digest: record.row.requestDigest, run_id: record.row.runId } };
      await ctx.db.transaction(async tx => { const row = await load(tx, id); if (control === "start") await startFence(tx, row); else await qualify(tx); current(); await options.transport.send(command); current(); });
      return command;
    },
    async acknowledge(input: ImportedExecutionAck) {
      const ack = importedExecutionAckSchema.parse(input); current(); if (ack.node_id !== identity.computerId) throw AppError.permissionDenied("H5 ACK node differs");
      await ctx.db.transaction(async tx => { await qualify(tx); const row = await load(tx, ack.payload.execution_id);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, ack.command_id), eq(deliveries.executionId, row.id), eq(deliveries.sessionId, options.sessionId))).for("update");
        if (!delivery || row.requestDigest !== ack.payload.request_digest || row.runId !== ack.payload.run_id) throw AppError.conflict("H5 ACK lacks exact issued delivery");
        if (delivery.ack !== null && canonical(delivery.ack) !== canonical(ack)) throw AppError.conflict("H5 ACK is immutable");
        if (delivery.ack === null) await tx.update(deliveries).set({ ack }).where(eq(deliveries.id, delivery.id)); await qualify(tx); });
    },
    async receive(input: ImportedExecutionResult) {
      const message = importedExecutionResultSchema.parse(input); current(); if (message.node_id !== identity.computerId) throw AppError.permissionDenied("H5 result node differs");
      await ctx.db.transaction(async tx => {
        const initial = await load(tx, message.payload.execution_id);
        await tx.select().from(goals).where(and(eq(goals.id, initial.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
        await tx.select().from(tasks).where(and(eq(tasks.id, initial.taskId), eq(tasks.organizationId, ctx.organizationId))).for("update");
        await qualify(tx); const row = await load(tx, initial.id);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, message.command_id), eq(deliveries.executionId, row.id), eq(deliveries.sessionId, options.sessionId)));
        if (!delivery) throw AppError.conflict("H5 result lacks its issued command");
        const request = ImportedExecutionRequestV1Schema.parse(row.request), result = inspectImportedExecutionResultV1(request, message.payload, await researchBytes(ctx, request.review_request), sha);
        const [locked] = await tx.select().from(executions).where(eq(executions.id, row.id)).for("update");
        const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId))).for("update");
        if (!run || run.computerId !== identity.computerId || run.taskId !== row.taskId || run.agentInstanceId !== row.writerInstanceId) throw AppError.conflict("H5 result lost its real run");
        if (locked!.result !== null && canonical(locked!.result) !== canonical(result)) throw AppError.conflict("H5 result is immutable");
        if (result.outcome === "finished" || result.outcome === "failed") {
          if (!["completed", "failed", "cancelled"].includes(run.status)) throw AppError.conflict("H5 closure requires committed ordered terminal events");
        } else if (result.outcome === "cancelled_before_start" && run.status !== "cancelled") {
          if (run.status !== "queued") throw AppError.conflict("A started H5 cannot be reported unstarted");
          const now = ctx.clock.nowIso(); await transitionRun(tx, actorContext(ctx, row.actorUserId), { runId: row.runId, from: "queued", trigger: "cancel", patch: { endedAt: now } });
          const [task] = await tx.select().from(tasks).where(eq(tasks.id, row.taskId));
          if (task?.status === "assigned") await transitionTask(tx, actorContext(ctx, row.actorUserId), { taskId: row.taskId, from: "assigned", trigger: "cancel", now });
          await releaseRunLeases(ctx, tx, row.runId);
          await appendEvent(tx, buildEvent(ctx, { type: "run.cancelled", actorType: "system", actorId: identity.computerId, correlationId: row.id, runId: row.runId,
            taskId: row.taskId, goalId: row.goalId, projectId: task?.projectId, payload: { run_id: row.runId, execution_id: row.id, cancelled_before_start: true, process_exit_confirmed: true } }));
        }
        let verified: Awaited<ReturnType<typeof inspectCompletion>> | undefined;
        if (result.outcome === "finished" && result.verified_execution) {
          verified = await inspectCompletion(ctx, tx, row, result);
          const starts = await tx.select().from(deliveries).where(and(eq(deliveries.executionId, row.id), eq(deliveries.control, "start")));
          const bindings = row.sessionBindings as { destination: AuthenticatedTransferNode & { sessionId: string } };
          if (starts.length !== 1 || starts[0]!.sessionId !== options.sessionId || canonical(bindings.destination) !== canonical({ ...identity, sessionId: options.sessionId })) throw AppError.conflict("H5 verified completion requires its original session");
        }
        if (locked!.result === null) {
          await tx.update(executions).set({ result, resultDigest: hash(result), resultDeliveryId: delivery.id, resultSessionId: options.sessionId }).where(eq(executions.id, row.id));
          if (verified) await tx.insert(completions).values({ executionId: row.id, organizationId: ctx.organizationId, runId: row.runId, evidenceId: verified.evidence.id,
            contextPackId: row.contextPackId, deliveryId: delivery.id, sessionId: options.sessionId, resultDigest: hash(result), completedExecutionDigest: hash(verified.completed), verifiedExecution: verified.completed, createdAt: ctx.clock.nowIso() });
        }
        await qualify(tx);
      });
      await ctx.db.transaction(async tx => { await qualify(tx); await options.transport.send({ kind: "command", id: message.command_id, idempotency_key: `receipt:${message.command_id}`,
        type: "product.source.execution.receipt.v1", payload: { version: 1, execution_id: message.payload.execution_id, request_digest: message.payload.request_digest, run_id: message.payload.run_id }, result_digest: hash(message.payload), status: "accepted" }); current();
        if (message.payload.outcome === "finished" && message.payload.verified_execution) {
          const row = await load(tx, message.payload.execution_id);
          await tx.insert(goalImportedExecutionReceipts).values({ executionId: row.id, organizationId: ctx.organizationId,
            deliveryId: row.resultDeliveryId!, sessionId: options.sessionId, sessionBindings: row.sessionBindings,
            requestDigest: row.requestDigest, resultDigest: hash(message.payload), sentAt: ctx.clock.nowIso() }).onConflictDoNothing();
        }
      });
    },
  };
}
