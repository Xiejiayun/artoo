import { createHash } from "node:crypto";
import { idempotencyKeys } from "@artoo/db";
import { CreateAutonomousGoalRequestSchema, GoalSchema, GoalAutomationSchema,
  type CreateAutonomousGoalRequest, type Goal, type GoalAutomation } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

export interface GoalSubmissionIdentity { key: string; url: string; rawBody: unknown }
export interface GoalSubmissionResult { goal: Goal; automation: GoalAutomation }
export const AUTONOMOUS_GOAL_PATH = "/api/v1/autonomous-goals";
export function goalSubmissionScope(ctx: ServerContext, url = AUTONOMOUS_GOAL_PATH): string {
  return `${ctx.organizationId}:${ctx.actorUserId}:POST:${url}`;
}
/** Explicit property order binds normalized semantics, including absent opt-ins. */
export function canonicalGoalRequest(value: CreateAutonomousGoalRequest): string {
  const input = CreateAutonomousGoalRequestSchema.parse(value);
  return JSON.stringify({ project_id: input.project_id, objective: input.objective,
    verification_profile_id: input.verification_profile_id, execution_mode: input.execution_mode ?? null,
    release_profile_id: input.release_profile_id ?? null, max_retries: input.max_retries,
    source_handoff: input.source_handoff ?? null });
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
function identityHash(identity: GoalSubmissionIdentity): string { return hash(JSON.stringify(identity.rawBody ?? null)); }
export function storedGoalSubmission(value: unknown): GoalSubmissionResult {
  if (!value || typeof value !== "object" || !("status" in value) || value.status !== 201 || !("body" in value)
    || !value.body || typeof value.body !== "object" || !("goal" in value.body) || !("automation" in value.body)) {
    throw AppError.conflict("The saved goal request has no valid creation response");
  }
  return { goal: GoalSchema.parse(value.body.goal), automation: GoalAutomationSchema.parse(value.body.automation) };
}
export async function beginGoalSubmission(ctx: ServerContext, tx: DrizzleDb, input: CreateAutonomousGoalRequest,
  identity: GoalSubmissionIdentity): Promise<GoalSubmissionResult | null> {
  if (canonicalGoalRequest(CreateAutonomousGoalRequestSchema.parse(identity.rawBody)) !== canonicalGoalRequest(input)) {
    throw AppError.conflict("Goal request identity differs from its submitted body");
  }
  const scope = goalSubmissionScope(ctx, identity.url), requestHash = identityHash(identity);
  const inserted = await tx.insert(idempotencyKeys).values({ scope, key: identity.key, requestHash,
    responseJson: null, eventIds: [], createdAt: ctx.clock.nowIso() }).onConflictDoNothing().returning({ key: idempotencyKeys.key });
  if (inserted.length) return null;
  const [existing] = await tx.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, identity.key)));
  if (!existing) throw AppError.conflict("Goal request reservation conflicted");
  // Preserve the middleware's full raw-body identity, including unknown fields and property order.
  if (existing.requestHash !== requestHash) throw AppError.conflict("Idempotency-Key reused with a different request body");
  if (existing.responseJson === null) throw AppError.conflict("The prior goal request outcome is unknown; its reservation is retained");
  return storedGoalSubmission(existing.responseJson);
}
export async function finishGoalSubmission(ctx: ServerContext, tx: DrizzleDb,
  identity: GoalSubmissionIdentity, result: GoalSubmissionResult): Promise<void> {
  const saved = await tx.update(idempotencyKeys).set({ responseJson: { status: 201, body: result } })
    .where(and(eq(idempotencyKeys.scope, goalSubmissionScope(ctx, identity.url)), eq(idempotencyKeys.key, identity.key),
      eq(idempotencyKeys.requestHash, identityHash(identity)))).returning({ key: idempotencyKeys.key });
  if (saved.length !== 1) throw AppError.conflict("Goal request reservation changed before commit");
}
