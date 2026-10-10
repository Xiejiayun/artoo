import { appendEvent, contentReports, contentRules, discussions, messages, notifications, organizations, rooms, users } from "@artoo/db";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { requireAdministrator } from "../auth/request-auth.js";
import { contentRulesVersion, isContentBlocked, parseBlockedPhrases, REMOVED_MESSAGE } from "../config/content-rules.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { requireActiveMember } from "./member-status.js";

export { REMOVED_MESSAGE } from "../config/content-rules.js";
async function rules(ctx: ServerContext, db: DrizzleDb = ctx.db.db) {
  const row = (await db.select().from(contentRules).where(eq(contentRules.organizationId, ctx.organizationId)))[0];
  const phrases = row ? parseBlockedPhrases(row.blockedPhrases) : [];
  return { blocked_phrases: phrases, version: contentRulesVersion(phrases), updated_at: row?.updatedAt ?? null };
}
export async function getContentRules(ctx: ServerContext) { await requireAdministrator(ctx); return rules(ctx); }
export async function setContentRules(ctx: ServerContext, phrases: unknown, expectedVersion: unknown) {
  const parsed = parseBlockedPhrases(phrases);
  return ctx.db.transaction(async (tx) => {
    await requireAdministrator(ctx, tx);
    await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, ctx.organizationId)).for("update");
    if ((await rules(ctx, tx)).version !== expectedVersion) throw AppError.conflict("The content rules changed. Reload them before saving.");
    const row = { organizationId: ctx.organizationId, blockedPhrases: parsed, updatedByUserId: ctx.actorUserId, updatedAt: ctx.clock.nowIso() };
    await tx.insert(contentRules).values(row).onConflictDoUpdate({ target: contentRules.organizationId, set: row });
    return rules(ctx, tx);
  });
}
export async function requireContentAllowed(ctx: ServerContext, body: string, db: DrizzleDb = ctx.db.db): Promise<void> {
  await requireActiveMember(ctx, ctx.actorUserId, db);
  if (isContentBlocked(body, (await rules(ctx, db)).blocked_phrases)) {
    throw AppError.permissionDenied("This content conflicts with your team's posting rules. Edit it or contact a team administrator.");
  }
}
function boundedReason(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1000) throw AppError.validation(`${label} must contain 1–1000 characters.`);
  return value.trim();
}
function reporterView(row: typeof contentReports.$inferSelect) {
  // A reporter never receives staff-only evidence or resolution notes.
  return { id: row.id, message_id: row.messageId, reason: row.reason, status: row.status, created_at: row.createdAt, resolved_at: row.resolvedAt };
}
export async function reportMessage(ctx: ServerContext, messageId: string, reason: unknown) {
  const text = boundedReason(reason, "Report reason");
  return ctx.db.transaction(async (tx) => {
    await requireActiveMember(ctx, ctx.actorUserId, tx);
    const message = (await tx.select().from(messages).where(and(eq(messages.id, messageId), eq(messages.organizationId, ctx.organizationId))).for("share"))[0];
    if (!message) throw AppError.notFound("The message is not available in this team.");
    const existing = (await tx.select().from(contentReports).where(and(eq(contentReports.organizationId, ctx.organizationId),
      eq(contentReports.messageId, messageId), eq(contentReports.reporterUserId, ctx.actorUserId))))[0];
    if (existing) return reporterView(existing);
    const row = { id: ctx.idGen.generate("report"), organizationId: ctx.organizationId, messageId,
      reporterUserId: ctx.actorUserId, reason: text, bodySnapshot: message.body, createdAt: ctx.clock.nowIso(), status: "open" };
    await tx.insert(contentReports).values(row).onConflictDoNothing();
    const saved = (await tx.select().from(contentReports).where(and(eq(contentReports.organizationId, ctx.organizationId),
      eq(contentReports.messageId, messageId), eq(contentReports.reporterUserId, ctx.actorUserId))))[0]!;
    return reporterView(saved);
  });
}
function reportCursor(before: unknown): string | undefined {
  if (before === undefined) return undefined;
  if (typeof before !== "string" || before.length > 100 || !/^report_[A-Za-z0-9]+$/.test(before)) throw AppError.validation("Invalid report cursor.");
  return before;
}
export async function listMyContentReports(ctx: ServerContext, before?: string) {
  await requireActiveMember(ctx);
  const cursor = reportCursor(before);
  const rows = await ctx.db.db.select().from(contentReports).where(and(eq(contentReports.organizationId, ctx.organizationId),
    eq(contentReports.reporterUserId, ctx.actorUserId), cursor ? lt(contentReports.id, cursor) : undefined)).orderBy(desc(contentReports.id)).limit(51);
  const page = rows.slice(0, 50);
  return { reports: page.map(reporterView), next_before: rows.length > 50 ? page.at(-1)!.id : null };
}
function staffView(row: typeof contentReports.$inferSelect) {
  return { ...reporterView(row), reporter_user_id: row.reporterUserId, body_snapshot: row.bodySnapshot,
    reviewed_by_user_id: row.reviewedByUserId, resolution_note: row.resolutionNote };
}
export async function listContentReports(ctx: ServerContext, before?: string) {
  await requireAdministrator(ctx);
  const cursor = reportCursor(before);
  const rows = await ctx.db.db.select({ report: contentReports, actorId: messages.actorId, actorType: messages.actorType,
    roomId: messages.roomId, actorName: users.displayName, actorEmail: users.email }).from(contentReports)
    .innerJoin(messages, and(eq(messages.id, contentReports.messageId), eq(messages.organizationId, ctx.organizationId)))
    .leftJoin(users, and(eq(users.id, messages.actorId), eq(messages.actorType, "user"), eq(users.organizationId, ctx.organizationId)))
    .where(and(eq(contentReports.organizationId, ctx.organizationId), cursor ? lt(contentReports.id, cursor) : undefined))
    .orderBy(desc(contentReports.id)).limit(51);
  const page = rows.slice(0, 50);
  return { reports: page.map((row) => ({ ...staffView(row.report), actor_id: row.actorId, actor_type: row.actorType,
    room_id: row.roomId, actor_name: row.actorName, actor_email: row.actorEmail })), next_before: rows.length > 50 ? page.at(-1)!.report.id : null };
}
export async function resolveContentReport(ctx: ServerContext, id: string, action: unknown, note: unknown) {
  if (action !== "remove" && action !== "dismiss") throw AppError.validation("Choose remove or dismiss.");
  const text = boundedReason(note, "Resolution note");
  return ctx.db.transaction(async (tx) => {
    await requireAdministrator(ctx, tx);
    const report = (await tx.select().from(contentReports).where(and(eq(contentReports.id, id), eq(contentReports.organizationId, ctx.organizationId))).for("update"))[0];
    if (!report) throw AppError.notFound("Report not found.");
    if (report.status !== "open") throw AppError.conflict("This report was already resolved. Reload the queue.");
    if (action === "remove") {
      const message = (await tx.select().from(messages).where(and(eq(messages.id, report.messageId), eq(messages.organizationId, ctx.organizationId))).for("update"))[0]!;
      const planning = (await tx.select({ id: discussions.id }).from(discussions).where(and(
        eq(discussions.organizationId, ctx.organizationId), eq(discussions.threadRootId, message.id),
      )).limit(1))[0];
      // Preserve only authoritative conversation structure, never copied content.
      await tx.update(messages).set({ body: REMOVED_MESSAGE, payload: planning ? { discussion_id: planning.id } : {}, moderatedAt: ctx.clock.nowIso(), moderatedByUserId: ctx.actorUserId }).where(eq(messages.id, message.id));
      await tx.update(notifications).set({ bodyPreview: REMOVED_MESSAGE }).where(and(eq(notifications.organizationId, ctx.organizationId), eq(notifications.messageId, message.id)));
      const room = (await tx.select().from(rooms).where(eq(rooms.id, message.roomId)))[0]!;
      await appendEvent(tx, buildEvent(ctx, { type: "message.moderated", actorType: "user", actorId: ctx.actorUserId,
        correlationId: report.id, projectId: room.projectId, roomId: message.roomId, taskId: message.taskId,
        payload: { message_id: message.id, ...(message.threadRootId ? { thread_root_id: message.threadRootId } : {}) } }));
    }
    const [updated] = await tx.update(contentReports).set({ status: action === "remove" ? "resolved" : "dismissed", resolutionNote: text,
      reviewedByUserId: ctx.actorUserId, resolvedAt: ctx.clock.nowIso() }).where(eq(contentReports.id, report.id)).returning();
    return staffView(updated!);
  });
}

/** Reconcile already-loaded history after missed realtime events, without resending message bodies. */
export async function messageVisibility(ctx: ServerContext, roomId: string, ids: unknown) {
  if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== "string" || !id || id.length > 160)) {
    throw AppError.validation("Select at most 100 message identifiers.");
  }
  const room = (await ctx.db.db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.id, roomId), eq(rooms.organizationId, ctx.organizationId))))[0];
  if (!room) throw AppError.notFound("Room not found in this team.");
  if (!ids.length) return { removed_message_ids: [] as string[] };
  const rows = await ctx.db.db.select({ id: messages.id, moderatedAt: messages.moderatedAt, moderatedByUserId: messages.moderatedByUserId }).from(messages).where(and(
    eq(messages.organizationId, ctx.organizationId), eq(messages.roomId, roomId), inArray(messages.id, ids as string[]),
  ));
  return { removed_message_ids: rows.filter((row) => row.moderatedAt !== null && row.moderatedByUserId !== null).map((row) => row.id) };
}
