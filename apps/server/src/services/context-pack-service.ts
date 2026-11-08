import { resolveResearchRevisionOrigin, researchRevisionHash, researchRevisionContext } from "./research-revision-origin-service.js";
import { goalImportedProductReviews } from "@artoo/db";
import { ImportedProductReviewResultV1Schema } from "@artoo/domain";
import { artifacts, assistantTurns, autonomousReviews, contextPacks, discussions, goalAutomations, goals, memories, messages, plans, projects, runs, taskDependencies, tasks } from "@artoo/db";
import {
  ContextPackSchema,
  ID_PREFIXES,
  normalizeLeasePath,
  selectInjectableMemories,
  TaskSpecSchema,
  productDevelopmentContext,
  type ContextPack,
  type DevelopmentStage,
  type Memory,
  type VerificationCapabilities,
  type VerificationCapabilityBinding,
  type RunVerificationPayload,
  type ReleaseCapabilityBindingV1,
  releaseCapabilityBinding,
  ApplicationDeliveryV1Schema, applicationDevelopmentInstructions, type ApplicationRequirementV1,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, desc, eq, isNull, lte, ne, or } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";

import type { ServerContext } from "../context.js";
import { mapMemory } from "../mappers.js";
import { AppError } from "../errors.js";
import { listTaskReviews } from "./review-history-service.js";
import { inspectRunVerification, readRunVerificationEvidence, type RunVerificationEvidence } from "./verification-service.js";
import { receiptCapabilityBinding, verificationCapabilityBinding } from "./verification-capabilities.js";
import { persistedPlanningSnapshot, planningRequest } from "./planning-capabilities.js";
import { buildDesignRevisionContext } from "./product-design-revision-guard.js";
import { applicationRequirement } from "./application-verification.js";

export interface BuildContextPackParams {
  runId: string;
  assistantTurnId?: string;
  task: typeof tasks.$inferSelect;
  /** The run's bound workspace root (#20), else falls back to project default. */
  workspaceRoot: string | null;
  /** The run's declared write paths (#20); drives policy file-scope when present. */
  writePaths?: readonly string[];
  /** Selected once by assignment from its current authenticated node connection. */
  verification?: { profile_id: string; capabilities?: VerificationCapabilities };
}

export interface BuiltContextPack {
  contextPackId: string;
  sourceMemoryIds: string[];
  verificationCapabilityBinding?: VerificationCapabilityBinding;
  releaseCapabilityBinding?: ReleaseCapabilityBindingV1;
  applicationRequirement?: ApplicationRequirementV1;
}

/** Render a memory's injectable content (text, else its structured payload). */
function renderMemory(memory: Memory): string {
  return memory.text ?? JSON.stringify(memory.payload ?? {});
}

function dedupeWriteScope(writePaths: readonly string[]): string[] {
  const scope: string[] = [];
  const seen = new Set<string>();
  for (const path of writePaths) {
    const normalized = normalizeLeasePath("", path);
    if (normalized.ok && !seen.has(normalized.path)) {
      seen.add(normalized.path);
      scope.push(path);
    }
  }
  return scope;
}

