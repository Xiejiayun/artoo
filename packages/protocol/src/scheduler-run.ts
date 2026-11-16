import { z } from "zod";
import {
  SchedulerRunCredentialV1Schema,
  SchedulerExecutionLeaseBindingV1Schema,
  SchedulerExecutionLeaseV1Schema,
  SchedulerStartGrantV1Schema,
} from "@artoo/domain";
import type { RunEventMessage } from "./node-messages.js";

export const schedulerRunRegistrationSchema = z.object({ version: z.number().int().positive() }).strict();
const id = z.string().min(1).max(128),
  uuid = z.string().uuid();
const request = { node_id: id, session_id: uuid, exchange_id: uuid };
export const schedulerRunAcquireMessageSchema = z
  .object({
    kind: z.literal("scheduler.run.acquire.v1"),
    ...request,
    grant: SchedulerStartGrantV1Schema,
  })
  .strict();
export const schedulerRunStatusMessageSchema = z
  .object({
    kind: z.literal("scheduler.run.status.v1"),
    ...request,
    binding: SchedulerExecutionLeaseBindingV1Schema,
    credential: SchedulerRunCredentialV1Schema,
  })
  .strict();
/** The inner frame is qualified by the existing Run receipt owner before any
 * write. A type-only import avoids a registration/Run-schema initialization cycle. */
export const schedulerRunEventMessageSchema = z
  .object({
    kind: z.literal("scheduler.run.event.v1"),
    node_id: id,
    session_id: uuid,
    binding: SchedulerExecutionLeaseBindingV1Schema,
    credential: SchedulerRunCredentialV1Schema,
    frame: z.custom<RunEventMessage>((value) => value !== null && typeof value === "object" && !Array.isArray(value)),
  })
  .strict();
const response = { version: z.literal(1), ...request };
const activeLease = SchedulerExecutionLeaseV1Schema.refine((value) => value.state === "active");
export const schedulerRunResponseCommandSchema = z
  .object({
    kind: z.literal("command"),
    id,
    idempotency_key: id,
    type: z.literal("scheduler.run.response.v1"),
    payload: z.discriminatedUnion("status", [
      z
        .object({
          ...response,
          status: z.literal("issued"),
          lease: activeLease,
          credential: SchedulerRunCredentialV1Schema,
          stop_requested: z.boolean(),
        })
        .strict(),
      z
        .object({ ...response, status: z.literal("retained"), lease: activeLease, stop_requested: z.boolean() })
        .strict(),
      z.object({ ...response, status: z.literal("current"), lease: activeLease, stop_requested: z.boolean() }).strict(),
      z.object({ ...response, status: z.literal("rejected"), operation: z.enum(["acquire", "status"]) }).strict(),
    ]),
  })
  .strict();
export type SchedulerRunRequestMessage =
  | z.infer<typeof schedulerRunAcquireMessageSchema>
  | z.infer<typeof schedulerRunStatusMessageSchema>;
export type SchedulerRunEventMessage = z.infer<typeof schedulerRunEventMessageSchema>;
export type SchedulerRunResponseCommand = z.infer<typeof schedulerRunResponseCommandSchema>;
