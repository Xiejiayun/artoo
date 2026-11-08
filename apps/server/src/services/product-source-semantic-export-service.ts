import { contextPacks, eventLog, runEventIngest, runs, tasks } from "@artoo/db";
import { canonicalProductSourceTransferValueV1, ContextPackSchema, ProductSourceExportV2Schema, VerificationRequirementSchema,
  PRODUCT_SOURCE_EXPORT_EVENT_V1, PRODUCT_SOURCE_EXPORT_EVENT_V2, productSourceExportDigestV2,
  type ProductSourceExportV2, type ProductSourceTransferRequestV2 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { assertProductSourceExport, requireProductSourceCompletionFrame } from "./product-source-export-service.js";
import { qualifyRunEventMessage } from "./run-event-receipt.js";
import { inspectRunVerification } from "./verification-service.js";

const sha = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
type StoredRun = typeof runs.$inferSelect;
type StoredTask = typeof tasks.$inferSelect;
function conflict(): never { throw AppError.conflict("Semantic source export lacks its exact first-hop research provenance and qualified node frames"); }

async function qualifiedFrame(ctx: ServerContext, db: DrizzleDb, run: StoredRun, sequence: number, type: string, payload: unknown) {
  const [stored] = await db.select({ event: eventLog, receipt: runEventIngest }).from(runEventIngest)
    .innerJoin(eventLog, and(eq(eventLog.id, runEventIngest.eventId), eq(eventLog.organizationId, ctx.organizationId)))
    .where(and(eq(runEventIngest.runId, run.id), eq(runEventIngest.nodeId, run.computerId), eq(runEventIngest.sequence, sequence)));
  const original = qualifyRunEventMessage({ kind: "run.event", node_id: run.computerId, run_id: run.id, sequence, event: { type, payload } });
  if (!stored || stored.event.runId !== run.id || stored.event.taskId !== run.taskId || stored.event.sequence !== sequence
    || stored.receipt.bodyIdentity !== original.bodyIdentity) conflict();
  return stored.event;
}

/** Only the owning node's wire ingest can call this: model text is never an export receipt. */
export async function assertProductSourceSemanticExport(ctx: ServerContext, db: DrizzleDb, run: StoredRun, task: StoredTask,
  input: unknown, sequence: number): Promise<ProductSourceExportV2> {
  const parsed = ProductSourceExportV2Schema.safeParse(input);
  if (!parsed.success) conflict();
  const proof = parsed.data;
  // The byte assertion also requires the exact original verification frame at sequence - 1.
  await assertProductSourceExport(ctx, db, run, task, proof.byte_export, sequence);
  const [stored] = run.contextPackId ? await db.select().from(contextPacks).where(and(eq(contextPacks.id, run.contextPackId),
    eq(contextPacks.organizationId, ctx.organizationId), eq(contextPacks.runId, run.id), eq(contextPacks.taskId, task.id))) : [];
  const parsedContext = ContextPackSchema.safeParse(stored?.payload);
  if (!parsedContext.success) conflict();
  const context = parsedContext.data, capabilities = context.verification_capabilities, release = proof.measurement_v2?.source_release;
  const measured = await inspectRunVerification(ctx, db, run), summary = measured.evidence?.payload.measurement_plan;
  if (context.product_development?.stage !== "research" || !capabilities || capabilities.profile_id !== proof.byte_export.profile_id
    || !isDeepStrictEqual({ ...proof.source_capabilities, profile_id: capabilities.profile_id }, capabilities)
    || !measured.passed || !summary || summary.version !== (release ? 2 : 1) || summary.scope !== "final"
    || !isDeepStrictEqual(summary.research, proof.research_provenance.research)
    || !isDeepStrictEqual(summary.policy, proof.source_capabilities.measurement_plan_policy)
    || sha(canonicalProductSourceTransferValueV1(proof.research_provenance)) !== proof.research_provenance_digest
    // A repair run may reuse an original local receipt from this goal/workspace.
    // Its original run/task attribution must survive instead of being relabelled.
    || proof.research_provenance.sources.some(source => source.origin.workspace_root !== run.workspaceRoot)) conflict();
  if (release) {
    // The extension describes the original node's measured configuration. It cannot
    // replace the stored context, verification requirement or final pending claims.
    const requirement = VerificationRequirementSchema.safeParse(run.verificationRequirement);
    if (!requirement.success || !isDeepStrictEqual(context.release_capabilities, release)
      || !isDeepStrictEqual(requirement.data.release_capability_binding, release.binding)
      || release.binding.project_id !== task.projectId || release.binding.workspace_root !== run.workspaceRoot
      || release.binding.verification_profile_id !== proof.byte_export.profile_id
      || release.binding.verification_profile_digest !== proof.byte_export.profile_digest
      || summary.version !== 2 || !summary.pending_release.length
      || summary.pending_release.some(ref => !isDeepStrictEqual(ref.release_binding, release.binding)
        || ref.claim_id !== release.contract.criterion.id || ref.statement_digest !== release.contract.criterion.statement_digest)) conflict();
    try { productSourceExportDigestV2(proof, sha); } catch { conflict(); }
  } else if (context.release_capabilities) conflict();
  return proof;
}

/** Require a single immutable v2 export between the original verification and completed frames. */
export async function requireProductSourceSemanticExportForTransfer(ctx: ServerContext, db: DrizzleDb, run: StoredRun,
  task: StoredTask, request: ProductSourceTransferRequestV2): Promise<string> {
  if (run.status !== "completed") conflict();
  const exports = await db.select().from(eventLog).where(and(eq(eventLog.organizationId, ctx.organizationId),
    eq(eventLog.runId, run.id), inArray(eventLog.type, [PRODUCT_SOURCE_EXPORT_EVENT_V1, PRODUCT_SOURCE_EXPORT_EVENT_V2]))).limit(2);
  const event = exports[0];
  if (exports.length !== 1 || !event || event.type !== PRODUCT_SOURCE_EXPORT_EVENT_V2 || event.actorType !== "system"
    || event.actorId !== run.computerId || event.sequence === null) conflict();
  const proof = await assertProductSourceSemanticExport(ctx, db, run, task, event.payload, event.sequence);
  if (event.projectId !== proof.byte_export.project_id || event.taskId !== proof.byte_export.task_id
    || !isDeepStrictEqual(request.source_export, proof) || productSourceExportDigestV2(proof, sha) !== request.source_export_digest) conflict();
  const original = await qualifiedFrame(ctx, db, run, event.sequence, PRODUCT_SOURCE_EXPORT_EVENT_V2, proof);
  if (original.id !== event.id || !isDeepStrictEqual(original.payload, proof)) conflict();
  const terminal = await requireProductSourceCompletionFrame(ctx, db, run, event.sequence + 1);
  // Ordinary lifecycle events retain their agent attribution even though the wire frame is node-qualified.
  if (terminal.type !== "run.completed" || terminal.projectId !== proof.byte_export.project_id
    || terminal.actorType !== "agent" || terminal.actorId !== run.agentInstanceId) conflict();
  const measured = await inspectRunVerification(ctx, db, run), summary = measured.evidence?.payload.measurement_plan;
  if (!summary || summary.version !== (proof.measurement_v2 ? 2 : 1) || request.command_pairs.length !== proof.source_capabilities.checks.length
    || request.command_pairs.length !== request.byte_request.destination.capabilities.checks.length
    || summary.used_checks.some(check => !request.command_pairs.some(pair => pair.source_command_id === check.command_id))
    || request.command_pairs.some(pair => !proof.source_capabilities.checks.some(check => check.command_id === pair.source_command_id)
      || !request.byte_request.destination.capabilities.checks.some(check => check.command_id === pair.destination_command_id))) conflict();
  return event.id;
}
