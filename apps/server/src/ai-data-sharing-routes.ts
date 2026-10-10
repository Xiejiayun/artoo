import { aiDataSharingConsents, assistantTurns, discussions, runs } from "@artoo/db";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requestContext } from "./auth/auth-routes.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { aiDataSharingState, grantAiDataSharingConsent, revokeAiDataSharingConsent } from "./services/ai-data-sharing-service.js";
import { cancelAssistantTurn } from "./services/assistant-service.js";
import { cancelDiscussion } from "./services/discussion-service.js";
import { cancelRun, failRunDaemonDisconnect } from "./services/run-service.js";
import { unconfirmedDisconnectRunIds } from "./services/execution-state.js";

const activeRuns = ["queued", "starting", "running", "awaiting_input", "paused"];

export function registerAiDataSharingRoutes(app: FastifyInstance, ctx: ServerContext,
  stopProcess: (current: ServerContext, runId: string) => Promise<void>): void {
  app.get("/api/v1/privacy/ai-sharing", (request) => aiDataSharingState(requestContext(ctx, request)));
  app.post("/api/v1/privacy/ai-sharing/consent", async (request) => {
    const body = request.body as { policy_version?: unknown; expected_user_id?: unknown } | null;
    if (!body || Object.keys(body).sort().join(",") !== "expected_user_id,policy_version" || typeof body.policy_version !== "string") {
      throw AppError.validation("Review the current disclosure and submit its policy version.");
    }
    const current = requestContext(ctx, request);
    if (body.expected_user_id !== current.actorUserId) throw AppError.conflict("Your account changed. Reload the AI disclosure before granting permission.");
    return grantAiDataSharingConsent(current, body.policy_version);
  });
  app.delete("/api/v1/privacy/ai-sharing/consent", async (request) => {
    const body = request.body as { stop_my_agent_work?: unknown; expected_user_id?: unknown } | null;
    if (!body || body.stop_my_agent_work !== true || Object.keys(body).sort().join(",") !== "expected_user_id,stop_my_agent_work") {
      throw AppError.validation("Confirm withdrawal and stopping your queued/running agent work.");
    }
    const current = requestContext(ctx, request);
    if (body.expected_user_id !== current.actorUserId) throw AppError.conflict("Your account changed. Reload the AI disclosure before withdrawing permission.");
    // Withdrawal is durable before any external stop request. A failed/offline
    // stop cannot leave a grant active or permit another context dispatch.
    await revokeAiDataSharingConsent(current);
    const ownedRevokedGrant = and(eq(aiDataSharingConsents.organizationId, current.organizationId),
      eq(aiDataSharingConsents.userId, current.actorUserId), isNotNull(aiDataSharingConsents.revokedAt));
    const [planning, turns, executions] = await Promise.all([
      current.db.db.select({ id: discussions.id }).from(discussions)
        .innerJoin(aiDataSharingConsents, eq(discussions.aiDataSharingConsentId, aiDataSharingConsents.id))
        .where(and(ownedRevokedGrant, eq(discussions.organizationId, current.organizationId), inArray(discussions.status, ["running", "stopping"]))),
      current.db.db.select({ id: assistantTurns.id }).from(assistantTurns)
        .innerJoin(aiDataSharingConsents, eq(assistantTurns.aiDataSharingConsentId, aiDataSharingConsents.id))
        .where(and(ownedRevokedGrant, eq(assistantTurns.organizationId, current.organizationId), inArray(assistantTurns.status, ["queued", "waiting", "running"]))),
      current.db.db.select({ id: runs.id, status: runs.status, computerId: runs.computerId, taskId: runs.taskId, failureReason: runs.failureReason }).from(runs)
        .innerJoin(aiDataSharingConsents, eq(runs.aiDataSharingConsentId, aiDataSharingConsents.id))
        .where(and(ownedRevokedGrant, eq(runs.organizationId, current.organizationId), or(inArray(runs.status, activeRuns),
          and(eq(runs.status, "failed"), eq(runs.failureReason, "daemon_disconnect"))))),
    ]);
    const unconfirmed: Array<{ kind: string; id: string }> = [];
    await Promise.all([
    ...planning.map(async (item) => {
      try {
        const result = await cancelDiscussion(current, item.id, stopProcess);
        if (result.status === "stopping") unconfirmed.push({ kind: "discussion", id: item.id });
      }
      catch { unconfirmed.push({ kind: "discussion", id: item.id }); }
    }),
    ...turns.map(async (item) => {
      try { await cancelAssistantTurn(current, item.id, (id) => stopProcess(current, id)); }
      catch { unconfirmed.push({ kind: "assistant_turn", id: item.id }); }
    }),
    ...executions.map(async (item) => {
      try {
        const [latest] = await current.db.db.select().from(runs).where(and(eq(runs.id, item.id), eq(runs.organizationId, current.organizationId)));
        if (latest && activeRuns.includes(latest.status)) await cancelRun(current, item.id, () => stopProcess(current, item.id));
        else if (latest?.status === "failed" && latest.failureReason === "daemon_disconnect"
          && (await unconfirmedDisconnectRunIds(current, current.db.db, { taskId: latest.taskId })).includes(item.id)) {
          await stopProcess(current, item.id);
          await failRunDaemonDisconnect(current, item.id, item.computerId, true);
        }
      } catch { unconfirmed.push({ kind: "run", id: item.id }); }
    }),
    ]);
    return { ...await aiDataSharingState(current), unconfirmed_stops: unconfirmed };
  });
}
