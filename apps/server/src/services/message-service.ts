import { appendEvent, messages, rooms } from "@artoo/db";
import { ID_PREFIXES, type Message, type SendMessageRequest } from "@artoo/domain";
import { and, asc, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapMessage } from "../mappers.js";

async function requireRoom(
  ctx: ServerContext,
  tx: ServerContext["db"]["db"],
  roomId: string,
): Promise<typeof rooms.$inferSelect> {
  const room = (
    await tx
      .select()
      .from(rooms)
      .where(and(eq(rooms.id, roomId), eq(rooms.organizationId, ctx.organizationId)))
  )[0];
  if (room === undefined) {
    throw AppError.notFound(`room not found: ${roomId}`, { room_id: roomId });
  }
  return room;
}

/** GET /api/v1/rooms/:id/messages — chronological message list for a room. */
export async function listMessages(ctx: ServerContext, roomId: string): Promise<Message[]> {
  await requireRoom(ctx, ctx.db.db, roomId);
  const rows = await ctx.db.db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  return rows.map(mapMessage);
}

/** POST /api/v1/rooms/:id/messages — post a user message; emits message.created. */
export async function postMessage(
  ctx: ServerContext,
  roomId: string,
  req: SendMessageRequest,
): Promise<Message> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const room = await requireRoom(ctx, tx, roomId);
    const messageId = ctx.idGen.generate(ID_PREFIXES.message);
    await tx.insert(messages).values({
      id: messageId,
      organizationId: ctx.organizationId,
      roomId,
      taskId: room.taskId,
      actorType: "user",
      actorId: ctx.actorUserId,
      kind: req.kind,
      body: req.body,
      payload: req.payload,
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
        payload: { message_id: messageId, kind: req.kind },
      }),
    );
    const row = (await tx.select().from(messages).where(eq(messages.id, messageId)))[0];
    if (row === undefined) {
      throw new Error("postMessage: message missing after insert");
    }
    return mapMessage(row);
  });
}
