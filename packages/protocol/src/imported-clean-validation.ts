import { z } from "zod";
import { ImportedCleanValidationControlV1Schema, ImportedCleanValidationRequestV1Schema, ImportedCleanValidationResultV1Schema } from "@artoo/domain";

const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
// Name the exact shape so declaration emit references the domain codec instead
// of serializing its complete nested request graph into this wire envelope.
type ImportedCleanValidationCommandShape = typeof command & {
  type: z.ZodLiteral<"product.source.clean-validation.v1">;
  payload: typeof ImportedCleanValidationRequestV1Schema;
};
export const importedCleanValidationCommandSchema: z.ZodObject<ImportedCleanValidationCommandShape, z.core.$strict> = z.object({ ...command, type: z.literal("product.source.clean-validation.v1"), payload: ImportedCleanValidationRequestV1Schema }).strict();
export const importedCleanValidationStopSchema = z.object({ ...command, type: z.literal("product.source.clean-validation.stop.v1"), payload: ImportedCleanValidationControlV1Schema }).strict();
export const importedCleanValidationStatusSchema = z.object({ ...command, type: z.literal("product.source.clean-validation.status.v1"), payload: ImportedCleanValidationControlV1Schema }).strict();
export const importedCleanValidationReceiptSchema = z.object({ ...command, type: z.literal("product.source.clean-validation.receipt.v1"), payload: ImportedCleanValidationControlV1Schema,
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), status: z.enum(["accepted", "rejected"]) }).strict();
export const importedCleanValidationAckSchema = z.object({ kind: z.literal("product.source.clean-validation.ack.v1"), node_id: z.string().min(1), command_id: z.string().min(1),
  payload: ImportedCleanValidationControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const importedCleanValidationResultSchema = z.object({ kind: z.literal("product.source.clean-validation.result.v1"), node_id: z.string().min(1), command_id: z.string().min(1), payload: ImportedCleanValidationResultV1Schema }).strict();
export type ImportedCleanValidationCommand = z.infer<typeof importedCleanValidationCommandSchema>;
export type ImportedCleanValidationStop = z.infer<typeof importedCleanValidationStopSchema>;
export type ImportedCleanValidationStatus = z.infer<typeof importedCleanValidationStatusSchema>;
export type ImportedCleanValidationReceipt = z.infer<typeof importedCleanValidationReceiptSchema>;
export type ImportedCleanValidationAck = z.infer<typeof importedCleanValidationAckSchema>;
export type ImportedCleanValidationResult = z.infer<typeof importedCleanValidationResultSchema>;
