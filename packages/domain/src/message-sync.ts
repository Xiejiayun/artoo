import { z } from "zod";

/** Older servers accept 100 identifiers; larger batches require explicit negotiation. */
export const LEGACY_MESSAGE_VISIBILITY_BATCH_LIMIT = 100;
export const MAX_MESSAGE_VISIBILITY_BATCH_LIMIT = 500;
export const MessageSyncCapabilitiesV1Schema = z.object({
  version: z.literal(1),
  visibility_batch_limit: z.number().int().min(1).max(MAX_MESSAGE_VISIBILITY_BATCH_LIMIT),
  reconciliation_version: z.literal(1).optional(),
});
export type MessageSyncCapabilitiesV1 = z.infer<typeof MessageSyncCapabilitiesV1Schema>;

export function messageVisibilityBatchLimit(capabilities: unknown): number {
  const parsed = MessageSyncCapabilitiesV1Schema.safeParse(capabilities);
  return parsed.success ? parsed.data.visibility_batch_limit : LEGACY_MESSAGE_VISIBILITY_BATCH_LIMIT;
}

export function supportsMessageReconciliation(capabilities: unknown): boolean {
  const parsed = MessageSyncCapabilitiesV1Schema.safeParse(capabilities);
  return parsed.success && parsed.data.reconciliation_version === 1;
}

export const MessageReconciliationRequestV1Schema = z.object({
  version: z.literal(1),
  message_ids: z.array(z.string().min(1).max(160)).max(MAX_MESSAGE_VISIBILITY_BATCH_LIMIT),
}).strict();
export const MessageReconciliationV1Schema = z.object({
  version: z.literal(1),
  states: z.array(z.discriminatedUnion("status", [
    z.object({ id: z.string().min(1).max(160), status: z.literal("visible"), reply_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
    z.object({ id: z.string().min(1).max(160), status: z.literal("removed"), reply_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
    // Missing and out-of-scope IDs have the same representation; no metadata escapes.
    z.object({ id: z.string().min(1).max(160), status: z.literal("unavailable") }),
  ])).max(MAX_MESSAGE_VISIBILITY_BATCH_LIMIT),
});
export type MessageReconciliationV1 = z.infer<typeof MessageReconciliationV1Schema>;
