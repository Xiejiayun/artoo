import { requireContentAllowed } from "./content-moderation-service.js";
import { createHash } from "node:crypto";
import { appendEvent, messages, notifications, rooms, users } from "@artoo/db";
import { ID_PREFIXES, type Message, type Room, type SendMessageRequest } from "@artoo/domain";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapMessage, mapRoom } from "../mappers.js";
import { withHistoricalDiscussionPreviews } from "./discussion-plan.js";

async function requireRoom(
  ctx: ServerContext,
  tx: ServerContext["db"]["db"],
  roomId: string,
  lock = false,
): Promise<typeof rooms.$inferSelect> {
  const query = tx
      .select()
      .from(rooms)
      .where(and(eq(rooms.id, roomId), eq(rooms.organizationId, ctx.organizationId)));
  const room = (await (lock ? query.for("update") : query))[0];
  if (room === undefined) {
    throw AppError.notFound(`room not found: ${roomId}`, { room_id: roomId });
  }
  return room;
}

/** Authoritative room context for deep links, with the same scope as messages. */
export async function getRoom(ctx: ServerContext, roomId: string): Promise<Room> {
  return mapRoom(await requireRoom(ctx, ctx.db.db, roomId));
}

/** GET /api/v1/rooms/:id/messages — chronological message list for a room. */
export async function listMessages(ctx: ServerContext, roomId: string): Promise<Message[]> {
  await requireRoom(ctx, ctx.db.db, roomId);
  const rows = await ctx.db.db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  return withHistoricalDiscussionPreviews(ctx, rows.map(mapMessage));
}

export interface MessagePage {
  messages: Message[];
  next_before: string | null;
  next_after: string | null;
  has_more: boolean;
}

function messageCursor(roomId: string, position: number, threadRootId?: string): string {
  return Buffer.from(JSON.stringify(threadRootId ? [roomId, position, threadRootId] : [roomId, position])).toString("base64url");
}

function readMessageCursor(value: unknown, roomId: string, threadRootId?: string): number | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== (threadRootId ? 3 : 2) || parsed[0] !== roomId || parsed[2] !== threadRootId || !Number.isSafeInteger(parsed[1]) || parsed[1] < 1) throw new Error();
    return parsed[1] as number;
  } catch { throw AppError.validation("Invalid message cursor for this room"); }
}

/** Bounded history and delta pages; monotonic DB positions survive clock skew. */
export async function listMessagePage(ctx: ServerContext, roomId: string, query: { limit?: unknown; before?: unknown; after?: unknown; thread_root_id?: unknown } = {}): Promise<MessagePage> {
  await requireRoom(ctx, ctx.db.db, roomId);
  const threadRootId = query.thread_root_id;
  if (threadRootId !== undefined && (typeof threadRootId !== "string" || !threadRootId)) throw AppError.validation("thread_root_id must identify a root message");
  if (threadRootId) {
    const root = await getMessage(ctx, roomId, threadRootId);
    if (root.thread_root_id) throw AppError.validation("A thread must start from a root message");
  }
  const rawLimit = query.limit ?? 50;
  const limit = typeof rawLimit === "string" && /^\d+$/.test(rawLimit) ? Number(rawLimit) : rawLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw AppError.validation("Message limit must be an integer from 1 to 100");
  if (query.before !== undefined && query.after !== undefined) throw AppError.validation("Use before or after, not both");
  const before = readMessageCursor(query.before, roomId, threadRootId);
  const after = readMessageCursor(query.after, roomId, threadRootId);
  const forward = after !== undefined;
  const rows = await ctx.db.db.select().from(messages).where(and(
    eq(messages.organizationId, ctx.organizationId), eq(messages.roomId, roomId),
    threadRootId ? eq(messages.threadRootId, threadRootId) : isNull(messages.threadRootId),
    before === undefined ? undefined : lt(messages.position, before),
    after === undefined ? undefined : gt(messages.position, after),
  )).orderBy(forward ? asc(messages.position) : desc(messages.position)).limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (!forward) page.reverse();
  return {
    messages: await withHistoricalDiscussionPreviews(ctx, page.map(mapMessage)),
    next_before: page.length ? messageCursor(roomId, page[0]!.position, threadRootId) : null,
    next_after: page.length ? messageCursor(roomId, page[page.length - 1]!.position, threadRootId) : null,
    has_more: hasMore,
  };
}

