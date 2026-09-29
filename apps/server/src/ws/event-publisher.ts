import { eventLog, users } from "@artoo/db";
import { EVENT_SCHEMA_VERSION, ID_PREFIXES, type ActorType, type EventEnvelope } from "@artoo/domain";
import { and, asc, desc, eq, gt } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import type { WsHub } from "./ws-hub.js";

const INBOX_EVENT_TYPES = new Set(["run.failed", "review.completed", "task.assigned"]);
const EVENT_BATCH_LIMIT = 500;
const broadcastInboxEvent = (type: string): boolean => INBOX_EVENT_TYPES.has(type) || ["approval.", "computer.", "daemon.", "agent.", "agent_instance.", "device."].some((prefix) => type.startsWith(prefix));

function mentionRecipients(event: EventEnvelope): string[] {
  const ids = new Set<string>();
  for (const ref of Array.isArray(event.payload.mentions) ? event.payload.mentions : []) {
    if (ref && ref.actor_type === "user" && typeof ref.actor_id === "string") ids.add(ref.actor_id);
  }
  for (const ref of Array.isArray(event.payload.assignments) ? event.payload.assignments : []) {
    if (ref && ref.assignee_type === "user" && typeof ref.assignee_id === "string") ids.add(ref.assignee_id);
  }
  return [...ids];
}

/** Topics an event is published to: by entity id, plus inbox for the owner. */
export function topicsForEvent(event: EventEnvelope, ownerId: string): string[] {
  if (event.type.startsWith("notification.")) return event.payload.user_id === ownerId ? [`inbox:${ownerId}`] : [];
  const topics: string[] = [];
  if (event.task_id != null) {
    topics.push(`task:${event.task_id}`);
  }
  if (event.room_id != null) {
    topics.push(`room:${event.room_id}`);
  }
  if (event.run_id != null) {
    topics.push(`run:${event.run_id}`);
  }
  if (event.project_id != null) {
    topics.push(`project:${event.project_id}`);
  }
  if (broadcastInboxEvent(event.type)) {
    topics.push(`inbox:${ownerId}`);
  }
  if (event.type === "message.mention" && mentionRecipients(event).includes(ownerId)) topics.push(`inbox:${ownerId}`);
  return topics;
}

type EventRow = typeof eventLog.$inferSelect;

/**
 * A realtime push frame (#27 v2-B). `cursor` is the event's monotonic
 * `event_log.position` — the sync log of record. Clients track the highest
 * cursor seen and reconnect with `since_cursor` to catch up exactly.
 */
export interface EventFrame {
  type: "event";
  topic: string;
  event: EventEnvelope;
  cursor: number;
}

/**
 * Replay frames for events after `sinceCursor` that match any of `subscribedTopics`
 * (#27 WS recovery / catch-up). Returns frames in ascending cursor order; the
 * `position > sinceCursor` filter guarantees nothing already acked is replayed.
 */
export async function collectCatchUp(
  ctx: ServerContext,
  sinceCursor: number,
  subscribedTopics: readonly string[],
): Promise<EventFrame[]> {
  const wanted = new Set(subscribedTopics);
  if (wanted.size === 0) {
    return [];
  }
  const rows = await ctx.db.db
    .select()
    .from(eventLog)
    .where(and(eq(eventLog.organizationId, ctx.organizationId), gt(eventLog.position, sinceCursor)))
    .orderBy(asc(eventLog.position)).limit(EVENT_BATCH_LIMIT + 1);
  const frames: EventFrame[] = [];
  for (const row of rows.slice(0, EVENT_BATCH_LIMIT) as EventRow[]) {
    const envelope = toEnvelope(row);
    for (const topic of topicsForEvent(envelope, ctx.actorUserId)) {
      if (wanted.has(topic)) {
        frames.push({ type: "event", topic, event: envelope, cursor: row.position });
      }
    }
  }
  if (rows.length > EVENT_BATCH_LIMIT) {
    const row = rows[EVENT_BATCH_LIMIT]!;
    // The overflow row may belong to another person's inbox. A resync marker
    // must not inherit its identifiers, actor, or correlation metadata.
    const id = ctx.idGen.generate(ID_PREFIXES.event);
    frames.push({ type: "event", topic: subscribedTopics[0]!, cursor: row.position, event: {
      id, type: "sync.required", schema_version: EVENT_SCHEMA_VERSION,
      organization_id: ctx.organizationId, actor: { type: "system", id: "artoo" },
      occurred_at: ctx.clock.nowIso(), correlation_id: id,
      payload: { reason: "catch_up_limit", snapshot_required: true },
    } });
  }
  return frames;
}

