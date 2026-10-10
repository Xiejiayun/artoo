import { isMemberSuspended } from "../services/member-status.js";
import { devices, deviceTokens, users } from "@artoo/db";
import { parseDeviceToken } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { resolveControlToken } from "../services/device-service.js";
import { resolveSession } from "./auth-service.js";
import { parseCookies } from "./cookies.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface RequestPrincipal {
  user: AuthenticatedUser;
  credential: { kind: "session"; sessionId: string } |
    { kind: "device"; deviceId: string; tokenId: string };
}

/** An explicitly supplied Authorization header always takes precedence over cookies. */
export function requestCredential(ctx: ServerContext, req: FastifyRequest, allowWebSocketProtocol = false): {
  supplied: boolean;
  raw: string | null;
  bearer: boolean;
} {
  if (allowWebSocketProtocol) {
    const header = req.headers["sec-websocket-protocol"];
    const protocols = typeof header === "string" ? header.split(",").map((item) => item.trim()) : [];
    const authProtocols = protocols.filter((item) => item.startsWith("artoo-auth"));
    if (authProtocols.length > 0 || Array.isArray(header)) {
      const authProtocol = authProtocols[0];
      const valid = req.headers.authorization === undefined && protocols.length === 2 &&
        protocols[0] === "artoo" && authProtocols.length === 1 && authProtocol?.startsWith("artoo-auth.");
      return { supplied: true, raw: valid ? authProtocol?.slice("artoo-auth.".length) || null : null, bearer: true };
    }
  }
  if (req.headers.authorization !== undefined) {
    const match = /^Bearer[\t ]+([^\s]+)$/i.exec(req.headers.authorization.trim());
    return { supplied: true, raw: match?.[1] ?? null, bearer: true };
  }
  const cookies = parseCookies(req.headers.cookie);
  const supplied = Object.prototype.hasOwnProperty.call(cookies, ctx.authConfig.sessionCookieName);
  return { supplied, raw: cookies[ctx.authConfig.sessionCookieName] || null, bearer: false };
}

export async function resolveRequestPrincipal(
  ctx: ServerContext,
  req: FastifyRequest,
  allowWebSocketProtocol = false,
): Promise<RequestPrincipal | null> {
  const { raw, bearer } = requestCredential(ctx, req, allowWebSocketProtocol);
  if (raw === null) return null;
  const session = await resolveSession(ctx, raw);
  let userId: string;
  let credential: RequestPrincipal["credential"];
  if (session !== null) {
    userId = session.userId;
    credential = { kind: "session", sessionId: session.sessionId };
  } else {
    // Device credentials are accepted only in a bearer header, never cookies.
    if (!bearer) return null;
    const resolved = await resolveControlToken(ctx, raw);
    if (resolved === null) return null;
    const device = (await ctx.db.db.select().from(devices).where(and(
      eq(devices.id, resolved.deviceId), eq(devices.organizationId, ctx.organizationId),
    )))[0];
    const parsed = parseDeviceToken(raw);
    if (device === undefined || parsed === null) return null;
    const token = (await ctx.db.db.select({ id: deviceTokens.id }).from(deviceTokens).where(and(
      eq(deviceTokens.tokenLookup, parsed.lookup), eq(deviceTokens.organizationId, ctx.organizationId),
    )))[0];
    if (token === undefined) return null;
    userId = device.enrolledByUserId;
    credential = { kind: "device", deviceId: device.id, tokenId: token.id };
  }
  const user = (await ctx.db.db.select().from(users).where(and(
    eq(users.id, userId), eq(users.organizationId, ctx.organizationId),
  )))[0];
  if (user === undefined || await isMemberSuspended(ctx, userId)) return null;
  if (!isAllowedTeamEmail(ctx, user.email)) return null;
  const role = effectiveTeamRole(ctx, user.email, user.role);
  return { user: { id: user.id, email: user.email, name: user.displayName, role }, credential };
}

export async function revokeControlSession(ctx: ServerContext, tokenId: string): Promise<void> {
  await ctx.db.db.update(deviceTokens).set({ status: "revoked", revokedAt: ctx.clock.nowIso() }).where(and(
    eq(deviceTokens.id, tokenId), eq(deviceTokens.organizationId, ctx.organizationId),
    eq(deviceTokens.kind, "control_session"),
  ));
}

/** Checks the authenticated actor, never a client-supplied owner id. */
export async function mayAdministerRoute(
  ctx: ServerContext,
  principal: RequestPrincipal,
  req: FastifyRequest,
): Promise<boolean> {
  const route = req.routeOptions.url ?? req.url.split("?")[0] ?? "";
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return true;
  // Pairing only transfers the current user's identity to their own client.
  // Adding an execution host is a separate team-administrator decision.
  const adminOnly = route === "/api/v1/devices/:id/enroll" || route === "/api/v1/skills/install" ||
    route === "/api/v1/projects" || route === "/api/v1/projects/:id" ||
    route === "/api/v1/computers/:id/instances" || route === "/api/v1/agent-instances/:id" ||
    route === "/api/v1/agent-instances/:id/worktree-workspace-base";
  const ownDevice = route === "/api/v1/devices/:id/revoke";
  if (!adminOnly && !ownDevice) return true;
  if (principal.user.role === "owner" || principal.user.role === "admin") return true;
  if (ownDevice) {
    const id = (req.params as { id?: string }).id;
    if (id === undefined) return false;
    const device = (await ctx.db.db.select({ ownerId: devices.enrolledByUserId }).from(devices).where(and(
      eq(devices.id, id), eq(devices.organizationId, ctx.organizationId),
    )))[0];
    return device?.ownerId === principal.user.id;
  }
  return false;
}

/** Service-level administrative authorization, including configured owner changes.
 * With a transaction, hold the actor row against role/email changes until commit. */
export async function requireAdministrator(ctx: ServerContext, tx?: DrizzleDb): Promise<void> {
  const query = (tx ?? ctx.db.db).select().from(users).where(and(
    eq(users.id, ctx.actorUserId), eq(users.organizationId, ctx.organizationId),
  ));
  const user = (await (tx === undefined ? query : query.for("share")))[0];
  if (user === undefined || await isMemberSuspended(ctx, ctx.actorUserId, tx) || !isAllowedTeamEmail(ctx, user.email)) throw AppError.permissionDenied("an owner or admin is required");
  const role = effectiveTeamRole(ctx, user.email, user.role);
  if (role !== "owner" && role !== "admin") throw AppError.permissionDenied("an owner or admin is required");
}

/** Read current owner policy for authorization and UI without requiring another
 * OAuth login to rewrite a previously stored role. Explicit admins retain it. */
export function effectiveTeamRole(ctx: ServerContext, email: string, storedRole: string): string {
  const owners = ctx.authConfig.ownerEmails;
  if (owners?.includes(email.trim().toLowerCase()) === true) return "owner";
  return owners !== undefined && storedRole === "owner" ? "member" : storedRole;
}

function isAllowedTeamEmail(ctx: ServerContext, email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return (ctx.authConfig.allowedEmails === undefined || ctx.authConfig.allowedEmails.includes(normalized)) &&
    (ctx.authConfig.hostedDomain === undefined || normalized.endsWith(`@${ctx.authConfig.hostedDomain}`));
}
