import type { Message } from "@artoo/domain";

/** Display metadata only; never infer a coordinator instruction from its body. */
export function planningInstructionTitle(message: Message | undefined): string | null {
  if (!message) return null;
  const payload = message.payload;
  const step = payload.discussion_step;
  if (message.actor_type === "system" && message.actor_id === "discussion-coordinator" && message.kind === "text"
    && typeof message.thread_root_id === "string" && message.thread_root_id.trim().length > 0
    && payload.intent === "discussion"
    && typeof payload.discussion_id === "string" && payload.discussion_id.trim().length > 0
    && typeof payload.assistant_turn_id === "string" && payload.assistant_turn_id.trim().length > 0
    && typeof step === "number" && Number.isSafeInteger(step) && step >= 0 && step < Number.MAX_SAFE_INTEGER) {
    return `Planning instruction · Step ${step + 1}`;
  }
  return null;
}