/** Use node-owned measurements, never an artifact's declared path/checksum, to freeze accepted specifications. */
async function acceptedProductInputs(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect,
  stage: DevelopmentStage, specs: unknown[]): Promise<{
    inputs: NonNullable<NonNullable<ContextPack["product_development"]>["accepted_inputs"]>;
    researchEvidence?: RunVerificationEvidence;
  } | undefined> {
  if (!task.goalId || !task.sourcePlanId) return undefined;
  const [automation] = await tx.select().from(goalAutomations).where(and(
    eq(goalAutomations.goalId, task.goalId), eq(goalAutomations.organizationId, ctx.organizationId),
  ));
  // Legacy/manual contexts remain compatible; every new team context opts into the measured input contract.
  if (automation?.executionMode !== "agent_team") return undefined;
  const required = stage === "research" ? [] : stage === "design" ? ["research"] : ["research", "design"];
  const files: NonNullable<NonNullable<ContextPack["product_development"]>["accepted_inputs"]>["files"] = [];
  let researchEvidence: RunVerificationEvidence | undefined;
  const siblings = required.length ? await tx.select().from(tasks).where(and(
    eq(tasks.organizationId, ctx.organizationId), eq(tasks.projectId, task.projectId),
    eq(tasks.goalId, task.goalId), eq(tasks.sourcePlanId, task.sourcePlanId),
  )) : [];
  for (const priorStage of required) {
    const sources = siblings.filter((sibling) => {
      const index = Number(sibling.sourcePlanSpecRef);
      const spec = sibling.sourcePlanSpecRef !== null && Number.isSafeInteger(index) ? TaskSpecSchema.safeParse(specs[index]) : null;
      return spec?.success && spec.data.development_stage === priorStage;
    });
    if (!sources.length || sources.some((source) => source.status !== "done")) throw AppError.conflict(`Accepted ${priorStage} handoff is not ready`);
    // A stage may contain several sequential tasks. The final accepted run owns its complete handoff.
    const acceptedRuns: (typeof runs.$inferSelect)[] = [];
    for (const source of sources) {
      const [latest] = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.taskId, source.id)))
        .orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
      if (!latest || latest.status !== "completed" || latest.workspaceRoot !== automation.workspaceRoot || latest.computerId !== automation.computerId) {
        throw AppError.conflict(`Accepted ${priorStage} handoff has no current bound execution`);
      }
      acceptedRuns.push(latest);
    }
    acceptedRuns.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const source = acceptedRuns[0]!;
    const measurement = await inspectRunVerification(ctx, tx, source);
    const path = priorStage === "research" ? ".artoo/product/research.json" as const : ".artoo/product/design.json" as const;
    const fact = measurement.evidence?.payload.required_files.find((file) => file.path === path);
    if (!measurement.passed || !fact || !fact.size) throw AppError.conflict(`Accepted ${priorStage} handoff lacks node-measured file evidence`);
    if (priorStage === "research") researchEvidence = measurement.evidence;
    files.push({ ...fact, path, source_task_id: source.taskId, source_run_id: source.id, evidence_id: measurement.evidence!.id });
  }
  return { inputs: { version: 1, files }, researchEvidence };
}

