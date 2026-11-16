import { z } from "zod";

/** Private lifecycle authority, intentionally incompatible with renewal-only credentials. */
export const SchedulerRunCredentialV1Schema = z.object({
  version: z.literal(1),
  scope: z.literal("scheduler.attempt-events.v1"),
  credential_id: z.string().uuid(),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export type SchedulerRunCredentialV1 = z.infer<typeof SchedulerRunCredentialV1Schema>;
