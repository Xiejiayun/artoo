import { z } from "zod";

/** Private paired-node poll. A claim response identifies a durable assignment;
 * only the existing ready/grant transaction can permit a physical start. */
export const schedulerClaimRegistrationSchema = z.object({ version: z.number().int().positive() }).strict();
const id = z.string().min(1).max(128),
  uuid = z.string().uuid();
const identity = { node_id: id, session_id: uuid, exchange_id: uuid };
export const schedulerClaimPollMessageSchema = z
  .object({ kind: z.literal("scheduler.claim.poll.v1"), ...identity })
  .strict();
const response = { version: z.literal(1), ...identity };
export const schedulerClaimResponseCommandSchema = z
  .object({
    kind: z.literal("command"),
    id,
    idempotency_key: id,
    type: z.literal("scheduler.claim.response.v1"),
    payload: z.discriminatedUnion("status", [
      z.object({ ...response, status: z.literal("claimed"), task_id: id, request_id: id, run_id: id }).strict(),
      z
        .object({ ...response, status: z.literal("idle"), retry_after_ms: z.number().int().min(250).max(60_000) })
        .strict(),
      z.object({ ...response, status: z.literal("rejected") }).strict(),
    ]),
  })
  .strict();
export type SchedulerClaimPollMessage = z.infer<typeof schedulerClaimPollMessageSchema>;
export type SchedulerClaimResponseCommand = z.infer<typeof schedulerClaimResponseCommandSchema>;
