import { contextPacks, goalAutomations, goals, plans, runs, tasks } from "@artoo/db";
import { ContextPackSchema, ReleaseAcceptanceBindingV1Schema, TaskSpecSchema, canonicalReleaseAcceptanceBinding,
  canonicalReleaseJson, type ReleaseAcceptanceBindingV1, type ReleaseCapabilitiesV1, type ProductReleaseReceipt,
  type ProductReleaseHealthReport } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { persistedPlanningSnapshot } from "./planning-capabilities.js";
import { inspectRunVerification, type RunVerificationEvidence } from "./verification-service.js";
import { inspectIndependentReview } from "./independent-review-service.js";
import { unsettledGoalExecutionCount } from "./execution-state.js";
import { assertDesignRevisionRunAdmission, assertNoActiveDesignRevision } from "./product-design-revision-guard.js";

export type ReleaseAcceptanceAutomation = Pick<typeof goalAutomations.$inferSelect,
  "goalId" | "releaseProfileId" | "computerId" | "workspaceRoot" | "planId" | "verificationProfileId" | "executionMode" | "planningCapabilitySnapshot">;
export interface AcceptedReleaseSource {
  run: typeof runs.$inferSelect;
  evidence: RunVerificationEvidence;
  binding: ReleaseAcceptanceBindingV1;
  capabilities: ReleaseCapabilitiesV1;
}
const sha = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
export const releaseAcceptanceBindingDigest = (binding: ReleaseAcceptanceBindingV1): string => sha(canonicalReleaseAcceptanceBinding(binding));

/** Only the final accepted validation author may supply publication obligations. Peer runs remain read-only review evidence. */
export async function inspectFinalReleaseAcceptance(ctx: ServerContext, tx: DrizzleDb,
  automation: ReleaseAcceptanceAutomation): Promise<AcceptedReleaseSource | undefined> {
  await assertNoActiveDesignRevision(ctx, tx, automation.goalId);
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId)));
  if (!goal) throw AppError.conflict("Publication goal is missing");
  const snapshot = persistedPlanningSnapshot(automation, goal.projectId);
  const capabilities = snapshot?.release?.capabilities;
  if (!capabilities) return undefined;
  if (automation.executionMode !== "agent_team" || !automation.planId || goal.currentPlanId !== automation.planId
    || capabilities.binding.release_profile_id !== automation.releaseProfileId) throw AppError.conflict("Publication acceptance plan or executor changed");
  const [plan] = await tx.select().from(plans).where(and(eq(plans.id, automation.planId), eq(plans.goalId, goal.id), eq(plans.organizationId, ctx.organizationId)));
  if (!plan || !Array.isArray(plan.taskSpecs)) throw AppError.conflict("Publication acceptance has no accepted plan");
  const children = await tx.select().from(tasks).where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.projectId, goal.projectId),
    eq(tasks.goalId, goal.id), eq(tasks.sourcePlanId, plan.id)));
  if (!children.length || children.some(task => task.status !== "done") || await unsettledGoalExecutionCount(ctx, tx, goal.id)) {
    throw AppError.conflict("Publication acceptance requires all stage work and actual process exits");
  }
  const candidates: (typeof runs.$inferSelect)[] = [];
  for (const task of children) {
    const index = Number(task.sourcePlanSpecRef), spec = task.sourcePlanSpecRef !== null && Number.isSafeInteger(index)
      ? TaskSpecSchema.safeParse(plan.taskSpecs[index]) : undefined;
    if (!spec?.success) throw AppError.conflict("Publication task is not bound to an accepted plan specification");
    const [latest] = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.taskId, task.id)))
      .orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
    if (!latest || latest.status !== "completed" || latest.computerId !== automation.computerId || latest.workspaceRoot !== automation.workspaceRoot) {
      throw AppError.conflict("Publication stage has no current accepted author execution");
    }
    if (spec.data.development_stage === "validation") candidates.push(latest);
  }
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const run = candidates[0];
  if (!run) throw AppError.conflict("Publication acceptance requires a final validation author");
  return inspectReleaseAcceptanceRun(ctx, tx, run, goal.id, { id: plan.id, version: plan.version }, capabilities);
}

