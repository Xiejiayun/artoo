/**
 * Event envelope + core event/message vocabularies (design.md §3.5, §7.4;
 * codex Round 6).
 *
 * Forward-compatible: {@link parseEvent} validates the envelope shape but does
 * NOT reject unknown event `type`s, and {@link normalizeMessageKind} degrades
 * unknown message kinds — older consumers keep working instead of crashing.
 */
import { z } from "zod";

export const ActorTypeSchema = z.enum(["user", "agent", "system", "bridge"]);
export const ACTOR_TYPES = ActorTypeSchema.options;
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const ActorSchema = z.object({
  type: ActorTypeSchema,
  id: z.string().min(1),
});
export type Actor = z.infer<typeof ActorSchema>;

/** Bumped only via explicit migration; pinned to design.md event envelope. */
export const EVENT_SCHEMA_VERSION = "2026-06-11";

export const CoreEventTypeSchema = z.enum([
  "task.created",
  "room.created",
  "message.created",
  "task.updated",
  "task.assigned",
  "run.started",
  "run.output",
  "run.failed",
  "run.cancelled",
  "approval.requested",
  "approval.resolved",
  "artifact.created",
  "run.completed",
  "review.completed",
]);
export const CORE_EVENT_TYPES = CoreEventTypeSchema.options;
export type CoreEventType = z.infer<typeof CoreEventTypeSchema>;

export const EventEnvelopeSchema = z.object({
  id: z.string().min(1),
  // Free-form string (not the core enum) so unknown types validate; use
  // isCoreEventType / parseEvent to branch on known types.
  type: z.string().min(1),
  schema_version: z.string().min(1),
  organization_id: z.string().min(1),
  project_id: z.string().nullish(),
  task_id: z.string().nullish(),
  room_id: z.string().nullish(),
  run_id: z.string().nullish(),
  actor: ActorSchema,
  occurred_at: z.string().min(1),
  visibility: z.string().nullish(),
  correlation_id: z.string().min(1),
  idempotency_key: z.string().nullish(),
  sequence: z.number().int().nullish(),
  payload: z.record(z.unknown()).default({}),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export function isCoreEventType(value: string): value is CoreEventType {
  return (CORE_EVENT_TYPES as readonly string[]).includes(value);
}

export interface ParsedEvent {
  event: EventEnvelope;
  /** false when `type` falls outside the frozen core set (forward-compat). */
  known: boolean;
}

export type ParseEventResult =
  | { ok: true; value: ParsedEvent }
  | { ok: false; error: z.ZodError };

export function parseEvent(raw: unknown): ParseEventResult {
  const result = EventEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error };
  }
  return { ok: true, value: { event: result.data, known: isCoreEventType(result.data.type) } };
}

// ---------------------------------------------------------------------------
// Message kinds
// ---------------------------------------------------------------------------

export const MessageKindSchema = z.enum([
  "text",
  "task_update",
  "run_event",
  "agent_question",
  "agent_proposal",
  "approval_request",
  "approval_result",
  "artifact",
  "handoff",
  "review",
  "system_notice",
]);
export const MESSAGE_KINDS = MessageKindSchema.options;
export type MessageKind = z.infer<typeof MessageKindSchema>;

export function isKnownMessageKind(value: string): value is MessageKind {
  return (MESSAGE_KINDS as readonly string[]).includes(value);
}

/** Forward-compat: unknown kinds render as a low-interruption system notice. */
export function normalizeMessageKind(value: string): MessageKind {
  return isKnownMessageKind(value) ? value : "system_notice";
}
