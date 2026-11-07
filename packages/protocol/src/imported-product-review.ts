import { z } from "zod";
import { ImportedProductReviewControlV1Schema, ImportedProductReviewRequestV1Schema, ImportedProductReviewResultV1Schema } from "@artoo/domain";

const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
export const importedProductReviewCommandSchema = z.object({ ...command, type: z.literal("product.source.review.v1"), payload: ImportedProductReviewRequestV1Schema }).strict();
export const importedProductReviewStopSchema = z.object({ ...command, type: z.literal("product.source.review.stop.v1"), payload: ImportedProductReviewControlV1Schema }).strict();
export const importedProductReviewStatusSchema = z.object({ ...command, type: z.literal("product.source.review.status.v1"), payload: ImportedProductReviewControlV1Schema }).strict();
export const importedProductReviewReceiptSchema = z.object({ ...command, type: z.literal("product.source.review.receipt.v1"), payload: ImportedProductReviewControlV1Schema,
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), status: z.enum(["accepted", "rejected"]) }).strict();
export const importedProductReviewAckSchema = z.object({ kind: z.literal("product.source.review.ack.v1"), node_id: z.string().min(1), command_id: z.string().min(1),
  payload: ImportedProductReviewControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const importedProductReviewResultSchema = z.object({ kind: z.literal("product.source.review.result.v1"), node_id: z.string().min(1), command_id: z.string().min(1), payload: ImportedProductReviewResultV1Schema }).strict();
export type ImportedProductReviewCommand = z.infer<typeof importedProductReviewCommandSchema>;
export type ImportedProductReviewStop = z.infer<typeof importedProductReviewStopSchema>;
export type ImportedProductReviewStatus = z.infer<typeof importedProductReviewStatusSchema>;
export type ImportedProductReviewReceipt = z.infer<typeof importedProductReviewReceiptSchema>;
export type ImportedProductReviewAck = z.infer<typeof importedProductReviewAckSchema>;
export type ImportedProductReviewResult = z.infer<typeof importedProductReviewResultSchema>;
