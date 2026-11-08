import { z } from "zod";
import { ImportedRecoveryValidationControlV1Schema, ImportedRecoveryValidationRequestV1Schema, ImportedRecoveryValidationResultV1Schema } from "@artoo/domain";

const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
export const importedRecoveryValidationCommandSchema = z.object({ ...command, type: z.literal("product.source.recovery-validation.v1"), payload: ImportedRecoveryValidationRequestV1Schema }).strict();
export const importedRecoveryValidationStopSchema = z.object({ ...command, type: z.literal("product.source.recovery-validation.stop.v1"), payload: ImportedRecoveryValidationControlV1Schema }).strict();
export const importedRecoveryValidationStatusSchema = z.object({ ...command, type: z.literal("product.source.recovery-validation.status.v1"), payload: ImportedRecoveryValidationControlV1Schema }).strict();
export const importedRecoveryValidationReceiptSchema = z.object({ ...command, type: z.literal("product.source.recovery-validation.receipt.v1"), payload: ImportedRecoveryValidationControlV1Schema,
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), status: z.enum(["accepted", "rejected"]) }).strict();
export const importedRecoveryValidationAckSchema = z.object({ kind: z.literal("product.source.recovery-validation.ack.v1"), node_id: z.string().min(1), command_id: z.string().min(1),
  payload: ImportedRecoveryValidationControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const importedRecoveryValidationResultSchema = z.object({ kind: z.literal("product.source.recovery-validation.result.v1"), node_id: z.string().min(1), command_id: z.string().min(1), payload: ImportedRecoveryValidationResultV1Schema }).strict();
export type ImportedRecoveryValidationCommand = z.infer<typeof importedRecoveryValidationCommandSchema>;
export type ImportedRecoveryValidationStop = z.infer<typeof importedRecoveryValidationStopSchema>;
export type ImportedRecoveryValidationStatus = z.infer<typeof importedRecoveryValidationStatusSchema>;
export type ImportedRecoveryValidationReceipt = z.infer<typeof importedRecoveryValidationReceiptSchema>;
export type ImportedRecoveryValidationAck = z.infer<typeof importedRecoveryValidationAckSchema>;
export type ImportedRecoveryValidationResult = z.infer<typeof importedRecoveryValidationResultSchema>;
