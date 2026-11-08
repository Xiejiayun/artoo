import { z } from "zod";
import { ImportedDesignReviewControlV1Schema, ImportedDesignReviewRequestV1Schema, ImportedDesignReviewResultV1Schema } from "@artoo/domain";
const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
export const importedDesignReviewCommandSchema = z.object({ ...command, type: z.literal("product.source.design-review.v1"), payload: ImportedDesignReviewRequestV1Schema }).strict();
export const importedDesignReviewStopSchema = z.object({ ...command, type: z.literal("product.source.design-review.stop.v1"), payload: ImportedDesignReviewControlV1Schema }).strict();
export const importedDesignReviewStatusSchema = z.object({ ...command, type: z.literal("product.source.design-review.status.v1"), payload: ImportedDesignReviewControlV1Schema }).strict();
export const importedDesignReviewReceiptSchema = z.object({ ...command, type: z.literal("product.source.design-review.receipt.v1"), payload: ImportedDesignReviewControlV1Schema,
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), status: z.enum(["accepted", "rejected"]) }).strict();
export const importedDesignReviewAckSchema = z.object({ kind: z.literal("product.source.design-review.ack.v1"), node_id: z.string().min(1), command_id: z.string().min(1),
  payload: ImportedDesignReviewControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const importedDesignReviewResultSchema = z.object({ kind: z.literal("product.source.design-review.result.v1"), node_id: z.string().min(1), command_id: z.string().min(1), payload: ImportedDesignReviewResultV1Schema }).strict();
export type ImportedDesignReviewCommand = z.infer<typeof importedDesignReviewCommandSchema>;
export type ImportedDesignReviewStop = z.infer<typeof importedDesignReviewStopSchema>;
export type ImportedDesignReviewStatus = z.infer<typeof importedDesignReviewStatusSchema>;
export type ImportedDesignReviewReceipt = z.infer<typeof importedDesignReviewReceiptSchema>;
export type ImportedDesignReviewAck = z.infer<typeof importedDesignReviewAckSchema>;
export type ImportedDesignReviewResult = z.infer<typeof importedDesignReviewResultSchema>;