async function taskHandoff(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect) {
  const researchOrigin = await resolveResearchRevisionOrigin(ctx, tx, task);
  const planId = researchOrigin?.plan.id ?? task.sourcePlanId, specRef = researchOrigin?.specRef ?? task.sourcePlanSpecRef;
  const goal = task.goalId ? (await tx.select().from(goals).where(and(
    eq(goals.id, task.goalId), eq(goals.organizationId, ctx.organizationId), eq(goals.projectId, task.projectId),
  )))[0] : undefined;
  const plan = goal && planId ? (await tx.select().from(plans).where(and(
    eq(plans.id, planId), eq(plans.goalId, goal.id), eq(plans.organizationId, ctx.organizationId),
  )))[0] : undefined;
  const specs = plan && Array.isArray(plan.taskSpecs) ? plan.taskSpecs : [];
  const specIndex = specRef === null ? -1 : Number(specRef);
  const spec = Number.isInteger(specIndex) && specIndex >= 0 ? TaskSpecSchema.safeParse(specs[specIndex]) : null;
  const goalContext: ContextPack["goal_context"] = goal ? {
    version: 1, goal_id: goal.id, objective: goal.objective, acceptance_criteria: goal.acceptanceCriteria as string[],
    plan: plan ? { id: plan.id, version: plan.version, rationale: plan.rationale, spec_ref: specRef } : null,
  } : undefined;
  // Scope both sides of an edge. Legacy or corrupt cross-project references
  // must not turn a dependency into a data-sharing shortcut.
  const edges = await tx.select({ dependency: taskDependencies, task: tasks }).from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.fromTaskId))
    .where(and(eq(taskDependencies.toTaskId, task.id), eq(taskDependencies.organizationId, ctx.organizationId),
      eq(tasks.organizationId, ctx.organizationId), eq(tasks.projectId, task.projectId)))
    .orderBy(asc(taskDependencies.fromTaskId), asc(taskDependencies.type)).limit(101);
  const entries: NonNullable<ContextPack["dependency_context"]>["entries"] = [];
  for (const edge of edges.slice(0, 100)) {
    // Only the accepted task's latest execution contributes deliverables. Do
    // not combine artifacts left by older failed attempts with current evidence.
    const latest = edge.task.status === "done" ? (await tx.select().from(runs).where(and(
      eq(runs.taskId, edge.task.id), eq(runs.organizationId, ctx.organizationId),
    )).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1))[0] : undefined;
    const acceptedRun = latest?.status === "completed" ? latest : undefined;
    const produced = acceptedRun ? await tx.select().from(artifacts).where(and(
      eq(artifacts.organizationId, ctx.organizationId), eq(artifacts.taskId, edge.task.id), eq(artifacts.runId, acceptedRun.id),
    )).orderBy(asc(artifacts.id)).limit(101) : [];
    entries.push({ task_id: edge.task.id, title: edge.task.title, dependency_type: edge.dependency.type,
      status: edge.task.status, acceptance_criteria: edge.task.acceptanceCriteria as string[],
      run_id: acceptedRun?.id ?? null, workspace_root: acceptedRun?.workspaceRoot ?? null,
      artifacts_truncated: produced.length > 100,
      artifacts: produced.slice(0, 100).map((artifact) => ({ id: artifact.id, type: artifact.type,
        run_id: acceptedRun!.id, checksum: artifact.checksum,
        // No raw artifact URI/metadata: those may contain signed URLs or secrets.
        content_path: `/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content` })),
    });
  }
  const productDevelopment = spec?.success && spec.data.development_stage ? productDevelopmentContext(spec.data.development_stage) : undefined;
  const [automation] = productDevelopment && goal ? await tx.select().from(goalAutomations).where(and(
    eq(goalAutomations.goalId, goal.id), eq(goalAutomations.organizationId, ctx.organizationId))) : [];
  const releaseCapabilities = automation ? persistedPlanningSnapshot(automation, task.projectId)?.release?.capabilities : undefined;
  let acceptedResearchEvidence: RunVerificationEvidence | undefined;
  if (productDevelopment) {
    const inputs = await acceptedProductInputs(ctx, tx, task, productDevelopment.stage, specs);
    if (inputs) {
      productDevelopment.accepted_inputs = inputs.inputs;
      acceptedResearchEvidence = inputs.researchEvidence;
    }
  }
  return { goalContext, dependencyContext: edges.length ? { version: 1 as const, truncated: edges.length > 100, entries } : undefined,
    productDevelopment, acceptedResearchEvidence, releaseCapabilities, researchOrigin,
    appDelivery: automation?.appDelivery == null ? undefined : ApplicationDeliveryV1Schema.parse(automation.appDelivery),
    expected: spec?.success ? spec.data.expected_artifacts.map((item) => `${item.type}: ${item.description}`) : [] };
}

/** An accepted node receipt constrains later execution; a legacy receipt must remain unknown. */
function bindVerificationCapabilities(selected: BuildContextPackParams["verification"], receipt?: RunVerificationPayload): VerificationCapabilities | undefined {
  if (!receipt) return selected?.capabilities;
  const measured = receiptCapabilityBinding(receipt);
  if (measured === null || (selected && receipt.profile_id !== selected.profile_id)) {
    throw AppError.conflict("Accepted verification receipt does not match the selected profile");
  }
  if (!measured) {
    if (selected?.capabilities) throw AppError.conflict("Accepted research or review source has unknown verification capabilities; the upgraded profile cannot replace its scope");
    return undefined;
  }
  if (!selected?.capabilities || !isDeepStrictEqual(measured, verificationCapabilityBinding(selected.capabilities))) {
    throw AppError.conflict("The selected verification capabilities differ from the accepted node receipt");
  }
  return selected.capabilities;
}

/**
 * Build and persist a run's ContextPack at run-start (#21 Part D). Accepted
 * memories for the task's context are selected with the same pure Phase A
 * selector used by `GET /memories/context`, so injection order/exclusion match
 * exactly. `context_packs.source_memory_ids` records the audit trail; the caller
 * links `runs.context_pack_id` to the returned id.
 *
 * Runs inside the assign transaction (atomic with run creation): if the run
 * rolls back, no orphan ContextPack is left behind.
 */
