import { z } from "zod";

/** Private paired-node renewal secret. Never put this in ContextPack, adapter
 * input/output, journal payloads, ordinary commands, audit events or logs. */
export const SchedulerAttemptCredentialV1Schema = z
  .object({
    version: z.literal(1),
    scope: z.literal("scheduler.attempt-renew.v1"),
    credential_id: z.string().uuid(),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type SchedulerAttemptCredentialV1 = z.infer<typeof SchedulerAttemptCredentialV1Schema>;
