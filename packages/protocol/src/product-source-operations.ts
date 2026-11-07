import { z } from "zod";
import { ProductSourceOperationV1Schema, ProductSourceOperationResultV1Schema, ProductSourceOperationControlV1Schema } from "@artoo/domain";
const envelope={kind:z.literal("command"),id:z.string().min(1).max(128),idempotency_key:z.string().min(1).max(256),deadline_at:z.string().datetime().optional()};
export const productSourceOperationCommandSchema=z.object({...envelope,type:z.literal("product.source.operation.v1"),payload:ProductSourceOperationV1Schema}).strict();
export const productSourceOperationStopSchema=z.object({...envelope,type:z.literal("product.source.operation.stop.v1"),payload:ProductSourceOperationControlV1Schema}).strict();
export const productSourceOperationStatusSchema=z.object({...envelope,type:z.literal("product.source.operation.status.v1"),payload:ProductSourceOperationControlV1Schema}).strict();
export const productSourceOperationAckSchema=z.object({kind:z.literal("product.source.operation.ack.v1"),node_id:z.string().min(1),command_id:z.string().min(1),
  payload:ProductSourceOperationControlV1Schema,status:z.enum(["accepted","rejected"]),message:z.string().max(2000).optional()}).strict();
export const productSourceOperationResultSchema=z.object({kind:z.literal("product.source.operation.result.v1"),node_id:z.string().min(1),command_id:z.string().min(1),payload:ProductSourceOperationResultV1Schema}).strict();
export const productSourceOperationReceiptSchema=z.object({...envelope,type:z.literal("product.source.operation.receipt.v1"),payload:ProductSourceOperationControlV1Schema,
  result_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),status:z.enum(["accepted","rejected"])}).strict();
export type ProductSourceOperationCommand=z.infer<typeof productSourceOperationCommandSchema>;
export type ProductSourceOperationStop=z.infer<typeof productSourceOperationStopSchema>;
export type ProductSourceOperationStatus=z.infer<typeof productSourceOperationStatusSchema>;
export type ProductSourceOperationReceipt=z.infer<typeof productSourceOperationReceiptSchema>;
export type ProductSourceOperationAck=z.infer<typeof productSourceOperationAckSchema>;
export type ProductSourceOperationResult=z.infer<typeof productSourceOperationResultSchema>;
