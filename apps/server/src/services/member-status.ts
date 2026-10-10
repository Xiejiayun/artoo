import { memberSuspensions, users } from "@artoo/db";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, isNull } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

export async function isMemberSuspended(ctx: ServerContext, userId: string, db: DrizzleDb = ctx.db.db): Promise<boolean> {
  return (await db.select({ userId: memberSuspensions.userId }).from(memberSuspensions).where(and(
    eq(memberSuspensions.organizationId, ctx.organizationId), eq(memberSuspensions.userId, userId), isNull(memberSuspensions.reinstatedAt),
  )).limit(1)).length > 0;
}
export async function requireActiveMember(ctx: ServerContext, userId = ctx.actorUserId, db: DrizzleDb = ctx.db.db): Promise<void> {
  const exists = (await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.organizationId, ctx.organizationId))).limit(1).for("share")).length > 0;
  if (!exists || await isMemberSuspended(ctx, userId, db)) throw AppError.permissionDenied("This account does not have active access to the team.");
}
