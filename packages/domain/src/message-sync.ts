import { z } from "zod";

/** Older servers accept 100 identifiers; larger batches require explicit negotiation. */
export const LEGACY_MESSAGE_VISIBILITY_BATCH_LIMIT = 100;
export const MAX_MESSAGE_VISIBILITY_BATCH_LIMIT = 500;
export const MessageSyncCapabilitiesV1Schema = z.object({
  version: z.literal(1),
  visibility_batch_limit: z.number().int().min(1).max(MAX_MESSAGE_VISIBILITY_BATCH_LIMIT),
});
export type MessageSyncCapabilitiesV1 = z.infer<typeof MessageSyncCapabilitiesV1Schema>;

export function messageVisibilityBatchLimit(capabilities: unknown): number {
  const parsed = MessageSyncCapabilitiesV1Schema.safeParse(capabilities);
  return parsed.success ? parsed.data.visibility_batch_limit : LEGACY_MESSAGE_VISIBILITY_BATCH_LIMIT;
}
