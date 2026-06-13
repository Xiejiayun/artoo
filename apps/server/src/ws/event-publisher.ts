import { eventLog } from "@artoo/db";
import type { ActorType, EventEnvelope } from "@artoo/domain";
import { asc, desc, gt } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import type { WsHub } from "./ws-hub.js";

const INBOX_EVENT_TYPES = new Set(["run.failed", "review.completed", "task.assigned"]);

/** Topics an event is published to: by entity id, plus inbox for the owner. */
export function topicsForEvent(event: EventEnvelope, ownerId: string): string[] {
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
  if (event.type.startsWith("approval.") || INBOX_EVENT_TYPES.has(event.type)) {
    topics.push(`inbox:${ownerId}`);
  }
  return topics;
}

type EventRow = typeof eventLog.$inferSelect;

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

  async function pumpOnce(): Promise<void> {
    const rows = await ctx.db.db
      .select()
      .from(eventLog)
      .where(gt(eventLog.position, cursor))
      .orderBy(asc(eventLog.position));
    for (const row of rows as EventRow[]) {
      if (row.position > cursor) {
        cursor = row.position;
      }
      const envelope = toEnvelope(row);
      for (const topic of topicsForEvent(envelope, ctx.actorUserId)) {
        hub.publish(topic, { type: "event", topic, event: envelope });
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    pumpOnce,
    async start(intervalMs = 200): Promise<void> {
      const latest = await ctx.db.db
        .select({ position: eventLog.position })
        .from(eventLog)
        .orderBy(desc(eventLog.position))
        .limit(1);
      cursor = (latest[0] as { position: number } | undefined)?.position ?? 0;
      timer = setInterval(() => {
        void pumpOnce();
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
