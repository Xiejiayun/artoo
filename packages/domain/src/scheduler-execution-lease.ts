import { z } from "zod";
import { SchedulerPreparedStartSnapshotV1Schema } from "./scheduler-prepared-start.js";

const uuid = z.string().uuid();

/** Durable server ownership, separate from the five-second physical start
 * window. This identity alone is neither a node credential nor a producer
 * permit, and logical expiry/finish never proves physical process closure. */
export const SchedulerExecutionLeaseBindingV1Schema = SchedulerPreparedStartSnapshotV1Schema.pick({
  organization_id: true,
  project_id: true,
  task_id: true,
  request_id: true,
  run_id: true,
  actor_user_id: true,
  agent_instance_id: true,
  computer_id: true,
  device_id: true,
  session_id: true,
})
  .extend({
    version: z.literal(1),
    scope: z.literal("scheduler.execution-lease.v1"),
    lease_id: uuid,
    epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    grant_id: uuid,
    journal_namespace: uuid,
    node_attempt_id: uuid,
  })
  .strict();
export type SchedulerExecutionLeaseBindingV1 = z.infer<typeof SchedulerExecutionLeaseBindingV1Schema>;

export const SchedulerExecutionLeaseStateV1Schema = z.enum(["active", "expired", "revoked"]);
export type SchedulerExecutionLeaseStateV1 = z.infer<typeof SchedulerExecutionLeaseStateV1Schema>;

export const SchedulerExecutionLeaseV1Schema = z
  .object({
    version: z.literal(1),
    binding: SchedulerExecutionLeaseBindingV1Schema,
    state: SchedulerExecutionLeaseStateV1Schema,
    claimed_at: z.string().datetime(),
    observed_at: z.string().datetime(),
    expires_at: z.string().datetime(),
    closed_at: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((lease, ctx) => {
    if ((lease.state === "active") !== (lease.closed_at === null))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Execution lease state and observations disagree" });
    // Authority/deadline comparisons stay in SQL at full timestamptz precision.
  });
export type SchedulerExecutionLeaseV1 = z.infer<typeof SchedulerExecutionLeaseV1Schema>;
