import { z } from "zod";
import {
  SchedulerAttemptCredentialV1Schema,
  SchedulerExecutionLeaseBindingV1Schema,
  SchedulerExecutionLeaseV1Schema,
  SchedulerStartGrantV1Schema,
} from "@artoo/domain";

/** Private paired-node lane; secrets never enter ordinary command subscribers. */
export const schedulerLeaseRegistrationSchema = z.object({ version: z.number().int().positive() }).strict();
const id = z.string().min(1).max(128),
  uuid = z.string().uuid();
const request = { node_id: id, session_id: uuid, exchange_id: uuid };
export const schedulerLeaseAcquireMessageSchema = z
  .object({ kind: z.literal("scheduler.lease.acquire.v1"), ...request, grant: SchedulerStartGrantV1Schema })
  .strict();
export const schedulerLeaseRenewMessageSchema = z
  .object({
    kind: z.literal("scheduler.lease.renew.v1"),
    ...request,
    binding: SchedulerExecutionLeaseBindingV1Schema,
    credential: SchedulerAttemptCredentialV1Schema,
  })
  .strict();
const response = { version: z.literal(1), ...request };
const activeLease = SchedulerExecutionLeaseV1Schema.refine((value) => value.state === "active");
export const schedulerLeaseResponseCommandSchema = z
  .object({
    kind: z.literal("command"),
    id,
    idempotency_key: id,
    type: z.literal("scheduler.lease.response.v1"),
    payload: z.discriminatedUnion("status", [
      z
        .object({
          ...response,
          status: z.literal("issued"),
          lease: activeLease,
          credential: SchedulerAttemptCredentialV1Schema,
        })
        .strict(),
      z.object({ ...response, status: z.literal("retained"), lease: activeLease }).strict(),
      z.object({ ...response, status: z.literal("renewed"), lease: activeLease }).strict(),
      z.object({ ...response, status: z.literal("rejected"), operation: z.enum(["acquire", "renew"]) }).strict(),
    ]),
  })
  .strict();
export type SchedulerLeaseRequestMessage =
  | z.infer<typeof schedulerLeaseAcquireMessageSchema>
  | z.infer<typeof schedulerLeaseRenewMessageSchema>;
export type SchedulerLeaseResponseCommand = z.infer<typeof schedulerLeaseResponseCommandSchema>;
