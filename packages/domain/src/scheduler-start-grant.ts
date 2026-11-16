import { z } from "zod";
import { SchedulerPreparedStartSnapshotV1Schema } from "./scheduler-prepared-start.js";

const uuid = z.string().uuid();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** A node-ready binding, not a launch permit. The authenticated transport must
 * supply the computer/session identity independently of this payload. */
export const SchedulerStartReadyV1Schema = z
  .object({
    version: z.literal(1),
    request_id: SchedulerPreparedStartSnapshotV1Schema.shape.request_id,
    run_id: SchedulerPreparedStartSnapshotV1Schema.shape.run_id,
    journal_namespace: uuid,
    node_attempt_id: uuid,
    ready_id: uuid,
    proposal_digest: digest,
  })
  .strict();
export type SchedulerStartReadyV1 = z.infer<typeof SchedulerStartReadyV1Schema>;

/** A bounded server authorization for exactly one prepared node attempt.
 * It still requires private node admission and a live monotonic deadline. */
export const SchedulerStartGrantV1Schema = SchedulerPreparedStartSnapshotV1Schema.pick({
  organization_id: true,
  project_id: true,
  task_id: true,
  actor_user_id: true,
  agent_instance_id: true,
  computer_id: true,
  device_id: true,
  session_id: true,
})
  .extend({
    ...SchedulerStartReadyV1Schema.shape,
    scope: z.literal("scheduler-start.once.v1"),
    grant_id: uuid,
    issued_at: z.string().datetime(),
    expires_at: z.string().datetime(),
  })
  .strict()
  .superRefine((grant, ctx) => {
    const duration = Date.parse(grant.expires_at) - Date.parse(grant.issued_at);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 5000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Scheduler start grant lifetime must be within five seconds",
      });
    }
  });
export type SchedulerStartGrantV1 = z.infer<typeof SchedulerStartGrantV1Schema>;
