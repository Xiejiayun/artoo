import { contextPacks, goalImportedDesignCompletions, goalImportedDesignContinuations, runs } from "@artoo/db";
import { ImportedDesignContinuationRequestV1Schema, ImportedDesignContinuationResultV1Schema, inspectImportedCompletedDesignV1,
  canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { inspectRunVerification } from "./verification-service.js";

export const importedDesignSha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const importedDesignHash = (value: unknown) => importedDesignSha(canonical(value));
type Continuation = typeof goalImportedDesignContinuations.$inferSelect;

/** Requires the real node-owned audit event and stored requirement/context, never metadata alone. */
export async function inspectCompletedImportedDesign(ctx: ServerContext, tx: DrizzleDb, row: Continuation, value: unknown) {
  const request = ImportedDesignContinuationRequestV1Schema.parse(row.request), result = ImportedDesignContinuationResultV1Schema.parse(value);
  if (result.outcome !== "finished" || !result.verified_design) throw AppError.conflict("H4 requires completed verified design provenance; lifecycle completion alone is insufficient");
  const completed = inspectImportedCompletedDesignV1(request, result.verified_design, importedDesignSha);
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId))).for("update");
  const [pack] = await tx.select().from(contextPacks).where(and(eq(contextPacks.id, row.contextPackId), eq(contextPacks.organizationId, ctx.organizationId)));
  if (!run || !pack || run.status !== "completed" || run.taskId !== row.taskId || run.agentInstanceId !== row.writerInstanceId || run.computerId !== row.computerId
    || run.runtimeId !== request.run_start.runtime || run.contextPackId !== pack.id || pack.runId !== run.id || pack.taskId !== row.taskId
    || run.requestedByUserId !== row.actorUserId || run.aiDataSharingConsentId !== row.consentId || run.aiDataSharingPolicyVersion !== row.policyVersion
    || run.workspaceRoot !== row.workspaceRoot || run.workspaceBranch !== null || run.workspaceAllocation !== null
    || canonical(pack.payload) !== canonical(request.run_start.context_pack.payload) || canonical(run.verificationRequirement) !== canonical(request.run_start.verification))
    throw AppError.conflict("Completed design differs from its exact persisted author run and context");
  const verified = await inspectRunVerification(ctx, tx, run);
  if (!verified.passed || !verified.evidence || canonical(verified.evidence.payload) !== canonical(completed.verification))
    throw AppError.conflict("Completed design lacks its exact committed passed node evidence");
  return { request, result, completed, run, evidence: verified.evidence, pack };
}

export async function readCompletedImportedDesign(ctx: ServerContext, tx: DrizzleDb, row: Continuation) {
  const value = await inspectCompletedImportedDesign(ctx, tx, row, row.result);
  const [provenance] = await tx.select().from(goalImportedDesignCompletions).where(and(eq(goalImportedDesignCompletions.continuationId, row.id), eq(goalImportedDesignCompletions.organizationId, ctx.organizationId)));
  if (!provenance || !provenance.receiptSentAt || provenance.runId !== value.run.id || provenance.evidenceId !== value.evidence.id || provenance.contextPackId !== value.pack.id
    || provenance.resultDigest !== importedDesignHash(row.result) || provenance.completedDesignDigest !== importedDesignHash(value.completed)
    || canonical(provenance.verifiedDesign) !== canonical(value.completed)) throw AppError.conflict("H4 requires the original persisted completion and its accepted dedicated result receipt");
  return { ...value, provenance };
}
