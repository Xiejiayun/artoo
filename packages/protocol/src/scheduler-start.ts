import { z } from "zod";
import {
  SchedulerStartGrantResponseV1Schema,
  SchedulerStartProposalV1Schema,
  SchedulerStartReadyV1Schema,
} from "@artoo/domain";

const id = z.string().min(1).max(128);
const uuid = z.string().uuid();
// Registration admits future versions so the peer can explicitly reject them.
export const schedulerStartRegistrationSchema = z
  .object({
    version: z.number().int().positive(),
    journal_namespace: uuid,
  })
  .strict();
const request = { node_id: id, session_id: uuid, exchange_id: uuid, task_id: id };
export const schedulerStartProposalRequestSchema = z
  .object({
    kind: z.literal("scheduler.start.propose.v1"),
    ...request,
    request_id: id,
  })
  .strict();
export const schedulerStartReadyMessageSchema = z
  .object({
    kind: z.literal("scheduler.start.ready.v1"),
    ...request,
    ready: SchedulerStartReadyV1Schema,
  })
  .strict();
export const schedulerStartProposalResultSchema = z
  .object({
    version: z.literal(1),
    proposal: SchedulerStartProposalV1Schema,
    proposal_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    execution_authorized: z.literal(false),
  })
  .strict();
const response = { version: z.literal(1), node_id: id, session_id: uuid, exchange_id: uuid };
export const schedulerStartResponseCommandSchema = z
  .object({
    kind: z.literal("command"),
    id,
    idempotency_key: id,
    type: z.literal("scheduler.start.response.v1"),
    payload: z.discriminatedUnion("status", [
      z.object({ ...response, status: z.literal("proposal"), result: schedulerStartProposalResultSchema }).strict(),
      z.object({ ...response, status: z.literal("grant"), result: SchedulerStartGrantResponseV1Schema }).strict(),
      z.object({ ...response, status: z.literal("rejected"), operation: z.enum(["proposal", "grant"]) }).strict(),
    ]),
  })
  .strict();
export type SchedulerStartProposalRequest = z.infer<typeof schedulerStartProposalRequestSchema>;
export type SchedulerStartReadyMessage = z.infer<typeof schedulerStartReadyMessageSchema>;
export type SchedulerStartRequestMessage = SchedulerStartProposalRequest | SchedulerStartReadyMessage;
export type SchedulerStartProposalResult = z.infer<typeof schedulerStartProposalResultSchema>;
export type SchedulerStartResponseCommand = z.infer<typeof schedulerStartResponseCommandSchema>;