/** Resolve a deep-linked message without downloading all room history. */
export async function getMessage(ctx: ServerContext, roomId: string, messageId: string): Promise<Message> {
  await requireRoom(ctx, ctx.db.db, roomId);
  const [row] = await ctx.db.db.select().from(messages).where(and(eq(messages.id, messageId), eq(messages.roomId, roomId), eq(messages.organizationId, ctx.organizationId)));
  if (!row) throw AppError.notFound("message not found");
  return (await withHistoricalDiscussionPreviews(ctx, [mapMessage(row)]))[0]!;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** POST /api/v1/rooms/:id/messages — post a user message; emits message.created. */
export async function postMessage(
  ctx: ServerContext,
  roomId: string,
  req: SendMessageRequest,
): Promise<Message> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const room = await requireRoom(ctx, tx, roomId, true);
    const requestHash = createHash("sha256").update(JSON.stringify(canonical(req))).digest("hex");
    if (req.client_request_id) {
      const [existing] = await tx.select().from(messages).where(and(eq(messages.organizationId, ctx.organizationId), eq(messages.roomId, roomId), eq(messages.actorType, "user"), eq(messages.actorId, ctx.actorUserId), eq(messages.clientRequestId, req.client_request_id)));
      if (existing) {
        if (existing.clientRequestHash !== requestHash) throw AppError.conflict("client_request_id was already used for a different message");
        return mapMessage(existing);
      }
    }
    if (!req.body.trim() || req.body.length > 20000) throw AppError.validation("Message body must contain between 1 and 20000 characters");
    if (Object.hasOwn(req.payload, "moderation")) throw AppError.validation("Moderation status is managed by the server.");
    await requireContentAllowed(ctx, req.body, tx);
    let rootReplyCount: number | undefined;
    if (req.thread_root_id) {
      const [root] = await tx.select().from(messages).where(and(eq(messages.id, req.thread_root_id), eq(messages.roomId, roomId), eq(messages.organizationId, ctx.organizationId)));
      if (!root) throw AppError.notFound("Thread root message not found in this room");
      if (root.threadRootId) throw AppError.validation("A thread must start from a root message");
      const [updated] = await tx.update(messages).set({ replyCount: sql`${messages.replyCount} + 1` }).where(eq(messages.id, root.id)).returning({ replyCount: messages.replyCount });
      rootReplyCount = updated!.replyCount;
    }
    const mentionedUsers = [...new Set([...req.mentions.filter((ref) => ref.actor_type === "user").map((ref) => ref.actor_id), ...req.assignments.filter((ref) => ref.assignee_type === "user").map((ref) => ref.assignee_id)])];
    if (mentionedUsers.length) {
      const found = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, ctx.organizationId), inArray(users.id, mentionedUsers)));
      if (found.length !== mentionedUsers.length) throw AppError.validation("Mentioned people must be members of this organization");
    }
    const messageId = ctx.idGen.generate(ID_PREFIXES.message);
    // Fold structured mentions/assignments into the stored payload (only when
    // present) so they persist + render alongside the message body.
    const hasRefs = req.mentions.length > 0 || req.assignments.length > 0;
    const payload = hasRefs
      ? { ...req.payload, mentions: req.mentions, assignments: req.assignments }
      : req.payload;
    await tx.insert(messages).values({
      id: messageId,
      organizationId: ctx.organizationId,
      roomId,
      taskId: room.taskId,
      threadRootId: req.thread_root_id,
      clientRequestId: req.client_request_id,
      clientRequestHash: req.client_request_id ? requestHash : null,
      actorType: "user",
      actorId: ctx.actorUserId,
      kind: req.kind,
      body: req.body,
      payload,
      createdAt: now,
    });
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "message.created",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: room.taskId ?? roomId,
        projectId: room.projectId,
        taskId: room.taskId,
        roomId,
        payload: { message_id: messageId, kind: req.kind, ...(req.thread_root_id ? { thread_root_id: req.thread_root_id, root_reply_count: rootReplyCount } : {}) },
      }),
    );
    // Metadata-only notification edge: who was @mentioned / assigned an action.
    // Carries only actor refs + the message id — never the message body.
    if (hasRefs) {
      for (const userId of mentionedUsers) {
        await tx.insert(notifications).values({ id: ctx.idGen.generate("notification"), organizationId: ctx.organizationId, userId, roomId, messageId, threadRootId: req.thread_root_id, actorId: ctx.actorUserId, bodyPreview: req.body.slice(0, 240), createdAt: now });
      }
      await appendEvent(
        tx,
        buildEvent(ctx, {
          type: "message.mention",
          actorType: "user",
          actorId: ctx.actorUserId,
          correlationId: room.taskId ?? roomId,
          projectId: room.projectId,
          taskId: room.taskId,
          roomId,
          payload: { message_id: messageId, mentions: req.mentions, assignments: req.assignments },
        }),
      );
    }
    const row = (await tx.select().from(messages).where(eq(messages.id, messageId)))[0];
    if (row === undefined) {
      throw new Error("postMessage: message missing after insert");
    }
    return mapMessage(row);
  });
}