export async function buildRunContextPack(
  ctx: ServerContext,
  tx: DrizzleDb,
  params: BuildContextPackParams,
): Promise<BuiltContextPack> {
  const now = ctx.clock.nowIso();
  const { task } = params;

  const acceptedRows = await tx
    .select()
    .from(memories)
    .where(and(eq(memories.organizationId, ctx.organizationId), eq(memories.status, "accepted")));
  const selection = selectInjectableMemories(acceptedRows.map(mapMemory), {
    organization_id: ctx.organizationId,
    project_id: task.projectId,
    task_id: task.id,
  });

  const project = (await tx.select().from(projects).where(eq(projects.id, task.projectId)))[0];
  const workspaceRoot = params.workspaceRoot ?? project?.defaultWorkspace ?? "";

  const taskScoped = selection.memories.filter((m) => m.scope === "task");
  const otherScoped = selection.memories.filter((m) => m.scope !== "task");

  // Prefer the run's declared write paths for the FS write scope (#20). Dedupe
  // using canonical lease keys, but preserve the source-case path because this
  // policy is a runtime/filesystem domain, not the lowercase lease-control key.
  // Fall back to the broad workspace root for back-compat when none were declared.
  const writePaths = dedupeWriteScope(params.writePaths ?? []);
  const filesystemWriteScope =
    writePaths.length > 0 ? [...writePaths] : workspaceRoot === "" ? [] : [workspaceRoot];

  let conversation: ContextPack["conversation"];
  const discussion = (await tx.select({ id: discussions.id, goalId: discussions.goalId, status: discussions.status, deadlineAt: discussions.deadlineAt }).from(discussions)
    .where(and(eq(discussions.taskId, task.id), eq(discussions.organizationId, ctx.organizationId))).limit(1))[0];
  const [planningOwner] = discussion ? await tx.select({ automation: goalAutomations }).from(goals)
    .leftJoin(goalAutomations, and(eq(goalAutomations.goalId, goals.id), eq(goalAutomations.organizationId, ctx.organizationId)))
    .where(and(eq(goals.id, discussion.goalId), eq(goals.organizationId, ctx.organizationId), eq(goals.projectId, task.projectId))) : [];
  if (discussion && !planningOwner) throw AppError.conflict("Planning discussion does not belong to this task's project");
  if (planningOwner?.automation && planningOwner.automation.discussionId !== discussion!.id) throw AppError.conflict("Autonomous planning discussion binding changed");
  const independentReview = (await tx.select().from(autonomousReviews).where(and(eq(autonomousReviews.reviewTaskId, task.id), eq(autonomousReviews.organizationId, ctx.organizationId))).limit(1))[0];
  if (independentReview && (independentReview.status !== "pending" || independentReview.turnId !== params.assistantTurnId)) {
    throw AppError.invalidState("This independent review is stopped or bound to another turn");
  }
  if (discussion && (discussion.status !== "running" || ctx.clock.now().getTime() >= Date.parse(discussion.deadlineAt))) {
    throw AppError.invalidState("This planning discussion has stopped or reached its time limit");
  }
  if (params.assistantTurnId) {
    const turn = (await tx.select().from(assistantTurns).where(and(eq(assistantTurns.id, params.assistantTurnId), eq(assistantTurns.taskId, task.id), eq(assistantTurns.organizationId, ctx.organizationId))))[0];
    const request = turn ? (await tx.select().from(messages).where(eq(messages.id, turn.userMessageId)))[0] : undefined;
    if (!turn || !request) throw new Error("Assistant conversation context is missing");
    const history = await tx.select().from(messages).where(and(eq(messages.roomId, turn.roomId),
      turn.threadRootId ? or(eq(messages.threadRootId, turn.threadRootId), eq(messages.id, turn.threadRootId)) : isNull(messages.threadRootId),
      eq(messages.organizationId, ctx.organizationId), eq(messages.kind, "text"), ne(messages.id, request.id),
      // A prior turn's answer can arrive after an already-queued follow-up. Include
      // it, while excluding future user requests from this turn's instructions.
      or(and(eq(messages.actorType, "user"), lte(messages.position, request.position)), eq(messages.actorType, "agent"),
        // Autonomous planning roots are attributed to the system. Include only
        // this thread's exact root, not unrelated system events or future turns.
        turn.threadRootId ? eq(messages.id, turn.threadRootId) : undefined),
    )).orderBy(desc(messages.position)).limit(101);
    const selected: { id: string; role: "user" | "assistant"; body: string; actor_id: string }[] = [];
    let remaining = 80000;
    let truncated = history.length > 100;
    for (const message of history.slice(0, 100)) {
      if (message.body.length > remaining) { truncated = true; break; }
      selected.push({ id: message.id, role: message.actorType === "agent" ? "assistant" : "user", body: message.body, actor_id: message.actorId });
      remaining -= message.body.length;
    }
    conversation = { room_id: turn.roomId, thread_root_id: turn.threadRootId, turn_id: turn.id,
      current_request: planningOwner?.automation ? planningRequest(request.body, persistedPlanningSnapshot(planningOwner.automation, task.projectId)) : request.body,
      messages: selected.reverse(), history_truncated: truncated };
  }

  // Reviews are durable task instructions, not conversation messages. Keep the
  // event's identity/order and exact comment; no reviewed-run link is recorded.
  let reviewFeedback: ContextPack["review_feedback"];
  if (!params.assistantTurnId && !discussion) {
    const reviews = await listTaskReviews(ctx, tx, task.id, task.projectId);
    const entries = reviews.flatMap((review) => {
      const { outcome, comment } = review;
      if (outcome !== "changes_requested" || comment === null || comment.trim().length === 0) return [];
      return [{
        event_id: review.event_id, position: review.position, task_id: review.task_id,
        actor: review.actor, occurred_at: review.occurred_at, comment,
        artifact_ids: review.artifact_ids,
      }];
    });
    if (entries.length > 0) reviewFeedback = { version: 1, entries };
  }

  const [subjectTask] = independentReview ? await tx.select().from(tasks).where(and(eq(tasks.id, independentReview.taskId), eq(tasks.organizationId, ctx.organizationId))) : [];
  const handoff = await taskHandoff(ctx, tx, subjectTask ?? task);
  let reviewVerification: NonNullable<ContextPack["review_subject"]>["verification"];
  let acceptedReceipt = handoff.acceptedResearchEvidence?.payload;
  if (independentReview) {
    // Re-read the owning node's immutable receipt. Neither artifact metadata nor the author's text supplies measured scope.
    const evidence = await readRunVerificationEvidence(ctx, tx, independentReview.subjectRunId);
    if (!evidence || evidence.id !== independentReview.evidenceId || evidence.payload.outcome !== "passed"
      || evidence.payload.subject_digest !== independentReview.subjectDigest) {
      throw AppError.conflict("Independent review source verification is no longer qualified");
    }
    reviewVerification = { version: 1, request_id: evidence.payload.request_id, profile_id: evidence.payload.profile_id,
      profile_digest: evidence.payload.profile_digest, checks: evidence.payload.checks.map((check) => ({
        id: check.id, output_digest: check.output_digest, ...(check.observation ? { observation: check.observation } : {}),
      })), ...(evidence.payload.measurement_plan ? { measurement_plan: evidence.payload.measurement_plan } : {}),
      ...(evidence.payload.application ? { application: evidence.payload.application } : {}) };
    acceptedReceipt = evidence.payload;
  }
  const verificationCapabilities = bindVerificationCapabilities(params.verification, acceptedReceipt);
  if (handoff.appDelivery && (!verificationCapabilities?.application || handoff.releaseCapabilities)) {
    throw AppError.conflict("Application development requires its fixed configured verifier without static publication");
  }
  const releaseCapabilities = handoff.releaseCapabilities;
  if (releaseCapabilities && (releaseCapabilities.binding.verification_profile_id !== params.verification?.profile_id
    || releaseCapabilities.binding.verification_profile_digest !== verificationCapabilities?.profile_digest)) {
    throw AppError.conflict("The selected release capability differs from this run's verified planning scope");
  }
  // Assemble measurement guidance from the same receipt-bound snapshot used for dispatch.
  const productDevelopment = handoff.productDevelopment && verificationCapabilities
    ? { ...handoff.productDevelopment, instructions: productDevelopmentContext(handoff.productDevelopment.stage, verificationCapabilities, releaseCapabilities).instructions }
    : handoff.productDevelopment;
  if (handoff.appDelivery && productDevelopment) productDevelopment.instructions.push(...applicationDevelopmentInstructions());
  const designRevision = await buildDesignRevisionContext(ctx, tx, task, params.runId, independentReview);
  const researchRevision = handoff.researchOrigin ? researchRevisionContext(handoff.researchOrigin.intent,
    handoff.researchOrigin.revision.intentDigest, independentReview?.subjectRunId ?? params.runId) : undefined;
  let researchFeedback: string | undefined;
  if (handoff.researchOrigin) {
    const [parent] = await tx.select().from(goalImportedProductReviews).where(and(
      eq(goalImportedProductReviews.id, handoff.researchOrigin.revision.parentReviewId), eq(goalImportedProductReviews.organizationId, ctx.organizationId)));
    const result = ImportedProductReviewResultV1Schema.parse(parent?.result);
    if (result.outcome !== "reviewed" || result.verdict.outcome !== "changes_requested"
      || researchRevisionHash(result) !== handoff.researchOrigin.intent.parent_review.result_digest) {
      throw AppError.conflict("Research revision feedback differs from its retained independent review");
    }
    researchFeedback = `Imported independent research review requested these changes. Address the findings while preserving the original goal; configuration mapping does not resolve substantive defects.\n${JSON.stringify(result.verdict)}`;
  }
  if (designRevision && productDevelopment) productDevelopment.instructions.push("This is an additive design revision. Follow product_design_revision.request and compare against the exact retained baseline.design.text. Preserve all old validation cases in order and every non-case field, append only requested workspace criterion cases, and preserve the accepted research. The node measures every old and new workspace case; independent review must assess whether the reported defect is covered. Publication remains pending.");
  const payload: ContextPack = ContextPackSchema.parse({
    ...(handoff.appDelivery ? { app_delivery: handoff.appDelivery } : {}),
    ...(researchRevision ? { product_research_revision: researchRevision } : {}),
    ...(designRevision ? { product_design_revision: designRevision } : {}),
    ...(verificationCapabilities ? { verification_capabilities: { ...verificationCapabilities, profile_id: params.verification!.profile_id } } : {}),
    ...(releaseCapabilities ? { release_capabilities: releaseCapabilities } : {}),
    ...(handoff.goalContext ? { goal_context: handoff.goalContext } : {}),
    ...(handoff.dependencyContext ? { dependency_context: handoff.dependencyContext } : {}),
    ...(!independentReview && productDevelopment ? { product_development: productDevelopment } : {}),
    ...(independentReview ? { review_subject: { version: 1, task_id: independentReview.taskId, run_id: independentReview.subjectRunId,
      evidence_id: independentReview.evidenceId, subject_digest: independentReview.subjectDigest, verification: reviewVerification,
      ...(handoff.productDevelopment ? { development_stage: handoff.productDevelopment.stage } : {}) } } : {}),
    ...(conversation ? { conversation } : {}),
    ...(reviewFeedback ? { review_feedback: reviewFeedback } : {}),
    task: {
      id: task.id,
      title: task.title,
      description: researchFeedback ? `${task.description}\n\n${researchFeedback}` : task.description,
      acceptance_criteria: task.acceptanceCriteria,
    },
    project: {
      id: task.projectId,
      name: project?.name ?? task.projectId,
      default_workspace: project?.defaultWorkspace ?? null,
    },
    workspace: { root: workspaceRoot, file_scope: [] },
    policy: {
      ...(discussion || independentReview ? { execution_mode: "discussion" as const } : {}),
      filesystem_write_scope: discussion || independentReview ? [] : filesystemWriteScope,
      requires_approval: ["git.push", "external.post"],
    },
    memory: {
      task_summary: taskScoped.length > 0 ? taskScoped.map(renderMemory).join("\n\n") : null,
      project_notes: otherScoped.map(renderMemory),
    },
    artifacts: { expected: handoff.expected },
  });

  const contextPackId = ctx.idGen.generate(ID_PREFIXES.contextPack);
  await tx.insert(contextPacks).values({
    id: contextPackId,
    organizationId: ctx.organizationId,
    taskId: task.id,
    runId: params.runId,
    payload,
    sourceMemoryIds: selection.source_memory_ids,
    createdAt: now,
  });

  return { contextPackId, sourceMemoryIds: selection.source_memory_ids,
    ...(handoff.appDelivery ? { applicationRequirement: applicationRequirement(verificationCapabilities!.application!, reviewVerification?.application) } : {}),
    ...(releaseCapabilities ? { releaseCapabilityBinding: releaseCapabilityBinding(releaseCapabilities) } : {}),
    ...(verificationCapabilities ? { verificationCapabilityBinding: verificationCapabilityBinding(verificationCapabilities) } : {}) };
}
