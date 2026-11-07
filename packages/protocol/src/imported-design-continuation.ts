import { z } from "zod";
import { ImportedDesignContinuationControlV1Schema, ImportedDesignContinuationRequestV1Schema, ImportedDesignContinuationResultV1Schema } from "@artoo/domain";

const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
export const importedDesignContinuationCommandSchema = z.object({ ...command, type: z.literal("product.source.design.v1"), payload: ImportedDesignContinuationRequestV1Schema }).strict();
export const importedDesignContinuationStopSchema = z.object({ ...command, type: z.literal("product.source.design.stop.v1"), payload: ImportedDesignContinuationControlV1Schema }).strict();
export const importedDesignContinuationStatusSchema = z.object({ ...command, type: z.literal("product.source.design.status.v1"), payload: ImportedDesignContinuationControlV1Schema }).strict();
export const importedDesignContinuationReceiptSchema = z.object({ ...command, type: z.literal("product.source.design.receipt.v1"), payload: ImportedDesignContinuationControlV1Schema,
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), status: z.enum(["accepted", "rejected"]) }).strict();
export const importedDesignContinuationAckSchema = z.object({ kind: z.literal("product.source.design.ack.v1"), node_id: z.string().min(1), command_id: z.string().min(1),
  payload: ImportedDesignContinuationControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const importedDesignContinuationResultSchema = z.object({ kind: z.literal("product.source.design.result.v1"), node_id: z.string().min(1), command_id: z.string().min(1), payload: ImportedDesignContinuationResultV1Schema }).strict();
export type ImportedDesignContinuationCommand = z.infer<typeof importedDesignContinuationCommandSchema>;
export type ImportedDesignContinuationStop = z.infer<typeof importedDesignContinuationStopSchema>;
export type ImportedDesignContinuationStatus = z.infer<typeof importedDesignContinuationStatusSchema>;
export type ImportedDesignContinuationReceipt = z.infer<typeof importedDesignContinuationReceiptSchema>;
export type ImportedDesignContinuationAck = z.infer<typeof importedDesignContinuationAckSchema>;
export type ImportedDesignContinuationResult = z.infer<typeof importedDesignContinuationResultSchema>;
