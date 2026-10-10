import { aiDataSharingConsents, devices, deviceTokens, memberSuspensions, pairingCodes, sessions, users } from "@artoo/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { effectiveTeamRole, requireAdministrator } from "../auth/request-auth.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

export async function setMemberSuspension(ctx: ServerContext, userId: string, suspended: boolean, reason: unknown) {
  if (ctx.actorUserId === userId) throw AppError.permissionDenied("You cannot suspend or reinstate your own account.");
  if (typeof reason !== "string" || !reason.trim() || reason.length > 1000) throw AppError.validation("Provide a reason of 1–1000 characters.");
  return ctx.db.transaction(async (tx) => {
    await requireAdministrator(ctx, tx);
    const target = (await tx.select().from(users).where(and(eq(users.id, userId), eq(users.organizationId, ctx.organizationId))).for("update"))[0];
    if (!target) throw AppError.notFound("Member not found in this team.");
    const actor = (await tx.select().from(users).where(and(eq(users.id, ctx.actorUserId), eq(users.organizationId, ctx.organizationId))))[0]!;
    if (effectiveTeamRole(ctx, target.email, target.role) !== "member" && effectiveTeamRole(ctx, actor.email, actor.role) !== "owner") {
      throw AppError.permissionDenied("Only a team owner can change an administrator's access.");
    }
    const now = ctx.clock.nowIso();
    if (!suspended) {
      await tx.update(memberSuspensions).set({ reinstatedAt: now }).where(and(eq(memberSuspensions.organizationId, ctx.organizationId), eq(memberSuspensions.userId, userId)));
      // Old sessions/devices/grants remain revoked. Reinstatement requires sign-in and fresh pairing.
      return { user_id: userId, suspended: false, revoked_device_ids: [] as string[] };
    }
    const row = { userId, organizationId: ctx.organizationId, suspendedByUserId: ctx.actorUserId, reason: reason.trim(), suspendedAt: now, reinstatedAt: null };
    await tx.insert(memberSuspensions).values(row).onConflictDoUpdate({ target: memberSuspensions.userId, set: row });
    const owned = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.organizationId, ctx.organizationId), eq(devices.enrolledByUserId, userId)));
    const ids = owned.map((device) => device.id);
    if (ids.length) {
      await tx.update(devices).set({ trust: "revoked", revokedAt: now }).where(inArray(devices.id, ids));
      await tx.update(deviceTokens).set({ status: "revoked", revokedAt: now }).where(and(eq(deviceTokens.organizationId, ctx.organizationId), inArray(deviceTokens.deviceId, ids)));
    }
    await tx.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.organizationId, ctx.organizationId), eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    await tx.update(pairingCodes).set({ status: "expired" }).where(and(eq(pairingCodes.organizationId, ctx.organizationId), eq(pairingCodes.createdByUserId, userId), eq(pairingCodes.status, "pending")));
    await tx.update(aiDataSharingConsents).set({ revokedAt: now }).where(and(eq(aiDataSharingConsents.organizationId, ctx.organizationId), eq(aiDataSharingConsents.userId, userId), isNull(aiDataSharingConsents.revokedAt)));
    // Caller closes these live sockets after commit. This is not a process-stop acknowledgement.
    return { user_id: userId, suspended: true, revoked_device_ids: ids };
  });
}