/** In-flight publication history may arrive after pause/replan; only final settlement requires the current plan. */
export async function inspectReleaseAcceptanceRun(ctx: ServerContext, tx: DrizzleDb, run: typeof runs.$inferSelect,
  goalId: string, plan: ReleaseAcceptanceBindingV1["plan"], expectedCapabilities?: ReleaseCapabilitiesV1): Promise<AcceptedReleaseSource> {
  await assertNoActiveDesignRevision(ctx, tx, goalId);
  await assertDesignRevisionRunAdmission(ctx, tx, run, { acceptance: true });
  const result = await inspectRunVerification(ctx, tx, run), evidence = result.evidence;
  const [stored] = await tx.select().from(contextPacks).where(and(eq(contextPacks.id, run.contextPackId ?? ""),
    eq(contextPacks.organizationId, ctx.organizationId), eq(contextPacks.runId, run.id), eq(contextPacks.taskId, run.taskId)));
  const parsed = ContextPackSchema.safeParse(stored?.payload), context = parsed.success ? parsed.data : undefined;
  const capabilities = context?.release_capabilities;
  const summary = evidence?.payload.measurement_plan;
  if (run.status !== "completed" || !result.passed || !evidence?.payload.subject_digest || summary?.version !== 2 || summary.scope !== "final"
    || !summary.pending_release.length || !context || context.review_subject || context.product_development?.stage !== "validation"
    || context.goal_context?.goal_id !== goalId || context.goal_context.plan?.id !== plan.id || context.goal_context.plan.version !== plan.version
    || !capabilities || expectedCapabilities && !isDeepStrictEqual(capabilities, expectedCapabilities)
    || capabilities.binding.workspace_root !== run.workspaceRoot
    || summary.pending_release.some(ref => !isDeepStrictEqual(ref.release_binding, capabilities.binding))) {
    throw AppError.conflict("Final publication obligations lack the exact accepted validation source and context");
  }
  const pin = context.product_development.accepted_inputs?.files.find(file => file.path === summary.research.path);
  if (!pin || pin.checksum !== summary.research.checksum || pin.size !== summary.research.size) throw AppError.conflict("Final publication research is not pinned to its accepted handoff");
  const peer = await inspectIndependentReview(ctx, tx, run, evidence);
  if (peer.status !== "accepted" || !peer.reviewerRunId || !peer.reviewerEvidenceId) throw AppError.conflict(`Publication independent review is not qualified: ${peer.reason}`);
  const binding = ReleaseAcceptanceBindingV1Schema.parse({ version: 1, plan: { id: plan.id, version: plan.version },
    research: summary.research, measurement_plan_digest: summary.measurement_plan_digest, release_binding: capabilities.binding,
    criteria: summary.pending_release.map(({ requirement_id, criterion_index, criterion_digest, claim_id }) =>
      ({ requirement_id, criterion_index, criterion_digest, claim_id })) });
  return { run, evidence, binding, capabilities };
}

/** Receipt success is a separate node measurement; stage feasibility and model text cannot settle these criteria. */
export function assertReleaseAcceptanceReceipt(receipt: ProductReleaseReceipt, source: AcceptedReleaseSource): void {
  if (!isDeepStrictEqual(receipt.request.acceptance_binding, source.binding) || receipt.request.run_id !== source.run.id
    || receipt.request.verification_request_id !== source.evidence.requestId || receipt.request.verification_profile_digest !== source.evidence.payload.profile_digest
    || receipt.request.subject_digest !== source.evidence.payload.subject_digest) {
    throw AppError.conflict("Publication receipt differs from the accepted criterion, source or profile binding");
  }
  if (receipt.outcome !== "published") {
    if (receipt.acceptance) throw AppError.validation("Unsuccessful publication cannot settle criteria");
    return;
  }
  if (receipt.release_profile_digest !== source.capabilities.binding.release_profile_digest
    || !receipt.acceptance || receipt.acceptance.binding_digest !== releaseAcceptanceBindingDigest(source.binding)
    || !isDeepStrictEqual(receipt.acceptance.settled_criteria, source.binding.criteria)
    || !isDeepStrictEqual(receipt.health_checks.map(check => check.path).sort(), source.capabilities.contract.health_checks.map(check => check.path).sort())
    || receipt.health_checks.some(check => !check.passed || check.status_code !== 200 || !check.body_digest)) {
    throw AppError.conflict("Publication has not settled every bound criterion with the configured HTTP measurements");
  }
}

export function releaseAcceptanceSettlement(source: AcceptedReleaseSource, receipt: ProductReleaseReceipt, health: ProductReleaseHealthReport | null) {
  assertReleaseAcceptanceReceipt(receipt, source);
  if (receipt.outcome !== "published" || health && health.state !== "healthy") throw AppError.conflict("Publication is not healthy at criterion settlement");
  return { version: 1 as const, release_id: receipt.request.release_id, run_id: source.run.id, evidence_id: source.evidence.id,
    subject_digest: source.evidence.payload.subject_digest!, acceptance_binding_digest: releaseAcceptanceBindingDigest(source.binding),
    research: source.binding.research, criteria: source.binding.criteria, publication_receipt_digest: sha(canonicalReleaseJson(receipt)),
    health_event_id: health?.event_id ?? null, health_sequence: health?.sequence ?? null, scope: "node-http-point-in-time" as const };
}
