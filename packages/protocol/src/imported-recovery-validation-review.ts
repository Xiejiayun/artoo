import { z } from "zod";
import { ImportedRecoveryValidationReviewControlV1Schema, ImportedRecoveryValidationReviewRequestV1Schema, ImportedRecoveryValidationReviewResultV1Schema } from "@artoo/domain";

const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
export const importedRecoveryValidationReviewCommandSchema = z.object({ ...command, type: z.literal("product.source.recovery-validation-review.v1"), payload: ImportedRecoveryValidationReviewRequestV1Schema }).strict();
export const importedRecoveryValidationReviewStopSchema = z.object({ ...command, type: z.literal("product.source.recovery-validation-review.stop.v1"), payload: ImportedRecoveryValidationReviewControlV1Schema }).strict();
export const importedRecoveryValidationReviewStatusSchema = z.object({ ...command, type: z.literal("product.source.recovery-validation-review.status.v1"), payload: ImportedRecoveryValidationReviewControlV1Schema }).strict();
export const importedRecoveryValidationReviewReceiptSchema = z.object({ ...command, type: z.literal("product.source.recovery-validation-review.receipt.v1"), payload: ImportedRecoveryValidationReviewControlV1Schema,
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), status: z.enum(["accepted", "rejected"]) }).strict();
export const importedRecoveryValidationReviewAckSchema = z.object({ kind: z.literal("product.source.recovery-validation-review.ack.v1"), node_id: z.string().min(1), command_id: z.string().min(1),
  payload: ImportedRecoveryValidationReviewControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const importedRecoveryValidationReviewResultSchema = z.object({ kind: z.literal("product.source.recovery-validation-review.result.v1"), node_id: z.string().min(1), command_id: z.string().min(1), payload: ImportedRecoveryValidationReviewResultV1Schema }).strict();
export type ImportedRecoveryValidationReviewCommand = z.infer<typeof importedRecoveryValidationReviewCommandSchema>;
export type ImportedRecoveryValidationReviewStop = z.infer<typeof importedRecoveryValidationReviewStopSchema>;
export type ImportedRecoveryValidationReviewStatus = z.infer<typeof importedRecoveryValidationReviewStatusSchema>;
export type ImportedRecoveryValidationReviewReceipt = z.infer<typeof importedRecoveryValidationReviewReceiptSchema>;
export type ImportedRecoveryValidationReviewAck = z.infer<typeof importedRecoveryValidationReviewAckSchema>;
export type ImportedRecoveryValidationReviewResult = z.infer<typeof importedRecoveryValidationReviewResultSchema>;
