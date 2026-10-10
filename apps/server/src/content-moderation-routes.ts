import { memberSuspensions, users } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requestContext } from "./auth/auth-routes.js";
import { effectiveTeamRole, requireAdministrator } from "./auth/request-auth.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { getContentRules, messageVisibility, listContentReports, listMyContentReports, reportMessage, resolveContentReport, setContentRules } from "./services/content-moderation-service.js";
import { setMemberSuspension } from "./services/member-suspension-service.js";

function body(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw AppError.validation("Invalid content management request.");
  }
  return value as Record<string, unknown>;
}
export function registerContentModerationRoutes(app: FastifyInstance, ctx: ServerContext,
  closeDevice: (deviceId: string) => number): void {
  app.post("/api/v1/rooms/:id/messages/visibility", (request) => {
    const value = body(request.body, ["message_ids"]);
    return messageVisibility(requestContext(ctx, request), (request.params as { id: string }).id, value.message_ids);
  });
  app.get("/api/v1/moderation/rules", (request) => getContentRules(requestContext(ctx, request)));
  app.put("/api/v1/moderation/rules", (request) => {
    const value = body(request.body, ["blocked_phrases", "version"]);
    return setContentRules(requestContext(ctx, request), value.blocked_phrases, value.version);
  });
  app.post("/api/v1/messages/:id/report", (request) => {
    const value = body(request.body, ["reason"]);
    return reportMessage(requestContext(ctx, request), (request.params as { id: string }).id, value.reason);
  });
  app.get("/api/v1/moderation/my-reports", (request) => listMyContentReports(requestContext(ctx, request), (request.query as { before?: string }).before));
  app.get("/api/v1/moderation/reports", (request) => listContentReports(requestContext(ctx, request), (request.query as { before?: string }).before));
  app.post("/api/v1/moderation/reports/:id/resolve", (request) => {
    const value = body(request.body, ["action", "note"]);
    return resolveContentReport(requestContext(ctx, request), (request.params as { id: string }).id, value.action, value.note);
  });
  app.get("/api/v1/moderation/members", async (request) => {
    const current = requestContext(ctx, request); await requireAdministrator(current);
    const members = await current.db.db.select({ id: users.id, name: users.displayName, email: users.email,
      role: users.role, suspended_at: memberSuspensions.suspendedAt, reinstated_at: memberSuspensions.reinstatedAt }).from(users)
      .leftJoin(memberSuspensions, and(eq(memberSuspensions.userId, users.id), eq(memberSuspensions.organizationId, current.organizationId)))
      .where(eq(users.organizationId, current.organizationId));
    return { members: members.map((member) => ({ ...member, role: effectiveTeamRole(current, member.email, member.role) })) };
  });
  app.post("/api/v1/moderation/members/:id/suspension", async (request) => {
    const value = body(request.body, ["suspended", "reason"]);
    if (typeof value.suspended !== "boolean") throw AppError.validation("Choose whether to suspend this member.");
    const result = await setMemberSuspension(requestContext(ctx, request), (request.params as { id: string }).id, value.suspended, value.reason);
    let closed = 0;
    for (const id of result.revoked_device_ids) closed += closeDevice(id);
    return { ...result, connections_closed: closed,
      execution_notice: "Suspension revokes account and device access. It does not confirm that existing processes on execution computers stopped." };
  });
}
