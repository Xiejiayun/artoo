import { appendEvent, notifications, projects, rooms, users } from "@artoo/db";
import { ID_PREFIXES, type Channel, type CreateChannelRequest, type Member, type Notification, type NotificationPage } from "@artoo/domain";
import { and, asc, count, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";

const channel = (row: typeof rooms.$inferSelect): Channel => ({ id: row.id, project_id: row.projectId!, name: row.name, description: row.description, created_at: row.createdAt });
const notification = (row: typeof notifications.$inferSelect, room: typeof rooms.$inferSelect): Notification => ({
  id: row.id, room_id: row.roomId, message_id: row.messageId, thread_root_id: row.threadRootId,
  actor_id: row.actorId, body_preview: row.bodyPreview, read_at: row.readAt, created_at: row.createdAt,
  project_id: room.projectId, room_type: room.type, room_name: room.name,
  channel_id: room.type === "project" ? room.id : null, task_id: room.taskId, goal_id: room.goalId,
});

export async function listChannels(ctx: ServerContext, projectId: string): Promise<Channel[]> {
  const [project] = await ctx.db.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organizationId)));
  if (!project) throw AppError.notFound("project not found");
  return (await ctx.db.db.select().from(rooms).where(and(eq(rooms.organizationId, ctx.organizationId), eq(rooms.projectId, projectId), eq(rooms.type, "project"))).orderBy(asc(rooms.name))).map(channel);
}

export async function createChannel(ctx: ServerContext, input: CreateChannelRequest): Promise<Channel> {
  return ctx.db.transaction(async (tx) => {
    // Serialize channel-name creation within one project without changing legacy
    // project rooms or imposing a migration constraint on historical names.
    const [project] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.project_id), eq(projects.organizationId, ctx.organizationId))).for("update");
    if (!project) throw AppError.notFound("project not found");
    const [existing] = await tx.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.projectId, input.project_id), eq(rooms.type, "project"), sql`lower(${rooms.name}) = lower(${input.name})`));
    if (existing) throw AppError.conflict("A channel with this name already exists in the project");
    const [row] = await tx.insert(rooms).values({ id: ctx.idGen.generate(ID_PREFIXES.room), organizationId: ctx.organizationId, projectId: input.project_id, type: "project", name: input.name, description: input.description, createdAt: ctx.clock.nowIso() }).returning();
    await appendEvent(tx, buildEvent(ctx, { type: "channel.created", actorType: "user", actorId: ctx.actorUserId, correlationId: row!.id, projectId: input.project_id, roomId: row!.id, payload: { channel_id: row!.id } }));
    return channel(row!);
  });
}

export async function listMembers(ctx: ServerContext): Promise<Member[]> {
  return ctx.db.db.select({ id: users.id, display_name: users.displayName }).from(users).where(eq(users.organizationId, ctx.organizationId)).orderBy(asc(users.displayName), asc(users.id));
}

type NotificationBoundary = { createdAt: string; id: string };
const notificationScope = (ctx: ServerContext) => and(eq(notifications.organizationId, ctx.organizationId), eq(notifications.userId, ctx.actorUserId));
const notificationRoom = (ctx: ServerContext) => and(eq(rooms.id, notifications.roomId), eq(rooms.organizationId, ctx.organizationId));

function notificationCursor(ctx: ServerContext, row: NotificationBoundary): string {
  return Buffer.from(JSON.stringify([1, ctx.organizationId, ctx.actorUserId, row.createdAt, row.id])).toString("base64url");
}

function readNotificationCursor(ctx: ServerContext, value: unknown): NotificationBoundary | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 5 || parsed[0] !== 1 || parsed[1] !== ctx.organizationId || parsed[2] !== ctx.actorUserId) throw new Error();
    const [, , , createdAt, id] = parsed;
    // Preserve PostgreSQL microseconds in the boundary; converting to a JS Date
    // for storage would skip rows sharing a millisecond at a page boundary.
    if (typeof createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) throw new Error();
    const day = createdAt.slice(0, 10);
    const offset = /[+-](\d{2})(?::?\d{2})?$/.exec(createdAt);
    if (Number(day.slice(0, 4)) === 0 || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || (offset && Number(offset[1]) > 15)) throw new Error();
    if (typeof id !== "string" || id.length === 0 || id.length > 256 || id.includes("\0")) throw new Error();
    return { createdAt, id };
  } catch { throw AppError.validation("Invalid notification cursor for this recipient"); }
}

async function unreadCount(ctx: ServerContext, tx: ServerContext["db"]["db"]): Promise<number> {
  const [row] = await tx.select({ count: count() }).from(notifications).innerJoin(rooms, notificationRoom(ctx))
    .where(and(notificationScope(ctx), isNull(notifications.readAt)));
  return row?.count ?? 0;
}

export async function listNotifications(ctx: ServerContext, query: { limit?: unknown; before?: unknown } = {}): Promise<NotificationPage> {
  const rawLimit = query.limit ?? 50;
  const limit = typeof rawLimit === "string" && /^\d+$/.test(rawLimit) ? Number(rawLimit) : rawLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw AppError.validation("Notification limit must be an integer from 1 to 100");
  const before = readNotificationCursor(ctx, query.before);
  return ctx.db.transaction(async (tx) => {
    const rows = await tx.select({ item: notifications, room: rooms }).from(notifications).innerJoin(rooms, notificationRoom(ctx))
      .where(and(notificationScope(ctx), before ? or(lt(notifications.createdAt, before.createdAt), and(eq(notifications.createdAt, before.createdAt), lt(notifications.id, before.id))) : undefined))
      .orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { notifications: page.map(({ item, room }) => notification(item, room)),
      next_before: page.length ? notificationCursor(ctx, page[page.length - 1]!.item) : null,
      has_more: rows.length > limit, unread_count: await unreadCount(ctx, tx) };
  });
}

export async function markNotificationRead(ctx: ServerContext, id: string): Promise<{ notification: Notification; unread_count: number }> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.update(notifications).set({ readAt: sql`coalesce(${notifications.readAt}, ${ctx.clock.nowIso()}::timestamptz)` }).where(and(eq(notifications.id, id), eq(notifications.organizationId, ctx.organizationId), eq(notifications.userId, ctx.actorUserId))).returning();
    if (!row) throw AppError.notFound("notification not found");
    const [room] = await tx.select().from(rooms).where(and(eq(rooms.id, row.roomId), eq(rooms.organizationId, ctx.organizationId)));
    if (!room) throw AppError.notFound("notification room not found");
    await appendEvent(tx, buildEvent(ctx, { type: "notification.read", actorType: "user", actorId: ctx.actorUserId, correlationId: id, payload: { notification_id: id, user_id: ctx.actorUserId } }));
    return { notification: notification(row, room), unread_count: await unreadCount(ctx, tx) };
  });
}
