import { z } from "zod";
import { ImportedCleanValidationReviewControlV1Schema, ImportedCleanValidationReviewRequestV1Schema, ImportedCleanValidationReviewResultV1Schema } from "@artoo/domain";

const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
// Name the exact shape so declaration emit references the domain codec instead
// of serializing its complete nested request graph into this wire envelope.
type ImportedCleanValidationReviewCommandShape = typeof command & {
  type: z.ZodLiteral<"product.source.clean-validation-review.v1">;
  payload: typeof ImportedCleanValidationReviewRequestV1Schema;
};
export const importedCleanValidationReviewCommandSchema: z.ZodObject<ImportedCleanValidationReviewCommandShape, z.core.$strict> = z.object({ ...command, type: z.literal("product.source.clean-validation-review.v1"), payload: ImportedCleanValidationReviewRequestV1Schema }).strict();
export const importedCleanValidationReviewStopSchema = z.object({ ...command, type: z.literal("product.source.clean-validation-review.stop.v1"), payload: ImportedCleanValidationReviewControlV1Schema }).strict();
export const importedCleanValidationReviewStatusSchema = z.object({ ...command, type: z.literal("product.source.clean-validation-review.status.v1"), payload: ImportedCleanValidationReviewControlV1Schema }).strict();
export const importedCleanValidationReviewReceiptSchema = z.object({ ...command, type: z.literal("product.source.clean-validation-review.receipt.v1"), payload: ImportedCleanValidationReviewControlV1Schema,
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), status: z.enum(["accepted", "rejected"]) }).strict();
export const importedCleanValidationReviewAckSchema = z.object({ kind: z.literal("product.source.clean-validation-review.ack.v1"), node_id: z.string().min(1), command_id: z.string().min(1),
  payload: ImportedCleanValidationReviewControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const importedCleanValidationReviewResultSchema = z.object({ kind: z.literal("product.source.clean-validation-review.result.v1"), node_id: z.string().min(1), command_id: z.string().min(1), payload: ImportedCleanValidationReviewResultV1Schema }).strict();
export type ImportedCleanValidationReviewCommand = z.infer<typeof importedCleanValidationReviewCommandSchema>;
export type ImportedCleanValidationReviewStop = z.infer<typeof importedCleanValidationReviewStopSchema>;
export type ImportedCleanValidationReviewStatus = z.infer<typeof importedCleanValidationReviewStatusSchema>;
export type ImportedCleanValidationReviewReceipt = z.infer<typeof importedCleanValidationReviewReceiptSchema>;
export type ImportedCleanValidationReviewAck = z.infer<typeof importedCleanValidationReviewAckSchema>;
export type ImportedCleanValidationReviewResult = z.infer<typeof importedCleanValidationReviewResultSchema>;
