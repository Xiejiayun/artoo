import { z } from "zod";
import { ImportedExecutionControlV1Schema, ImportedExecutionRequestV1Schema, ImportedExecutionResultV1Schema } from "@artoo/domain";

const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
export const importedExecutionCommandSchema = z.object({ ...command, type: z.literal("product.source.execution.v1"), payload: ImportedExecutionRequestV1Schema }).strict();
export const importedExecutionStopSchema = z.object({ ...command, type: z.literal("product.source.execution.stop.v1"), payload: ImportedExecutionControlV1Schema }).strict();
export const importedExecutionStatusSchema = z.object({ ...command, type: z.literal("product.source.execution.status.v1"), payload: ImportedExecutionControlV1Schema }).strict();
export const importedExecutionReceiptSchema = z.object({ ...command, type: z.literal("product.source.execution.receipt.v1"), payload: ImportedExecutionControlV1Schema,
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), status: z.enum(["accepted", "rejected"]) }).strict();
export const importedExecutionAckSchema = z.object({ kind: z.literal("product.source.execution.ack.v1"), node_id: z.string().min(1), command_id: z.string().min(1),
  payload: ImportedExecutionControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const importedExecutionResultSchema = z.object({ kind: z.literal("product.source.execution.result.v1"), node_id: z.string().min(1), command_id: z.string().min(1), payload: ImportedExecutionResultV1Schema }).strict();
export type ImportedExecutionCommand = z.infer<typeof importedExecutionCommandSchema>;
export type ImportedExecutionStop = z.infer<typeof importedExecutionStopSchema>;
export type ImportedExecutionStatus = z.infer<typeof importedExecutionStatusSchema>;
export type ImportedExecutionReceipt = z.infer<typeof importedExecutionReceiptSchema>;
export type ImportedExecutionAck = z.infer<typeof importedExecutionAckSchema>;
export type ImportedExecutionResult = z.infer<typeof importedExecutionResultSchema>;
