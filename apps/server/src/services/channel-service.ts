import { appendEvent, notifications, projects, rooms, users } from "@artoo/db";
import { ID_PREFIXES, type Channel, type CreateChannelRequest, type Member, type Notification } from "@artoo/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";

const channel = (row: typeof rooms.$inferSelect): Channel => ({ id: row.id, project_id: row.projectId!, name: row.name, description: row.description, created_at: row.createdAt });
const notification = (row: typeof notifications.$inferSelect): Notification => ({ id: row.id, room_id: row.roomId, message_id: row.messageId, thread_root_id: row.threadRootId, actor_id: row.actorId, body_preview: row.bodyPreview, read_at: row.readAt, created_at: row.createdAt });

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

export async function listNotifications(ctx: ServerContext): Promise<Notification[]> {
  return (await ctx.db.db.select().from(notifications).where(and(eq(notifications.organizationId, ctx.organizationId), eq(notifications.userId, ctx.actorUserId))).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(100)).map(notification);
}

export async function markNotificationRead(ctx: ServerContext, id: string): Promise<Notification> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.update(notifications).set({ readAt: sql`coalesce(${notifications.readAt}, ${ctx.clock.nowIso()}::timestamptz)` }).where(and(eq(notifications.id, id), eq(notifications.organizationId, ctx.organizationId), eq(notifications.userId, ctx.actorUserId))).returning();
    if (!row) throw AppError.notFound("notification not found");
    await appendEvent(tx, buildEvent(ctx, { type: "notification.read", actorType: "user", actorId: ctx.actorUserId, correlationId: id, payload: { notification_id: id, user_id: ctx.actorUserId } }));
    return notification(row);
  });
}
