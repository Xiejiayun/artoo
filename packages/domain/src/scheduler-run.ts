import { z } from "zod";

/** Private lifecycle authority, intentionally incompatible with renewal-only credentials. */
export const SchedulerRunCredentialV1Schema = z
  .object({
    version: z.literal(1),
    scope: z.literal("scheduler.attempt-events.v1"),
    credential_id: z.string().uuid(),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type SchedulerRunCredentialV1 = z.infer<typeof SchedulerRunCredentialV1Schema>;

/** Protected node journal evidence, never adapter/model output. The original
 * fresh permit has been irreversibly fenced before its producer was invoked.
 * This asserts absence of a process start, not process-exit confirmation. */
export const SchedulerPermitUnusedV1Schema = z
  .object({
    version: z.literal(1),
    scope: z.literal("scheduler-unused-permit.v1"),
    grant_id: z.string().uuid(),
    journal_namespace: z.string().uuid(),
    node_attempt_id: z.string().uuid(),
    process_never_started: z.literal(true),
  })
  .strict();
export type SchedulerPermitUnusedV1 = z.infer<typeof SchedulerPermitUnusedV1Schema>;
