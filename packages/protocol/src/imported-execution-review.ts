import { z } from "zod";
import { ImportedExecutionReviewControlV1Schema, ImportedExecutionReviewRequestV1Schema, ImportedExecutionReviewResultV1Schema } from "@artoo/domain";

const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
export const importedExecutionReviewCommandSchema = z.object({ ...command, type: z.literal("product.source.execution-review.v1"), payload: ImportedExecutionReviewRequestV1Schema }).strict();
export const importedExecutionReviewStopSchema = z.object({ ...command, type: z.literal("product.source.execution-review.stop.v1"), payload: ImportedExecutionReviewControlV1Schema }).strict();
export const importedExecutionReviewStatusSchema = z.object({ ...command, type: z.literal("product.source.execution-review.status.v1"), payload: ImportedExecutionReviewControlV1Schema }).strict();
export const importedExecutionReviewReceiptSchema = z.object({ ...command, type: z.literal("product.source.execution-review.receipt.v1"), payload: ImportedExecutionReviewControlV1Schema,
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), status: z.enum(["accepted", "rejected"]) }).strict();
export const importedExecutionReviewAckSchema = z.object({ kind: z.literal("product.source.execution-review.ack.v1"), node_id: z.string().min(1), command_id: z.string().min(1),
  payload: ImportedExecutionReviewControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const importedExecutionReviewResultSchema = z.object({ kind: z.literal("product.source.execution-review.result.v1"), node_id: z.string().min(1), command_id: z.string().min(1), payload: ImportedExecutionReviewResultV1Schema }).strict();
export type ImportedExecutionReviewCommand = z.infer<typeof importedExecutionReviewCommandSchema>;
export type ImportedExecutionReviewStop = z.infer<typeof importedExecutionReviewStopSchema>;
export type ImportedExecutionReviewStatus = z.infer<typeof importedExecutionReviewStatusSchema>;
export type ImportedExecutionReviewReceipt = z.infer<typeof importedExecutionReviewReceiptSchema>;
export type ImportedExecutionReviewAck = z.infer<typeof importedExecutionReviewAckSchema>;
export type ImportedExecutionReviewResult = z.infer<typeof importedExecutionReviewResultSchema>;
