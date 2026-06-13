import type { EventInput } from "@artoo/db";
import { EVENT_SCHEMA_VERSION, ID_PREFIXES } from "@artoo/domain";

import type { ServerContext } from "./context.js";

export interface EventSpec {
  type: string;
  actorType: "user" | "agent" | "system" | "bridge";
  actorId: string;
  correlationId: string;
  projectId?: string | null;
  taskId?: string | null;
  roomId?: string | null;
  runId?: string | null;
  /** Per-run sequence; distinct from the global event_log position. */
  sequence?: number | null;
  payload?: Record<string, unknown>;
}

/**
 * Build a db {@link EventInput} from a server-side spec. Centralises the
 * org/schema-version/id/clock wiring so every event is shaped consistently and
 * uses the injected IdGen/Clock (deterministic under test).
 */
export function buildEvent(ctx: ServerContext, spec: EventSpec): EventInput {
  return {
    id: ctx.idGen.generate(ID_PREFIXES.event),
    organizationId: ctx.organizationId,
    projectId: spec.projectId ?? null,
    type: spec.type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    actorType: spec.actorType,
    actorId: spec.actorId,
    taskId: spec.taskId ?? null,
    roomId: spec.roomId ?? null,
    runId: spec.runId ?? null,
    correlationId: spec.correlationId,
    sequence: spec.sequence ?? null,
    payload: spec.payload ?? {},
    occurredAt: ctx.clock.nowIso(),
  };
}
