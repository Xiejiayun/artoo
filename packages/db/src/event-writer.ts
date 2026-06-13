import type { DrizzleDb } from "@artoo/storage";

import { eventLog } from "./schema.js";

/**
 * Input to append an event. The server maps a domain Event envelope onto this
 * row shape, keeping packages/db free of domain semantics. `position` is NOT in
 * the input — it is DB-assigned (bigserial) so global order cannot be forged.
 */
export interface EventInput {
  id: string;
  organizationId: string;
  projectId?: string | null;
  type: string;
  schemaVersion: string;
  actorType: string;
  actorId: string;
  taskId?: string | null;
  roomId?: string | null;
  runId?: string | null;
  correlationId: string;
  idempotencyKey?: string | null;
  /** Per-run sequence (resets per run); distinct from the global `position`. */
  sequence?: number | null;
  payload?: Record<string, unknown>;
  occurredAt: string;
}

export interface EventRow {
  id: string;
  position: number;
  type: string;
  occurredAt: string;
}

/**
 * Append one event WITHIN the caller's transaction (never opens its own — review
 * gate: task+room+event must commit atomically). The global monotonic `position`
 * is assigned by the DB sequence, so it can be relied on for total event order.
 */
export async function appendEvent(tx: DrizzleDb, input: EventInput): Promise<EventRow> {
  const rows = await tx
    .insert(eventLog)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      type: input.type,
      schemaVersion: input.schemaVersion,
      actorType: input.actorType,
      actorId: input.actorId,
      taskId: input.taskId ?? null,
      roomId: input.roomId ?? null,
      runId: input.runId ?? null,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey ?? null,
      sequence: input.sequence ?? null,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt,
    })
    .returning({
      id: eventLog.id,
      position: eventLog.position,
      type: eventLog.type,
      occurredAt: eventLog.occurredAt,
    });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("appendEvent: insert returned no row");
  }
  return row;
}
