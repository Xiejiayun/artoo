import { contextPacks, eventLog, runEvidence, runs } from "@artoo/db";
import { isDeepStrictEqual } from "node:util";
import { ContextPackSchema, productStageHandoffPaths, RunVerificationPayloadSchema, VerificationRequirementSchema, type RunVerificationPayload } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { verificationReceiptMatchesCapabilities } from "./verification-capabilities.js";
import { measurementPlanQualificationError } from "./measurement-plan-qualification.js";
import { designRevisionEvidenceError } from "./product-design-revision-guard.js";

export const RUN_VERIFICATION_EVENT = "run.verification";
export type RunVerificationEvidence = Omit<typeof runEvidence.$inferSelect, "payload"> & { payload: RunVerificationPayload };
type VerificationRun = Pick<typeof runs.$inferSelect, "id" | "organizationId" | "computerId" | "status" | "verificationRequirement">;

async function persistedVerificationContext(ctx: ServerContext, db: DrizzleDb, runId: string): Promise<unknown | undefined> {
  const [stored] = await db.select({ payload: contextPacks.payload }).from(runs)
    .innerJoin(contextPacks, and(eq(contextPacks.id, runs.contextPackId), eq(contextPacks.organizationId, ctx.organizationId),
      eq(contextPacks.runId, runs.id), eq(contextPacks.taskId, runs.taskId)))
    .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)));
  return stored?.payload;
}

/** The caller holds the run lock; receipt replay is handled before this helper. */
export async function persistRunVerificationEvidence(ctx: ServerContext, tx: DrizzleDb, input: {
  run: VerificationRun; payload: RunVerificationPayload; eventId: string;
}): Promise<RunVerificationEvidence> {
  const { run, eventId } = input;
  if (run.organizationId !== ctx.organizationId) throw AppError.permissionDenied("verification run is outside this organization");
  if (run.status !== "running") throw AppError.conflict("verification evidence requires a running run");
  const requirement = VerificationRequirementSchema.safeParse(run.verificationRequirement);
  const parsed = RunVerificationPayloadSchema.safeParse(input.payload);
  if (!requirement.success || !parsed.success || parsed.data.request_id !== requirement.data.request_id
    || parsed.data.profile_id !== requirement.data.profile_id || parsed.data.checks.some((check) => check.observation?.scope === "preview")
    || !verificationReceiptMatchesCapabilities(parsed.data, requirement.data)) {
    throw AppError.validation("verification evidence does not match the run's persisted requirement");
  }
  const storedContext = await persistedVerificationContext(ctx, tx, run.id);
  const qualificationError = measurementPlanQualificationError(parsed.data, requirement.data, storedContext);
  if (qualificationError) throw AppError.validation(qualificationError);
  const revisionError = await designRevisionEvidenceError(ctx, tx, run.id, parsed.data, storedContext === undefined ? undefined : ContextPackSchema.parse(storedContext));
  if (revisionError) throw AppError.validation(revisionError);
  const prior = (await tx.select({ id: runEvidence.id }).from(runEvidence).where(and(
    eq(runEvidence.organizationId, ctx.organizationId), eq(runEvidence.runId, run.id), eq(runEvidence.requestId, parsed.data.request_id),
  )).limit(1))[0];
  if (prior) throw AppError.conflict("verification evidence is already recorded; replay the original event receipt");
  const row = (await tx.insert(runEvidence).values({
    id: ctx.idGen.generate("evidence"), organizationId: ctx.organizationId, runId: run.id,
    requestId: parsed.data.request_id, payload: parsed.data, eventId, createdAt: ctx.clock.nowIso(),
  }).returning())[0]!;
  return { ...row, payload: parsed.data };
}

/** Reads only the exact persisted request and its owning node's audit event. */
export async function readRunVerificationEvidence(ctx: ServerContext, db: DrizzleDb, runId: string): Promise<RunVerificationEvidence | null> {
  const run = (await db.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.id, runId))).limit(1))[0];
  const requirement = VerificationRequirementSchema.safeParse(run?.verificationRequirement);
  if (!run || !requirement.success) return null;
  const result = (await db.select({ evidence: runEvidence, event: eventLog }).from(runEvidence)
    .innerJoin(eventLog, and(eq(eventLog.id, runEvidence.eventId), eq(eventLog.organizationId, ctx.organizationId)))
    .where(and(eq(runEvidence.organizationId, ctx.organizationId), eq(runEvidence.runId, runId),
      eq(runEvidence.requestId, requirement.data.request_id))).limit(1))[0];
  if (!result || result.event.type !== RUN_VERIFICATION_EVENT || result.event.runId !== runId
    || result.event.taskId !== run.taskId || result.event.actorType !== "system" || result.event.actorId !== run.computerId
    || !isDeepStrictEqual(result.event.payload, result.evidence.payload)) return null;
  const payload = RunVerificationPayloadSchema.safeParse(result.evidence.payload);
  if (!payload.success || payload.data.request_id !== requirement.data.request_id || payload.data.profile_id !== requirement.data.profile_id
    || payload.data.checks.some((check) => check.observation?.scope === "preview")
    || !verificationReceiptMatchesCapabilities(payload.data, requirement.data)) return null;
  const storedContext = await persistedVerificationContext(ctx, db, run.id);
  if (measurementPlanQualificationError(payload.data, requirement.data, storedContext)) return null;
  if (await designRevisionEvidenceError(ctx, db, run.id, payload.data, storedContext === undefined ? undefined : ContextPackSchema.parse(storedContext))) return null;
  return { ...result.evidence, payload: payload.data };
}

/** No lifecycle mutation: the orchestrator additionally checks latest run/plan and review state under its transaction. */
export async function inspectRunVerification(ctx: ServerContext, db: DrizzleDb, run: VerificationRun): Promise<{
  passed: boolean; reason: string; evidence?: RunVerificationEvidence;
}> {
  const requirement = VerificationRequirementSchema.safeParse(run.verificationRequirement);
  if (run.organizationId !== ctx.organizationId || !requirement.success) return { passed: false, reason: "Run has no valid verification requirement" };
  const evidence = await readRunVerificationEvidence(ctx, db, run.id);
  if (!evidence || evidence.payload.request_id !== requirement.data.request_id || evidence.payload.profile_id !== requirement.data.profile_id) {
    return { passed: false, reason: "No qualified verification evidence for this run" };
  }
  if (evidence.payload.outcome === "passed") {
    const stored = await persistedVerificationContext(ctx, db, run.id);
    const context = stored === undefined ? undefined : ContextPackSchema.parse(stored);
    const stage = context?.product_development?.stage ?? context?.review_subject?.development_stage;
    if (stage && productStageHandoffPaths(stage).some((path) => !evidence.payload.required_files.some((file) => file.path === path && file.size > 0))) {
      return { passed: false, reason: "Product stage lacks node-measured handoff file evidence", evidence };
    }
    for (const input of context?.product_development?.accepted_inputs?.files ?? []) {
      const actual = evidence.payload.required_files.find((file) => file.path === input.path);
      if (!actual || actual.checksum !== input.checksum || actual.size !== input.size) {
        return { passed: false, reason: `Accepted product input changed: ${input.path}`, evidence };
      }
    }
  }
  return evidence.payload.outcome === "passed"
    ? { passed: true, reason: "Node verification passed", evidence }
    : { passed: false, reason: evidence.payload.reason ?? `Node verification ${evidence.payload.outcome}`, evidence };
}
