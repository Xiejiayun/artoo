import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { contextPacks, eventLog, runEvidence, runEventIngest, runs, tasks } from "@artoo/db";
import { ContextPackSchema, NodeOwnedResultVerificationEvidenceV1Schema, OwnedResultRunAdmissionV1Schema,
  OwnedResultAuthorBindingV1Schema, OwnedResultReferenceV1Schema, RunStartPayloadSchema,
  assertOwnedResultEvidenceMatchesExpectedV1, canonicalOwnedResultAuthorContextV1,
  canonicalOwnedResultRunAdmissionV1, type NodeOwnedResultProfileDescriptorV1,
  type NodeOwnedResultVerificationEvidenceV1, type OwnedResultRunAdmissionV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { qualifyRunEventMessage } from "./run-event-receipt.js";
import { projectWorkspaceRetention, WORKSPACE_RETAINED_EVENT } from "./workspace-retention-service.js";

export const OWNED_RESULT_FEATURE = "owned-result-run.v1";
export const OWNED_RESULT_EVENT = "run.owned-result.verification";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Public selection only. The server creates request IDs, context and all launch fields. */
export const AssignOwnedResultRequestSchema = z.object({ version: z.literal(1), agent_instance_id: id,
  result_profile_id: id, verifier_template_id: id,
  input: z.discriminatedUnion("kind", [z.object({ kind: z.literal("baseline") }).strict(),
    z.object({ kind: z.literal("accepted_run"), run_id: id }).strict()]),
  write_paths: z.array(z.string().min(1)).max(128).optional(),
}).strict();
export type AssignOwnedResultRequest = z.infer<typeof AssignOwnedResultRequestSchema>;
const acceptedInputSchema = z.object({ run_id: id, reference: OwnedResultReferenceV1Schema, commit: oid }).strict();
const assignmentSchema = z.object({ version: z.literal(1), request: OwnedResultRunAdmissionV1Schema,
  admission_digest: digest, author_launch_digest: digest, accepted_input: acceptedInputSchema.optional() }).strict();
export type OwnedResultAssignment = z.infer<typeof assignmentSchema>;
type StoredRun = typeof runs.$inferSelect;
type StoredTask = typeof tasks.$inferSelect;
export type OwnedResultSession = (profile: NodeOwnedResultProfileDescriptorV1) => boolean;
export type OwnedResultEvidence = Omit<typeof runEvidence.$inferSelect, "payload"> & {
  payload: NodeOwnedResultVerificationEvidenceV1; sequence: number;
};

export function sealOwnedResultAssignment(request: OwnedResultRunAdmissionV1,
  acceptedInput?: z.infer<typeof acceptedInputSchema>): OwnedResultAssignment {
  const parsed = OwnedResultRunAdmissionV1Schema.parse(request);
  const canonical = canonicalOwnedResultRunAdmissionV1(request);
  if (Buffer.byteLength(canonical) > 1024 * 1024) throw AppError.validation("Owned result assignment exceeds its payload bound");
  return assignmentSchema.parse({ version: 1, request: parsed, admission_digest: sha(canonical),
    author_launch_digest: sha(JSON.stringify(RunStartPayloadSchema.parse(parsed.run_start))),
    ...(acceptedInput ? { accepted_input: acceptedInput } : {}) });
}

/** SQL NULL alone selects ordinary mode. A malformed record must never downgrade. */
export function parseOwnedResultAssignment(run: StoredRun): OwnedResultAssignment | null {
  if (run.ownedResultAssignment === null) return null;
  const assignment = assignmentSchema.parse(run.ownedResultAssignment);
  const sealed = sealOwnedResultAssignment(assignment.request, assignment.accepted_input);
  if (!isDeepStrictEqual(assignment, sealed)) throw AppError.conflict("Owned result assignment identity changed");
  const start = assignment.request.run_start, requirement = assignment.request.requirement;
  if (start.run_id !== run.id || start.task_id !== run.taskId || start.agent_instance_id !== run.agentInstanceId
    || start.runtime !== run.runtimeId || start.workspace.root !== run.workspaceRoot || start.workspace.branch !== run.workspaceBranch
    || start.context_pack.id !== run.contextPackId || requirement.profile.node_id !== run.computerId
    || run.verificationRequirement !== null || !start.workspace_allocation
    || !isDeepStrictEqual(start.workspace_allocation, run.workspaceAllocation)
    || start.workspace_retention_reporting !== "typed-v1" || start.verification !== undefined
    || !start.context_pack.payload || start.policy_snapshot.filesystem_write_scope.length !== 1
    || start.policy_snapshot.filesystem_write_scope[0] !== start.workspace.root) {
    throw AppError.conflict("Owned result assignment differs from the persisted run");
  }
  const context = start.context_pack.payload;
  if (context.task.id !== run.taskId || context.workspace.root !== run.workspaceRoot
    || context.project.id !== requirement.profile.project_id
    || sha(canonicalOwnedResultAuthorContextV1(context)) !== requirement.author_context_digest) {
    throw AppError.conflict("Owned result assignment author context changed");
  }
  if (requirement.input.kind === "baseline" ? assignment.accepted_input !== undefined
    : !assignment.accepted_input || !isDeepStrictEqual(assignment.accepted_input.reference, requirement.input.reference)) {
    throw AppError.conflict("Owned result assignment input provenance changed");
  }
  return assignment;
}

export async function assertOwnedResultStoredContext(ctx: ServerContext, db: DrizzleDb,
  run: StoredRun, assignment: OwnedResultAssignment): Promise<void> {
  const [stored] = await db.select().from(contextPacks).where(and(eq(contextPacks.id, run.contextPackId!),
    eq(contextPacks.organizationId, ctx.organizationId), eq(contextPacks.runId, run.id), eq(contextPacks.taskId, run.taskId)));
  if (!stored || !isDeepStrictEqual(stored.payload, assignment.request.run_start.context_pack.payload)
    || !isDeepStrictEqual(ContextPackSchema.parse(stored.payload), stored.payload)) {
    throw AppError.conflict("Owned result original ContextPack is missing or changed");
  }
}

export async function assertOwnedResultDispatchInput(ctx: ServerContext, db: DrizzleDb,
  run: StoredRun, assignment: OwnedResultAssignment): Promise<void> {
  if (!assignment.accepted_input) return;
  const [task] = await db.select().from(tasks).where(and(eq(tasks.id, run.taskId), eq(tasks.organizationId, ctx.organizationId)));
  if (!task) throw AppError.conflict("Owned result task is missing");
  await assertAcceptedOwnedResultInput(ctx, db, task, assignment.request.requirement.profile, assignment.accepted_input);
}

function expectedAuthor(assignment: OwnedResultAssignment) {
  const start = assignment.request.run_start;
  return OwnedResultAuthorBindingV1Schema.parse({ run_id: start.run_id, task_id: start.task_id,
    agent_instance_id: start.agent_instance_id, runtime: start.runtime, workspace: start.workspace,
    launch_binding_digest: assignment.author_launch_digest,
    author_context_digest: assignment.request.requirement.author_context_digest });
}
function qualify(payload: unknown, assignment: OwnedResultAssignment) {
  return assertOwnedResultEvidenceMatchesExpectedV1(NodeOwnedResultVerificationEvidenceV1Schema.parse(payload), {
    descriptor: assignment.request.requirement.profile, requirement: assignment.request.requirement,
    author: expectedAuthor(assignment),
    ...(assignment.accepted_input ? { accepted_input: assignment.accepted_input } : {}),
  }, sha);
}

/** The current wire receiver holds the run lock and authenticates its node session. */
export async function persistOwnedResultEvidence(ctx: ServerContext, db: DrizzleDb, input: {
  run: StoredRun; task: StoredTask; payload: NodeOwnedResultVerificationEvidenceV1; eventId: string;
}): Promise<void> {
  const { run, task } = input, assignment = parseOwnedResultAssignment(run);
  if (!assignment || run.organizationId !== ctx.organizationId || task.projectId !== assignment.request.requirement.profile.project_id
    || run.status !== "running" || task.status !== "running") throw AppError.conflict("Owned result evidence requires its active assigned run");
  await assertOwnedResultStoredContext(ctx, db, run, assignment);
  const payload = qualify(input.payload, assignment);
  if (assignment.accepted_input) await assertAcceptedOwnedResultInput(ctx, db, task,
    assignment.request.requirement.profile, assignment.accepted_input);
  const prior = (await db.select({ id: runEvidence.id }).from(runEvidence).where(and(eq(runEvidence.organizationId, ctx.organizationId),
    eq(runEvidence.runId, run.id), eq(runEvidence.requestId, payload.requirement.request_id))).limit(1))[0];
  if (prior) throw AppError.conflict("Owned result evidence already exists; replay its original qualified frame");
  await db.insert(runEvidence).values({ id: ctx.idGen.generate("evidence"), organizationId: ctx.organizationId,
    runId: run.id, requestId: payload.requirement.request_id, payload, eventId: input.eventId, createdAt: ctx.clock.nowIso() });
}

/** Requires evidence, its node-attributed audit event and the original qualified wire receipt. */
export async function readOwnedResultEvidence(ctx: ServerContext, db: DrizzleDb, run: StoredRun): Promise<OwnedResultEvidence | null> {
  const assignment = parseOwnedResultAssignment(run);
  if (!assignment || run.organizationId !== ctx.organizationId) return null;
  const result = (await db.select({ evidence: runEvidence, event: eventLog, receipt: runEventIngest }).from(runEvidence)
    .innerJoin(eventLog, and(eq(eventLog.id, runEvidence.eventId), eq(eventLog.organizationId, ctx.organizationId)))
    .innerJoin(runEventIngest, and(eq(runEventIngest.eventId, eventLog.id), eq(runEventIngest.runId, run.id), eq(runEventIngest.nodeId, run.computerId)))
    .where(and(eq(runEvidence.organizationId, ctx.organizationId), eq(runEvidence.runId, run.id),
      eq(runEvidence.requestId, assignment.request.requirement.request_id))).limit(1))[0];
  if (!result || !result.receipt.bodyIdentity || result.event.type !== OWNED_RESULT_EVENT || result.event.runId !== run.id
    || result.event.taskId !== run.taskId || result.event.projectId !== assignment.request.requirement.profile.project_id
    || result.event.actorType !== "system" || result.event.actorId !== run.computerId
    || result.event.sequence !== result.receipt.sequence || !isDeepStrictEqual(result.event.payload, result.evidence.payload)) return null;
  try {
    await assertOwnedResultStoredContext(ctx, db, run, assignment);
    const payload = qualify(result.evidence.payload, assignment);
    const original = qualifyRunEventMessage({ kind: "run.event", node_id: run.computerId, run_id: run.id,
      sequence: result.receipt.sequence, event: { type: OWNED_RESULT_EVENT, payload } });
    if (original.bodyIdentity !== result.receipt.bodyIdentity) return null;
    return { ...result.evidence, payload, sequence: result.receipt.sequence };
  } catch { return null; }
}

const acceptedReviewSchema = z.object({ version: z.literal(1), run_id: id, evidence_id: id,
  reference: OwnedResultReferenceV1Schema, commit: oid }).strict();
export function ownedResultReview(evidence: OwnedResultEvidence) {
  return acceptedReviewSchema.parse({ version: 1, run_id: evidence.runId, evidence_id: evidence.id,
    reference: evidence.payload.result.reference, commit: evidence.payload.result.commit });
}

/** Success is ordered after committed evidence and the exact completed retention. */
export async function assertOwnedResultCompletionPrefix(ctx: ServerContext, db: DrizzleDb, run: StoredRun,
  terminalSequence: number): Promise<OwnedResultEvidence> {
  const evidence = await readOwnedResultEvidence(ctx, db, run);
  const [stored] = await db.select({ event: eventLog, receipt: runEventIngest }).from(eventLog)
    .innerJoin(runEventIngest, and(eq(runEventIngest.eventId, eventLog.id), eq(runEventIngest.runId, run.id), eq(runEventIngest.nodeId, run.computerId)))
    .where(and(eq(eventLog.organizationId, ctx.organizationId), eq(eventLog.runId, run.id), eq(eventLog.type, WORKSPACE_RETAINED_EVENT)))
    .orderBy(desc(eventLog.position)).limit(1);
  const retained = projectWorkspaceRetention(run, stored?.event);
  if (!stored || !evidence || evidence.payload.verification.payload.outcome !== "passed" || !retained || retained.outcome !== "completed"
    || evidence.sequence + 1 !== retained.sequence || retained.sequence + 1 !== terminalSequence
    || stored?.receipt.sequence !== retained.sequence) throw AppError.conflict("Owned result completion requires adjacent passing evidence and completed retention");
  const expected = qualifyRunEventMessage({ kind: "run.event", node_id: run.computerId, run_id: run.id, sequence: retained.sequence,
    event: { type: WORKSPACE_RETAINED_EVENT, payload: { version: 1, workspace_root: retained.workspace_root,
      workspace_branch: retained.workspace_branch, outcome: retained.outcome } } });
  if (stored.receipt.bodyIdentity !== expected.bodyIdentity) throw AppError.conflict("Owned result retention lacks its qualified original receipt");
  return evidence;
}

export async function readReviewableOwnedResultEvidence(ctx: ServerContext, db: DrizzleDb, run: StoredRun): Promise<OwnedResultEvidence | null> {
  if (run.status !== "completed") return null;
  const [terminal] = await db.select({ event: eventLog, receipt: runEventIngest }).from(eventLog)
    .innerJoin(runEventIngest, and(eq(runEventIngest.eventId, eventLog.id), eq(runEventIngest.runId, run.id), eq(runEventIngest.nodeId, run.computerId)))
    .where(and(eq(eventLog.organizationId, ctx.organizationId), eq(eventLog.runId, run.id), eq(eventLog.type, "run.completed")))
    .orderBy(desc(eventLog.position)).limit(1);
  if (!terminal?.receipt.bodyIdentity || terminal.event.sequence !== terminal.receipt.sequence) return null;
  try { return await assertOwnedResultCompletionPrefix(ctx, db, run, terminal.receipt.sequence); }
  catch { return null; }
}

export async function assertAcceptedOwnedResultInput(ctx: ServerContext, db: DrizzleDb, target: StoredTask,
  profile: NodeOwnedResultProfileDescriptorV1, input: z.infer<typeof acceptedInputSchema>): Promise<void> {
  const actual = await resolveAcceptedOwnedResultInput(ctx, db, target, profile, input.run_id);
  if (!isDeepStrictEqual(actual, input)) throw AppError.conflict("Accepted owned result input changed");
}
export async function resolveAcceptedOwnedResultInput(ctx: ServerContext, db: DrizzleDb, target: StoredTask,
  profile: NodeOwnedResultProfileDescriptorV1, runId: string): Promise<z.infer<typeof acceptedInputSchema>> {
  const [source] = await db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)));
  const [task] = source ? await db.select().from(tasks).where(and(eq(tasks.id, source.taskId), eq(tasks.organizationId, ctx.organizationId))) : [];
  if (!source || !task || source.status !== "completed" || task.status !== "done" || task.id === target.id
    || task.projectId !== target.projectId || source.computerId !== profile.node_id
    || task.goalId !== target.goalId || task.sourcePlanId !== target.sourcePlanId) throw AppError.conflict("Input must be an accepted result in the same project, node and plan");
  const evidence = await readReviewableOwnedResultEvidence(ctx, db, source);
  const [latest] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.taskId, task.id), eq(runs.organizationId, ctx.organizationId)))
    .orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
  const [review] = await db.select().from(eventLog).where(and(eq(eventLog.organizationId, ctx.organizationId),
    eq(eventLog.taskId, task.id), eq(eventLog.type, "review.completed"))).orderBy(desc(eventLog.position)).limit(1);
  const payload = review?.payload as { outcome?: unknown; owned_result_review?: unknown } | undefined;
  const accepted = acceptedReviewSchema.safeParse(payload?.owned_result_review);
  if (!evidence || evidence.payload.verification.payload.outcome !== "passed" || latest?.id !== source.id
    || !isDeepStrictEqual(evidence.payload.requirement.profile.result_profile, profile.result_profile)
    || !isDeepStrictEqual(evidence.payload.requirement.profile.content_paths, profile.content_paths)
    || payload?.outcome !== "accepted" || !accepted.success || !isDeepStrictEqual(accepted.data, ownedResultReview(evidence))) {
    throw AppError.conflict("Input lacks exact accepted owned-result evidence and review");
  }
  return { run_id: source.id, reference: evidence.payload.result.reference, commit: evidence.payload.result.commit };
}
