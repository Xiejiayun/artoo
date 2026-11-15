import { z } from "zod";
import { SchedulerIntentSnapshotV1Schema } from "./scheduler-intent.js";

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Immutable server evidence after assignment; never a node launch permit or renewed user permission. */
export const SchedulerPreparedStartSnapshotV1Schema = z
  .object({
    version: z.literal(1),
    request_id: id,
    request_snapshot_digest: digest,
    organization_id: id,
    project_id: id,
    task_id: id,
    actor_user_id: id,
    run_id: id,
    agent_instance_id: id,
    computer_id: id,
    device_id: id,
    session_id: id,
    assigned: SchedulerIntentSnapshotV1Schema.pick({
      task_input_version: true,
      task_input_digest: true,
      queue_revision: true,
      policy_revisions: true,
      configuration_digest: true,
    }).strict(),
    prepared_run_digest: digest,
    execution_authorized: z.literal(false),
  })
  .strict();
export type SchedulerPreparedStartSnapshotV1 = z.infer<typeof SchedulerPreparedStartSnapshotV1Schema>;