/** Reconstruct the domain EventEnvelope from a stored event_log row. */
export function toEnvelope(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    type: row.type,
    schema_version: row.schemaVersion,
    organization_id: row.organizationId,
    project_id: row.projectId ?? undefined,
    task_id: row.taskId ?? undefined,
    room_id: row.roomId ?? undefined,
    run_id: row.runId ?? undefined,
    actor: { type: row.actorType as ActorType, id: row.actorId },
    occurred_at: row.occurredAt,
    correlation_id: row.correlationId,
    idempotency_key: row.idempotencyKey ?? undefined,
    sequence: row.sequence ?? undefined,
    payload: row.payload as Record<string, unknown>,
  };
}

export interface EventPublisher {
  /** Publish all events appended since the last cursor (one drain). */
  pumpOnce(): Promise<void>;
  /** Begin polling; skips pre-existing history (cursor jumps to current max). */
  start(intervalMs?: number): Promise<void>;
  stop(): void;
}

/**
 * Bridges committed events to the realtime hub by tailing event_log on its
 * monotonic `position`. Decoupled from the write path (no service changes); the
 * client gets invalidate-and-refetch semantics, so a small poll latency is fine.
 */
export function createEventPublisher(ctx: ServerContext, hub: WsHub): EventPublisher {
  let cursor = 0;
  let inFlight: Promise<void> | undefined;

  async function drainBatch(): Promise<void> {
    const rows = await ctx.db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, ctx.organizationId), gt(eventLog.position, cursor)))
      .orderBy(asc(eventLog.position)).limit(EVENT_BATCH_LIMIT);
    const members = !rows.some((row) => broadcastInboxEvent(row.type)) ? [] : await ctx.db.db.select({ id: users.id }).from(users)
      .where(eq(users.organizationId, ctx.organizationId));
    for (const row of rows as EventRow[]) {
      if (row.position > cursor) {
        cursor = row.position;
      }
      const envelope = toEnvelope(row);
      const topics = new Set(topicsForEvent(envelope, ctx.actorUserId).filter((topic) => !topic.startsWith("inbox:")));
      if (envelope.type === "message.mention") for (const recipient of mentionRecipients(envelope)) topics.add(`inbox:${recipient}`);
      if (envelope.type.startsWith("notification.") && typeof envelope.payload.user_id === "string") topics.add(`inbox:${envelope.payload.user_id}`);
      for (const member of members) {
        for (const topic of topicsForEvent(envelope, member.id)) topics.add(topic);
      }
      for (const topic of topics) {
        hub.publish(topic, { type: "event", topic, event: envelope, cursor: row.position });
      }
    }
  }

  function pumpOnce(): Promise<void> {
    inFlight ??= drainBatch().finally(() => { inFlight = undefined; });
    return inFlight;
  }

  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    pumpOnce,
    async start(intervalMs = 200): Promise<void> {
      const latest = await ctx.db.db
        .select({ position: eventLog.position })
        .from(eventLog)
        .where(eq(eventLog.organizationId, ctx.organizationId))
        .orderBy(desc(eventLog.position))
        .limit(1);
      cursor = (latest[0] as { position: number } | undefined)?.position ?? 0;
      timer = setInterval(() => {
        void pumpOnce().catch(() => { /* Retry the same cursor on the next tick. */ });
      }, intervalMs);
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
