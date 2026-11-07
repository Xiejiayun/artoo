import { agentInstances, agents, appendEvent, computers, contextPacks, eventLog, goalAutomations, goalProductHandoffs, goals, plans, runs, tasks } from "@artoo/db";
import { AutonomousSourceHandoffV1Schema, AutonomousTeamSchema, ContextPackSchema, GoalBudgetsSchema,
  ProductSourceExportV2Schema, ProductSourceHandoffIntentV1Schema, ProductSourceRoutingV1Schema,
  PRODUCT_SOURCE_EXPORT_EVENT_V2, canonicalProductSourceTransferValueV1 as canonical,
  productSourceExportDigestV2, TaskSpecSchema,
  type Capability, type ProductSourceDestinationMappingV1, type TaskSpec } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, inArray, notInArray, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";
import { ensureGoalProductHandoff } from "./goal-product-handoff-service.js";
import { inspectIndependentReview } from "./independent-review-service.js";
import { scheduleTask, type SchedulerCandidate } from "./scheduler.js";
import { inspectRunVerification } from "./verification-service.js";
import { verificationCapabilityBinding } from "./verification-capabilities.js";
import { unconfirmedDisconnectRunIds, unsettledStandaloneExecutions } from "./execution-state.js";

type Automation = typeof goalAutomations.$inferSelect;
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const SOURCE_FEATURES = ["product-source-transfer.v2", "product-source-transfer.measurement-v2.v1", "product-source-operations.v1"];
const DESTINATION_FEATURES = [...SOURCE_FEATURES, "imported-product-review.v1", "imported-design-continuation.v1",
  "imported-design-review.v1", "imported-execution.v1", "imported-execution-review.v1", "imported-validation.v1", "product-release.acceptance.v1"];

/** This initial automatic route uses the existing first-hop research continuation contract. */
export function automaticSourceHandoffPlanErrors(specs: readonly TaskSpec[]): string[] {
  const stages = ["research", "design", "implementation", "validation"];
  if (specs.length !== stages.length || specs.some((spec, index) => spec.development_stage !== stages[index])) {
    return ["Automatic source handoff requires exactly four ordered research, design, implementation and validation tasks."];
  }
  return specs.flatMap((spec, index) => {
    const hard = spec.dependencies.filter(edge => edge.type !== "soft_context");
    return index === 0 ? hard.length ? ["Automatic source research must have no hard prerequisite."] : []
      : hard.length === 1 && hard[0]!.ref === String(index - 1) && ["blocks", "artifact_required"].includes(hard[0]!.type)
        ? [] : [`Automatic source handoff task ${index} must depend directly on the preceding stage.`];
  });
}

function routing(ctx: ServerContext, nodeId: string) {
  const parsed = ProductSourceRoutingV1Schema.safeParse(ctx.getProductSourceRouting?.(nodeId));
  return ctx.getPairedNodeSession?.(nodeId) && parsed.success ? parsed.data : undefined;
}

/** Configuration selection is not evidence that an author or verifier ran. */
export function automaticSourceAvailable(ctx: ServerContext, nodeId: string, projectId: string,
  workspaceRoot: string, verifierId: string, releaseId: string): boolean {
  const source = routing(ctx, nodeId);
  if (!source || !SOURCE_FEATURES.every(feature => ctx.supportsExecutionFeature?.(nodeId, feature) === true)) return false;
  const release = ctx.getReleaseCapabilities?.(nodeId, releaseId, projectId, workspaceRoot, verifierId);
  return !!release && source.source_exports.some(candidate => isDeepStrictEqual(candidate, release));
}

function mappedCapabilities(ctx: ServerContext, nodeId: string, mapping: ProductSourceDestinationMappingV1,
  source: ReturnType<typeof ProductSourceExportV2Schema.parse>) {
  const release = mapping.destination_release, scope = release.binding;
  if (!isDeepStrictEqual(mapping.source_release, source.measurement_v2?.source_release)
    || !DESTINATION_FEATURES.every(feature => ctx.supportsExecutionFeature?.(nodeId, feature) === true)
    || !isDeepStrictEqual(ctx.getReleaseCapabilities?.(nodeId, scope.release_profile_id, scope.project_id,
      scope.workspace_root, scope.verification_profile_id), release)) return undefined;
  const capabilities = ctx.getVerificationCapabilities?.(nodeId, scope.verification_profile_id, scope.project_id, scope.workspace_root);
  if (!capabilities || capabilities.profile_digest !== scope.verification_profile_digest
    || !isDeepStrictEqual(capabilities.measurement_plan_policy, source.source_capabilities.measurement_plan_policy)
    || mapping.command_pairs.length !== source.source_capabilities.checks.length
    || mapping.command_pairs.length !== capabilities.checks.length
    || mapping.command_pairs.some(pair => {
      const from = source.source_capabilities.checks.find(check => check.command_id === pair.source_command_id);
      const to = capabilities.checks.find(check => check.command_id === pair.destination_command_id);
      return !from || !to || from.contract_digest !== to.contract_digest;
    })) return undefined;
  return capabilities;
}

