import { z } from "zod";
import { ImportedExecutionRepairControlV1Schema, ImportedExecutionRepairRequestV1Schema, ImportedExecutionRepairResultV1Schema } from "@artoo/domain";

const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
export const importedExecutionRepairCommandSchema = z.object({ ...command, type: z.literal("product.source.execution-repair.v1"), payload: ImportedExecutionRepairRequestV1Schema }).strict();
export const importedExecutionRepairStopSchema = z.object({ ...command, type: z.literal("product.source.execution-repair.stop.v1"), payload: ImportedExecutionRepairControlV1Schema }).strict();
export const importedExecutionRepairStatusSchema = z.object({ ...command, type: z.literal("product.source.execution-repair.status.v1"), payload: ImportedExecutionRepairControlV1Schema }).strict();
export const importedExecutionRepairReceiptSchema = z.object({ ...command, type: z.literal("product.source.execution-repair.receipt.v1"), payload: ImportedExecutionRepairControlV1Schema,
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), status: z.enum(["accepted", "rejected"]) }).strict();
export const importedExecutionRepairAckSchema = z.object({ kind: z.literal("product.source.execution-repair.ack.v1"), node_id: z.string().min(1), command_id: z.string().min(1),
  payload: ImportedExecutionRepairControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const importedExecutionRepairResultSchema = z.object({ kind: z.literal("product.source.execution-repair.result.v1"), node_id: z.string().min(1), command_id: z.string().min(1), payload: ImportedExecutionRepairResultV1Schema }).strict();
export type ImportedExecutionRepairCommand = z.infer<typeof importedExecutionRepairCommandSchema>;
export type ImportedExecutionRepairStop = z.infer<typeof importedExecutionRepairStopSchema>;
export type ImportedExecutionRepairStatus = z.infer<typeof importedExecutionRepairStatusSchema>;
export type ImportedExecutionRepairReceipt = z.infer<typeof importedExecutionRepairReceiptSchema>;
export type ImportedExecutionRepairAck = z.infer<typeof importedExecutionRepairAckSchema>;
export type ImportedExecutionRepairResult = z.infer<typeof importedExecutionRepairResultSchema>;
