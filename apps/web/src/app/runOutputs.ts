import type { EventEnvelope } from "@artoo/domain";

export interface RunOutputChunk { eventId: string; runId: string; text: string }
/** Recent live output is bounded per task; the audit bundle keeps durable evidence. */
export function appendRunOutput(previous: RunOutputChunk[] = [], event: EventEnvelope): RunOutputChunk[] {
  if (!event.run_id || typeof event.payload["text"] !== "string" || previous.some((chunk) => chunk.eventId === event.id)) return previous;
  const chunks = [...previous, { eventId: event.id, runId: event.run_id, text: event.payload["text"].slice(-250000) }].slice(-1000);
  let size = 0;
  let start = chunks.length - 1;
  for (; start >= 0; start--) {
    size += chunks[start]!.text.length;
    if (size > 250000) break;
  }
  return chunks.slice(start + 1);
}
