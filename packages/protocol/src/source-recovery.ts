import { z } from "zod";
import { ProductSourceRecoveryRegistrationV1Schema, ProductSourceRecoveryAvailabilityV1Schema,
  ProductSourceRecoveryRequestV1Schema, ProductSourceRecoveryControlV1Schema, ProductSourceRecoveryResultV1Schema } from "@artoo/domain";

const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const command = { kind: z.literal("command"), id, idempotency_key: z.string().min(1).max(256), deadline_at: z.string().datetime().optional() };
/** Ordinary Windows receipt sessions have no managed-workspace admission. */
export const productSourceRecoverySessionSchema = z.object({ ...command, type: z.literal("product.source.recovery.session.v1"),
  payload: z.object({ version: z.literal(1), node_id: id, session_id: id }).strict() }).strict();
// Registration records an epoch while its original authenticated daemon is alive.
// Availability and terminal results are separate messages and grant no local authority.
export const productSourceRecoveryRegisterSchema = z.object({ kind: z.literal("product.source.recovery.register.v1"),
  node_id: id, payload: ProductSourceRecoveryRegistrationV1Schema }).strict();
export const productSourceRecoveryAvailableSchema = z.object({ kind: z.literal("product.source.recovery.available.v1"),
  node_id: id, payload: ProductSourceRecoveryAvailabilityV1Schema }).strict();
export const productSourceRecoveryRegisteredSchema = z.object({ ...command, type: z.literal("product.source.recovery.registered.v1"),
  payload: z.object({ version: z.literal(1), registration_id: z.string().uuid(), registration_digest: digest,
    session_id: id, status: z.enum(["accepted", "rejected"]) }).strict() }).strict();
export const productSourceRecoveryCommandSchema = z.object({ ...command, type: z.literal("product.source.recovery.v1"), payload: ProductSourceRecoveryRequestV1Schema }).strict();
export const productSourceRecoveryStopSchema = z.object({ ...command, type: z.literal("product.source.recovery.stop.v1"), payload: ProductSourceRecoveryControlV1Schema }).strict();
export const productSourceRecoveryStatusSchema = z.object({ ...command, type: z.literal("product.source.recovery.status.v1"), payload: ProductSourceRecoveryControlV1Schema }).strict();
export const productSourceRecoveryReceiptSchema = z.object({ ...command, type: z.literal("product.source.recovery.receipt.v1"), payload: ProductSourceRecoveryControlV1Schema,
  result_digest: digest, status: z.enum(["accepted", "rejected"]) }).strict();
export const productSourceRecoveryAckSchema = z.object({ kind: z.literal("product.source.recovery.ack.v1"), node_id: id, command_id: id,
  payload: ProductSourceRecoveryControlV1Schema, status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() }).strict();
export const productSourceRecoveryResultSchema = z.object({ kind: z.literal("product.source.recovery.result.v1"), node_id: id, command_id: id,
  payload: ProductSourceRecoveryResultV1Schema }).strict();
export type ProductSourceRecoveryRegister = z.infer<typeof productSourceRecoveryRegisterSchema>;
export type ProductSourceRecoverySession = z.infer<typeof productSourceRecoverySessionSchema>;
export type ProductSourceRecoveryAvailable = z.infer<typeof productSourceRecoveryAvailableSchema>;
export type ProductSourceRecoveryRegistered = z.infer<typeof productSourceRecoveryRegisteredSchema>;
export type ProductSourceRecoveryCommand = z.infer<typeof productSourceRecoveryCommandSchema>;
export type ProductSourceRecoveryStop = z.infer<typeof productSourceRecoveryStopSchema>;
export type ProductSourceRecoveryStatus = z.infer<typeof productSourceRecoveryStatusSchema>;
export type ProductSourceRecoveryReceipt = z.infer<typeof productSourceRecoveryReceiptSchema>;
export type ProductSourceRecoveryAck = z.infer<typeof productSourceRecoveryAckSchema>;
export type ProductSourceRecoveryResult = z.infer<typeof productSourceRecoveryResultSchema>;
