import { z } from "zod";
import { ImportedValidationReviewControlV1Schema, ImportedValidationReviewRequestV1Schema, ImportedValidationReviewResultV1Schema } from "@artoo/domain";

const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
export const importedValidationReviewCommandSchema = z.object({ ...command, type: z.literal("product.source.validation-review.v1"), payload: ImportedValidationReviewRequestV1Schema }).strict();
export const importedValidationReviewStopSchema = z.object({ ...command, type: z.literal("product.source.validation-review.stop.v1"), payload: ImportedValidationReviewControlV1Schema }).strict();
export const importedValidationReviewStatusSchema = z.object({ ...command, type: z.literal("product.source.validation-review.status.v1"), payload: ImportedValidationReviewControlV1Schema }).strict();
export const importedValidationReviewReceiptSchema = z.object({ ...command, type: z.literal("product.source.validation-review.receipt.v1"), payload: ImportedValidationReviewControlV1Schema,
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), status: z.enum(["accepted", "rejected"]) }).strict();
export const importedValidationReviewAckSchema = z.object({ kind: z.literal("product.source.validation-review.ack.v1"), node_id: z.string().min(1), command_id: z.string().min(1),
  payload: ImportedValidationReviewControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const importedValidationReviewResultSchema = z.object({ kind: z.literal("product.source.validation-review.result.v1"), node_id: z.string().min(1), command_id: z.string().min(1), payload: ImportedValidationReviewResultV1Schema }).strict();
export type ImportedValidationReviewCommand = z.infer<typeof importedValidationReviewCommandSchema>;
export type ImportedValidationReviewStop = z.infer<typeof importedValidationReviewStopSchema>;
export type ImportedValidationReviewStatus = z.infer<typeof importedValidationReviewStatusSchema>;
export type ImportedValidationReviewReceipt = z.infer<typeof importedValidationReviewReceiptSchema>;
export type ImportedValidationReviewAck = z.infer<typeof importedValidationReviewAckSchema>;
export type ImportedValidationReviewResult = z.infer<typeof importedValidationReviewResultSchema>;