async function vacant(ctx: ServerContext, tx: DrizzleDb, computer: typeof computers.$inferSelect, workspace: string, goalId: string) {
  const uncertain = await unconfirmedDisconnectRunIds(ctx, tx, { computerId: computer.id });
  const ordinary = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computer.id),
    or(notInArray(runs.status, ["completed", "failed", "cancelled"]), uncertain.length ? inArray(runs.id, uncertain) : undefined)));
  const reservations = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.organizationId, ctx.organizationId),
    eq(goalAutomations.computerId, computer.id), inArray(goalAutomations.status, ["planning", "executing", "waiting"])));
  return !ordinary.some(run => !run.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, workspace, computer.os))
    && !reservations.some(row => row.goalId !== goalId && row.workspaceRoot && automationWorkspacesOverlap(row.workspaceRoot, workspace, computer.os))
    && !(await unsettledStandaloneExecutions(ctx, tx, { computerId: computer.id }))
      .some(operation => automationWorkspacesOverlap(operation.workspaceRoot, workspace, computer.os));
}

/** Called by GoalRunner in its goal transaction, before ordinary design assignment.
 * Every accepted fact is requalified by ensureGoalProductHandoff. No test/model
 * result, remote command or caller-provided destination is accepted here. */
export async function ensureAutomaticProductHandoff(ctx: ServerContext, tx: DrizzleDb, automation: Automation, nextTaskId: string): Promise<boolean> {
  if (automation.sourceHandoff == null) return false;
  AutonomousSourceHandoffV1Schema.parse(automation.sourceHandoff);
  if (ctx.automationActor?.id !== "goal_runner" || ctx.actorUserId !== automation.actorUserId
    || automation.executionMode !== "agent_team" || !automation.releaseProfileId) throw AppError.permissionDenied("Automatic routing requires the original user's explicit Agent Team grant");
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [plan] = await tx.select().from(plans).where(and(eq(plans.id, automation.planId!), eq(plans.organizationId, ctx.organizationId)));
  const [next] = await tx.select().from(tasks).where(and(eq(tasks.id, nextTaskId), eq(tasks.organizationId, ctx.organizationId)));
  if (!goal || !plan || plan.goalId !== goal.id || !next || next.projectId !== goal.projectId || !Array.isArray(plan.taskSpecs)) {
    throw AppError.conflict("Automatic source handoff has no current accepted plan");
  }
  const specs = plan.taskSpecs.map(value => TaskSpecSchema.parse(value));
  const errors = automaticSourceHandoffPlanErrors(specs);
  if (errors.length) throw AppError.conflict(errors.join(" "));
  if (specs[Number(next.sourcePlanSpecRef)]?.development_stage !== "design") return false;
  const existing = await tx.select().from(goalProductHandoffs).where(and(eq(goalProductHandoffs.organizationId, ctx.organizationId),
    eq(goalProductHandoffs.goalId, goal.id), eq(goalProductHandoffs.nextTaskId, next.id)));
  if (existing.length) {
    if (existing.length !== 1 || existing[0]!.planId !== plan.id) throw AppError.conflict("Automatic handoff identity is ambiguous");
    return false;
  }
  if (goal.status !== "running" || goal.currentPlanId !== plan.id || plan.status !== "accepted" || next.status !== "ready"
    || next.sourcePlanId !== plan.id || next.goalId !== goal.id || next.sourcePlanSpecRef !== "1") {
    throw AppError.conflict("Automatic handoff requires the current ready dependent design task");
  }
  const [sourceTask] = await tx.select().from(tasks).where(and(eq(tasks.organizationId, ctx.organizationId),
    eq(tasks.goalId, goal.id), eq(tasks.sourcePlanId, plan.id), eq(tasks.sourcePlanSpecRef, "0")));
  const [run] = sourceTask ? await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.taskId, sourceTask.id)))
    .orderBy(desc(runs.createdAt), desc(runs.id)).limit(1) : [];
  if (!run || !sourceTask || sourceTask.projectId !== goal.projectId || run.status !== "completed" || sourceTask.status !== "done" || !run.workspaceRoot
    || run.computerId !== automation.computerId || run.workspaceRoot !== automation.workspaceRoot
    || !automaticSourceAvailable(ctx, run.computerId, goal.projectId, run.workspaceRoot, automation.verificationProfileId, automation.releaseProfileId)) {
    throw AppError.conflict("Automatic handoff waits for accepted research on its original prepared source node");
  }
  const measured = await inspectRunVerification(ctx, tx, run);
  if (!measured.passed || !measured.evidence) throw AppError.conflict("Automatic source research requires qualified node verification");
  const reviewed = await inspectIndependentReview(ctx, tx, run, measured.evidence);
  if (reviewed.status !== "accepted" || !reviewed.review || !reviewed.reviewerRunId || !reviewed.reviewerEvidenceId) {
    throw AppError.conflict("Automatic source research requires its completed independent review");
  }
  const exports = await tx.select().from(eventLog).where(and(eq(eventLog.organizationId, ctx.organizationId), eq(eventLog.runId, run.id),
    eq(eventLog.type, PRODUCT_SOURCE_EXPORT_EVENT_V2))).limit(2);
  if (exports.length !== 1) throw AppError.conflict("Automatic handoff requires one original node-owned semantic research export");
  const proof = ProductSourceExportV2Schema.parse(exports[0]!.payload), sourceRelease = proof.measurement_v2?.source_release;
  if (!sourceRelease) throw AppError.conflict("Automatic handoff requires the original policy-v2 publication association");
  const sourceSession = ctx.getPairedNodeSession?.(run.computerId);
  if (!sourceSession) throw AppError.conflict("Automatic research source has no current paired session");
  const budgets = GoalBudgetsSchema.parse(goal.budgets);
  const options = { mode: "auto" as const, projectId: goal.projectId, branchBacked: false, allowedRuntimes: budgets.allowed_runtimes };
  // The writer owns design/validation; its independent peer owns implementation.
  // Qualify each role before committing the first hop so complementary agents
  // can cooperate without discovering a missing author capability later.
  const writerRequired = [...new Set(["code.read", "code.modify", "code.review", ...specs[1]!.required_capabilities, ...specs[3]!.required_capabilities])] as Capability[];
  const peerRequired = [...new Set(["code.read", "code.modify", "code.review", ...specs[2]!.required_capabilities])] as Capability[];
  const declaredAgents = await tx.select().from(agents).where(eq(agents.organizationId, ctx.organizationId));
  const reviewCapable = (agent: typeof agents.$inferSelect) => ["code.read", "code.review"].every(capability => (agent.capabilities as string[]).includes(capability));
  // Imported research review also requires the agent's own review declaration;
  // a computer, runtime or installed skill cannot supply that declaration.
  const availableReviewer = (candidate: SchedulerCandidate) => candidate.runtime !== "mock"
    && declaredAgents.some(agent => agent.id === candidate.agent_id && reviewCapable(agent));
  const candidates = (await scheduleTask(tx, ctx, writerRequired, options)).candidates.filter(availableReviewer);
  const peers = (await scheduleTask(tx, ctx, peerRequired, options)).candidates.filter(availableReviewer);
  const instances = await tx.select().from(agentInstances).where(eq(agentInstances.organizationId, ctx.organizationId));
  const nodes = await tx.select().from(computers).where(eq(computers.organizationId, ctx.organizationId));
  let choice: { writer: SchedulerCandidate; peer: SchedulerCandidate; mapping: ProductSourceDestinationMappingV1;
    computer: typeof computers.$inferSelect; capabilities: NonNullable<ReturnType<typeof mappedCapabilities>> } | undefined;
  for (const writer of candidates) {
    const computer = nodes.find(node => node.id === writer.computer_id), instance = instances.find(instance => instance.id === writer.agent_instance_id);
    if (!computer || !["windows", "win32"].includes(computer.os) || computer.id === run.computerId || !instance?.workspaceRoot) continue;
    const configured = routing(ctx, computer.id);
    if (!configured) continue;
    const mappings = configured.destination_mappings.filter(mapping => mapping.destination_release.binding.project_id === goal.projectId
      && mapping.destination_release.binding.workspace_root === instance.workspaceRoot && isDeepStrictEqual(mapping.source_release, sourceRelease));
    if (mappings.length !== 1) continue;
    const mapping = mappings[0]!, capabilities = mappedCapabilities(ctx, computer.id, mapping, proof);
    if (!capabilities) continue;
    const peer = peers.find(candidate => candidate.computer_id === computer.id && candidate.agent_id !== writer.agent_id
      && instances.some(value => value.id === candidate.agent_instance_id && value.workspaceRoot === instance.workspaceRoot));
    if (!peer || !await vacant(ctx, tx, computer, instance.workspaceRoot, goal.id)) continue;
    choice = { writer, peer, mapping, computer, capabilities }; break;
  }
  if (!choice) throw AppError.conflict("Waiting for a paired Windows destination with a prepared source mapping and two independent available project agents");
  const { writer, peer, mapping, computer, capabilities } = choice, destinationRelease = mapping.destination_release, scope = destinationRelease.binding;
  const destinationSession = ctx.getPairedNodeSession?.(computer.id);
  if (!destinationSession) throw AppError.conflict("Automatic destination has no current paired session");
  const [storedContext] = run.contextPackId ? await tx.select().from(contextPacks).where(and(eq(contextPacks.id, run.contextPackId),
    eq(contextPacks.organizationId, ctx.organizationId), eq(contextPacks.runId, run.id))) : [];
  const original = ContextPackSchema.parse(storedContext?.payload), taskId = ctx.idGen.generate("imported_research_task");
  const context = ContextPackSchema.parse({ ...original, task: { ...original.task, id: taskId },
    workspace: { ...original.workspace, root: scope.workspace_root, branch: null },
    policy: { ...original.policy, filesystem_write_scope: [scope.workspace_root] },
    goal_context: { version: 1, goal_id: goal.id, objective: goal.objective, acceptance_criteria: goal.acceptanceCriteria,
      plan: { id: plan.id, version: plan.version, rationale: plan.rationale ?? "", spec_ref: sourceTask.sourcePlanSpecRef } },
    verification_capabilities: { ...capabilities, profile_id: scope.verification_profile_id }, release_capabilities: destinationRelease });
  const source = proof.byte_export;
  const intent = ProductSourceHandoffIntentV1Schema.parse({ version: 1, next_task_id: next.id,
    request: { version: 2, kind: "product-source-transfer.v2", source_export: proof, source_export_digest: productSourceExportDigestV2(proof, sha),
      command_pairs: mapping.command_pairs, measurement_v2: { version: 1, destination_release: destinationRelease },
      byte_request: { version: 1, kind: "product-source-transfer.v1", transfer_id: ctx.idGen.generate("handoff"),
        organization_id: ctx.organizationId, project_id: goal.projectId, goal_id: goal.id, plan_id: plan.id,
        authorization: { actor_user_id: automation.actorUserId, consent_id: automation.consentId, policy_version: automation.policyVersion },
        source: { node_id: run.computerId, task_id: sourceTask.id, run_id: run.id, evidence_id: measured.evidence.id,
          verification_request_id: measured.evidence.requestId, profile_id: source.profile_id, profile_digest: source.profile_digest,
          workspace_root: run.workspaceRoot, subject_digest: source.subject_digest, review_id: reviewed.review.id,
          reviewer_run_id: reviewed.reviewerRunId, reviewer_evidence_id: reviewed.reviewerEvidenceId,
          capsule_digest: source.capsule_digest, manifest_digest: source.manifest_digest, capsule_bytes: source.capsule_bytes },
        destination: { node_id: computer.id, profile_id: scope.verification_profile_id, workspace_root: scope.workspace_root,
          capabilities, capability_digest: sha(canonical(capabilities)) } } },
    destination_start: { run_id: ctx.idGen.generate("imported_research_run"), task_id: taskId, agent_instance_id: writer.agent_instance_id,
      runtime: writer.runtime, workspace: { root: scope.workspace_root, branch: null }, context_pack: { id: ctx.idGen.generate("context"), payload: context },
      policy_snapshot: context.policy, artifact_rules: { paths: [] }, verification: { version: 1, profile_id: scope.verification_profile_id,
        request_id: ctx.idGen.generate("verify"), expected_subject_digest: source.subject_digest,
        capability_binding: verificationCapabilityBinding(capabilities), release_capability_binding: destinationRelease.binding } } });
  // The trusted primitive repeats source receipts, review, current credentials,
  // consent and session capability checks. Keep it in this same transaction.
  const atomic: ServerContext = { ...ctx, db: { db: tx, transaction: work => work(tx), healthCheck: () => ctx.db.healthCheck(),
    migrate: () => Promise.reject(Error("Migration is unavailable during automatic handoff")), close: () => Promise.reject(Error("Cannot close automatic handoff transaction")) } };
  // Lock the destination exactly as ordinary assignment does, then repeat the
  // scheduler and workspace occupancy check before publishing the chosen team.
  for (const id of [writer.agent_instance_id, peer.agent_instance_id].sort()) {
    const [instance] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, id), eq(agentInstances.organizationId, ctx.organizationId))).for("update");
    if (!instance || instance.computerId !== computer.id || instance.workspaceRoot !== scope.workspace_root) {
      throw AppError.conflict("Automatic destination participant changed its prepared workspace");
    }
  }
  const [lockedComputer] = await tx.select().from(computers).where(and(eq(computers.id, computer.id), eq(computers.organizationId, ctx.organizationId))).for("update");
  if (!lockedComputer || lockedComputer.os !== computer.os || lockedComputer.status !== "online") throw AppError.conflict("Automatic destination computer changed");
  const lockedAgents = await tx.select().from(agents).where(and(eq(agents.organizationId, ctx.organizationId), inArray(agents.id, [writer.agent_id, peer.agent_id]))).for("share");
  const currentWriters = (await scheduleTask(tx, ctx, writerRequired, options)).candidates;
  const currentPeers = (await scheduleTask(tx, ctx, peerRequired, options)).candidates;
  if (!currentWriters.some(candidate => isDeepStrictEqual(candidate, writer))
    || !currentPeers.some(candidate => isDeepStrictEqual(candidate, peer))
    || ![writer, peer].every(selected => lockedAgents.some(agent => agent.id === selected.agent_id && reviewCapable(agent)))
    || !isDeepStrictEqual(sourceSession, ctx.getPairedNodeSession?.(run.computerId))
    || !isDeepStrictEqual(destinationSession, ctx.getPairedNodeSession?.(computer.id))
    || !automaticSourceAvailable(ctx, run.computerId, goal.projectId, run.workspaceRoot, automation.verificationProfileId, automation.releaseProfileId)
    || !routing(ctx, computer.id)?.destination_mappings.some(value => isDeepStrictEqual(value, mapping))
    || !mappedCapabilities(ctx, computer.id, mapping, proof)
    || !await vacant(ctx, tx, computer, scope.workspace_root, goal.id)) throw AppError.conflict("Automatic routing changed before its transaction committed");
  const team = AutonomousTeamSchema.parse(automation.team);
  const selectedTeam = AutonomousTeamSchema.parse({ ...team,
    members: team.members.map(member => member.stage === "research" ? member : { ...member,
      agent_instance_id: member.stage === "implementation" ? peer.agent_instance_id : writer.agent_instance_id }),
    reviewer_instance_ids: [...new Set([...team.reviewer_instance_ids, writer.agent_instance_id, peer.agent_instance_id])] });
  await ensureGoalProductHandoff(atomic, intent);
  // Admission itself awaits DB qualification. A replacement with identical
  // descriptors must not silently change the paired sessions selected above.
  if (!isDeepStrictEqual(sourceSession, ctx.getPairedNodeSession?.(run.computerId))
    || !isDeepStrictEqual(destinationSession, ctx.getPairedNodeSession?.(computer.id))
    || !automaticSourceAvailable(ctx, run.computerId, goal.projectId, run.workspaceRoot, automation.verificationProfileId, automation.releaseProfileId)
    || !routing(ctx, computer.id)?.destination_mappings.some(value => isDeepStrictEqual(value, mapping))) {
    throw AppError.conflict("Automatic paired configuration changed during handoff admission");
  }
  await tx.update(goalAutomations).set({ team: selectedTeam, updatedAt: ctx.clock.nowIso() })
    .where(and(eq(goalAutomations.goalId, goal.id), eq(goalAutomations.organizationId, ctx.organizationId)));
  await appendEvent(tx, buildEvent(ctx, { type: "goal.product-handoff.selected", actorType: "system", actorId: "goal_runner",
    goalId: goal.id, projectId: goal.projectId, correlationId: intent.request.byte_request.transfer_id,
    payload: { version: 1, actor_user_id: automation.actorUserId, authorization: automation.sourceHandoff,
      source_export_event_id: exports[0]!.id, source_node_id: run.computerId, destination_node_id: computer.id,
      destination_mapping_digest: sha(canonical(mapping)), team: selectedTeam } }));
  return true;
}
