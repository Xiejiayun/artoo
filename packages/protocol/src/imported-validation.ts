import { z } from "zod";
import { ImportedValidationControlV1Schema, ImportedValidationRequestV1Schema, ImportedValidationResultV1Schema } from "@artoo/domain";

const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
export const importedValidationCommandSchema = z.object({ ...command, type: z.literal("product.source.validation.v1"), payload: ImportedValidationRequestV1Schema }).strict();
export const importedValidationStopSchema = z.object({ ...command, type: z.literal("product.source.validation.stop.v1"), payload: ImportedValidationControlV1Schema }).strict();
export const importedValidationStatusSchema = z.object({ ...command, type: z.literal("product.source.validation.status.v1"), payload: ImportedValidationControlV1Schema }).strict();
export const importedValidationReceiptSchema = z.object({ ...command, type: z.literal("product.source.validation.receipt.v1"), payload: ImportedValidationControlV1Schema,
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), status: z.enum(["accepted", "rejected"]) }).strict();
export const importedValidationAckSchema = z.object({ kind: z.literal("product.source.validation.ack.v1"), node_id: z.string().min(1), command_id: z.string().min(1),
  payload: ImportedValidationControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const importedValidationResultSchema = z.object({ kind: z.literal("product.source.validation.result.v1"), node_id: z.string().min(1), command_id: z.string().min(1), payload: ImportedValidationResultV1Schema }).strict();
export type ImportedValidationCommand = z.infer<typeof importedValidationCommandSchema>;
export type ImportedValidationStop = z.infer<typeof importedValidationStopSchema>;
export type ImportedValidationStatus = z.infer<typeof importedValidationStatusSchema>;
export type ImportedValidationReceipt = z.infer<typeof importedValidationReceiptSchema>;
export type ImportedValidationAck = z.infer<typeof importedValidationAckSchema>;
export type ImportedValidationResult = z.infer<typeof importedValidationResultSchema>;
