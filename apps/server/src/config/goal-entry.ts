import { z } from "zod";
import { PreparedGoalEntryV1Schema, PreparedGoalRequestV1Schema, type PreparedGoalEntryV1,
  type CreateAutonomousGoalRequest } from "@artoo/domain";
import { idempotencyKeys, projects } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { AUTONOMOUS_GOAL_PATH, canonicalGoalRequest, goalSubmissionScope, storedGoalSubmission,
  type GoalSubmissionIdentity } from "../services/goal-submission.js";

const common = {
  version: z.literal(1), session_id: z.string().min(1).max(128), project_id: z.string().min(1).max(128),
  actor_user_id: z.string().min(1).max(128), request_key: z.string().min(1).max(128), request: PreparedGoalRequestV1Schema,
  progress_updates: z.literal("polling").optional(),
};
export const PreparedGoalEntryConfigV1Schema = z.discriminatedUnion("submission_owner", [
  z.object({ ...common, submission_owner: z.literal("console"), objective: z.string().trim().min(1).max(10000) }).strict(),
  z.object({ ...common, submission_owner: z.literal("browser") }).strict(),
]);
export type PreparedGoalEntryConfigV1 = z.infer<typeof PreparedGoalEntryConfigV1Schema>;
/** Only the local startup process supplies this; never read it from HTTP input. */
export function loadGoalEntryConfig(env: NodeJS.ProcessEnv): PreparedGoalEntryConfigV1 | undefined {
  if (env.ARTOO_GOAL_ENTRY === undefined) return undefined;
  if (Buffer.byteLength(env.ARTOO_GOAL_ENTRY) > 65536) throw new Error("ARTOO_GOAL_ENTRY exceeds 64 KiB");
  let value: unknown;
  try { value = JSON.parse(env.ARTOO_GOAL_ENTRY); } catch { throw new Error("ARTOO_GOAL_ENTRY must be valid JSON"); }
  const result = PreparedGoalEntryConfigV1Schema.safeParse(value);
  if (!result.success) throw new Error("ARTOO_GOAL_ENTRY is not a valid prepared goal session");
  if (result.data.progress_updates === "polling" && (env.NODE_ENV !== "development" || env.AUTH_ENFORCE_API !== "0"
    || !["127.0.0.1", "::1", "localhost"].includes(env.ARTOO_HOST ?? "127.0.0.1") || env.ARTOO_ALLOW_DEV_NODE_TOKEN !== "0")) {
    throw new Error("Prepared polling requires explicit loopback development mode with dev node tokens disabled");
  }
  Object.freeze(result.data.request.source_handoff); Object.freeze(result.data.request.app_delivery);
  Object.freeze(result.data.request); return Object.freeze(result.data);
}
export function assertPreparedManualGoal(ctx: ServerContext, projectId: string): void {
  if (ctx.goalEntry?.project_id === projectId) throw AppError.conflict("This prepared session accepts its bound product request; start another session for a new goal");
}
export function assertPreparedGoalRequest(ctx: ServerContext, input: CreateAutonomousGoalRequest, identity?: GoalSubmissionIdentity): void {
  const entry = ctx.goalEntry;
  if (!entry || entry.project_id !== input.project_id) return;
  if (entry.actor_user_id !== ctx.actorUserId) throw AppError.permissionDenied("This prepared request belongs to another account");
  if (!identity || identity.key !== entry.request_key || identity.url !== AUTONOMOUS_GOAL_PATH) {
    throw AppError.conflict("Use this prepared session's original request identity");
  }
  const expected = { project_id: entry.project_id, objective: entry.submission_owner === "console" ? entry.objective : input.objective, ...entry.request };
  if (canonicalGoalRequest(input) !== canonicalGoalRequest(expected)) {
    throw AppError.conflict("This request differs from the prepared session's configured product request");
  }
}
export async function preparedGoalEntrySnapshot(ctx: ServerContext): Promise<PreparedGoalEntryV1 | undefined> {
  const entry = ctx.goalEntry;
  if (!entry || entry.actor_user_id !== ctx.actorUserId) return undefined;
  if (entry.progress_updates === "polling" && (ctx.authConfig.enforceApiAuth || ctx.deviceAuth.devNodeToken !== null || ctx.deviceAuth.devControlEscape)) {
    throw AppError.conflict("The prepared update mode differs from the server's actual local configuration");
  }
  const [project] = await ctx.db.db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.id, entry.project_id), eq(projects.organizationId, ctx.organizationId)));
  if (!project) throw AppError.conflict("The prepared request project is unavailable");
  const [stored] = await ctx.db.db.select().from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.scope, goalSubmissionScope(ctx)), eq(idempotencyKeys.key, entry.request_key)));
  let goalId: string | null = null;
  if (stored) {
    if (stored.responseJson === null) throw AppError.conflict("The prior prepared request outcome is unknown; its reservation is retained");
    const result = storedGoalSubmission(stored.responseJson);
    if (result.goal.project_id !== entry.project_id || result.goal.owner_user_id !== ctx.actorUserId
      || result.automation.actor_user_id !== ctx.actorUserId || result.automation.goal_id !== result.goal.id) {
      throw AppError.conflict("The saved request does not match this prepared session");
    }
    const actual = { project_id: result.goal.project_id, objective: result.goal.objective,
      execution_mode: result.automation.execution_mode, verification_profile_id: result.automation.verification_profile_id,
      release_profile_id: result.automation.release_profile_id ?? undefined,
      max_retries: result.goal.budgets.max_retries ?? 3, source_handoff: result.automation.source_handoff ?? undefined,
      app_delivery: result.automation.app_delivery ?? undefined };
    assertPreparedGoalRequest(ctx, actual, { key: entry.request_key, url: AUTONOMOUS_GOAL_PATH, rawBody: actual });
    goalId = result.goal.id;
  }
  const common = { version: 1, session_id: entry.session_id, project_id: entry.project_id, goal_id: goalId,
    ...(entry.progress_updates ? { progress_updates: entry.progress_updates } : {}) };
  return PreparedGoalEntryV1Schema.parse(entry.submission_owner === "console"
    ? { ...common, submission_owner: "console" }
    : { ...common, submission_owner: "browser", request_key: entry.request_key, request: entry.request });
}
