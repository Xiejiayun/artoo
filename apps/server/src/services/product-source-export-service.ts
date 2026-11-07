import { contextPacks, eventLog, goals, plans, runEventIngest, runs, tasks } from "@artoo/db";
import { canonicalProductSourceTransferValueV1, ContextPackSchema, ProductSourceExportV1Schema,
  PRODUCT_SOURCE_EXPORT_EVENT_V1, type ProductSourceExportV1, type ProductSourceTransferRequestV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { qualifyRunEventMessage } from "./run-event-receipt.js";
import { inspectRunVerification } from "./verification-service.js";

const hash = (value: unknown) => `sha256:${createHash("sha256").update(canonicalProductSourceTransferValueV1(value)).digest("hex")}`;
type StoredRun = typeof runs.$inferSelect;
type StoredTask = typeof tasks.$inferSelect;
function conflict(): never { throw AppError.conflict("Product source export lacks its exact node verification and current product context"); }

async function qualifiedFrame(ctx: ServerContext, db: DrizzleDb, run: StoredRun, sequence: number, type: string, payload: unknown) {
  const [stored] = await db.select({ event: eventLog, receipt: runEventIngest }).from(runEventIngest)
    .innerJoin(eventLog, and(eq(eventLog.id, runEventIngest.eventId), eq(eventLog.organizationId, ctx.organizationId)))
    .where(and(eq(runEventIngest.runId, run.id), eq(runEventIngest.nodeId, run.computerId), eq(runEventIngest.sequence, sequence)));
  const original = qualifyRunEventMessage({ kind: "run.event", node_id: run.computerId, run_id: run.id, sequence, event: { type, payload } });
  if (!stored || stored.event.runId !== run.id || stored.event.taskId !== run.taskId || stored.event.sequence !== sequence
    || stored.receipt.bodyIdentity !== original.bodyIdentity) conflict();
  return stored.event;
}

/** Source transfer accepts the two successful terminal shapes without rewriting either receipt. */
export async function requireProductSourceCompletionFrame(ctx: ServerContext, db: DrizzleDb, run: StoredRun, sequence: number) {
  const [stored] = await db.select({ event: eventLog, receipt: runEventIngest }).from(runEventIngest)
    .innerJoin(eventLog, and(eq(eventLog.id, runEventIngest.eventId), eq(eventLog.organizationId, ctx.organizationId)))
    .where(and(eq(runEventIngest.runId, run.id), eq(runEventIngest.nodeId, run.computerId), eq(runEventIngest.sequence, sequence)));
  if (!stored || stored.event.runId !== run.id || stored.event.taskId !== run.taskId || stored.event.sequence !== sequence
    || stored.event.type !== "run.completed" || stored.event.actorType !== "agent" || stored.event.actorId !== run.agentInstanceId) conflict();
  // The protocol preserves null. Match each complete original wire body; ingest/replay
  // must still reject replacing an omitted reason with null at the same sequence.
  const matches = [{ phase: "completed" }, { phase: "completed", reason: null }].some(payload =>
    stored.receipt.bodyIdentity === qualifyRunEventMessage({ kind: "run.event", node_id: run.computerId, run_id: run.id,
      sequence, event: { type: "run.lifecycle", payload } }).bodyIdentity);
  if (!matches) conflict();
  return stored.event;
}

/** Local object provenance never reaches this boundary: only a qualified owning-node frame does. */
export async function assertProductSourceExport(ctx: ServerContext, db: DrizzleDb, run: StoredRun, task: StoredTask,
  input: unknown, sequence: number): Promise<ProductSourceExportV1> {
  const proof = ProductSourceExportV1Schema.parse(input);
  if (run.organizationId !== ctx.organizationId || task.organizationId !== ctx.organizationId || run.taskId !== task.id
    || run.ownedResultAssignment !== null || run.workspaceBranch !== null || proof.node_id !== run.computerId || proof.run_id !== run.id
    || proof.task_id !== task.id || proof.project_id !== task.projectId || proof.goal_id !== task.goalId || proof.plan_id !== task.sourcePlanId) conflict();
  const [storedContext] = run.contextPackId ? await db.select().from(contextPacks).where(and(eq(contextPacks.id, run.contextPackId),
    eq(contextPacks.organizationId, ctx.organizationId), eq(contextPacks.runId, run.id), eq(contextPacks.taskId, task.id))) : [];
  const parsed = ContextPackSchema.safeParse(storedContext?.payload);
  if (!parsed.success) conflict();
  const context = parsed.data;
  if (!context.product_development || context.review_subject || context.policy.execution_mode === "discussion"
    || context.goal_context?.goal_id !== proof.goal_id || context.goal_context.plan?.id !== proof.plan_id
    || context.project.id !== proof.project_id || context.task.id !== proof.task_id || context.workspace.root !== run.workspaceRoot
    || hash(context) !== proof.context_digest) conflict();
  const [goal] = await db.select().from(goals).where(and(eq(goals.id, proof.goal_id), eq(goals.organizationId, ctx.organizationId)));
  const [plan] = await db.select().from(plans).where(and(eq(plans.id, proof.plan_id), eq(plans.organizationId, ctx.organizationId)));
  if (!goal || goal.status !== "running" || goal.currentPlanId !== proof.plan_id || goal.projectId !== proof.project_id
    || !plan || plan.status !== "accepted" || plan.goalId !== goal.id) conflict();
  const measured = await inspectRunVerification(ctx, db, run), evidence = measured.evidence;
  if (!measured.passed || !evidence || proof.verification_request_id !== evidence.requestId || proof.profile_id !== evidence.payload.profile_id
    || proof.profile_digest !== evidence.payload.profile_digest || proof.subject_digest !== evidence.payload.subject_digest
    || hash(evidence.payload) !== proof.verification_digest
    || proof.export_id !== hash({ run_id: run.id, request_id: evidence.requestId, capsule_digest: proof.capsule_digest })) conflict();
  const verified = await qualifiedFrame(ctx, db, run, sequence - 1, "run.verification", evidence.payload);
  if (verified.id !== evidence.eventId || verified.type !== "run.verification" || verified.actorType !== "system"
    || verified.actorId !== run.computerId || verified.projectId !== proof.project_id || !isDeepStrictEqual(verified.payload, evidence.payload)) conflict();
  return proof;
}

/** Called under the original source run/task locks, after authorization and before byte I/O. */
export async function requireProductSourceExportForTransfer(ctx: ServerContext, db: DrizzleDb, run: StoredRun, task: StoredTask,
  request: ProductSourceTransferRequestV1): Promise<ProductSourceExportV1> {
  if (run.status !== "completed") conflict();
  const exports = await db.select().from(eventLog).where(and(eq(eventLog.organizationId, ctx.organizationId),
    eq(eventLog.runId, run.id), eq(eventLog.type, PRODUCT_SOURCE_EXPORT_EVENT_V1))).limit(2);
  const event = exports[0];
  if (exports.length !== 1 || !event || event.actorType !== "system" || event.actorId !== run.computerId || event.sequence === null) conflict();
  const proof = await assertProductSourceExport(ctx, db, run, task, event.payload, event.sequence);
  if (event.projectId !== proof.project_id || event.taskId !== proof.task_id) conflict();
  const original = await qualifiedFrame(ctx, db, run, event.sequence, PRODUCT_SOURCE_EXPORT_EVENT_V1, proof);
  if (original.id !== event.id || !isDeepStrictEqual(original.payload, proof)) conflict();
  // Ordinary verified runs have no worktree retention frame. Completion must be the
  // next exact qualified node frame, preventing a failed/export-only run from qualifying.
  const terminal = await requireProductSourceCompletionFrame(ctx, db, run, event.sequence + 1);
  if (terminal.type !== "run.completed" || terminal.projectId !== proof.project_id) conflict();
  const source = request.source;
  if (proof.node_id !== source.node_id || proof.run_id !== source.run_id || proof.task_id !== source.task_id
    || proof.project_id !== request.project_id || proof.goal_id !== request.goal_id || proof.plan_id !== request.plan_id
    || proof.verification_request_id !== source.verification_request_id || proof.profile_id !== source.profile_id
    || proof.profile_digest !== source.profile_digest || proof.subject_digest !== source.subject_digest
    || proof.capsule_digest !== source.capsule_digest || proof.manifest_digest !== source.manifest_digest || proof.capsule_bytes !== source.capsule_bytes) conflict();
  return proof;
}
