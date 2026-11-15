import { z } from "zod";
import { CreateSchedulerIntentV1Schema, SchedulerIntentSnapshotV1Schema } from "./scheduler-intent.js";

/** Fresh conditional permission for one ordinary Task execution; never promote v1. */
export const CreateSchedulerExecutionRequestV2Schema = CreateSchedulerIntentV1Schema.extend({
  version: z.literal(2),
  permission: z.literal("execute_once"),
}).strict();
export type CreateSchedulerExecutionRequestV2 = z.infer<typeof CreateSchedulerExecutionRequestV2Schema>;

// Reuse only the binding shape. The v1 false-authority contract stays unchanged.
// This snapshot is conditional user permission, not a node/attempt execution grant.
export const SchedulerExecutionRequestSnapshotV2Schema = SchedulerIntentSnapshotV1Schema.omit({
  version: true,
  request: true,
  execution_authorized: true,
})
  .extend({
    version: z.literal(2),
    request: CreateSchedulerExecutionRequestV2Schema,
  })
  .strict();
export type SchedulerExecutionRequestSnapshotV2 = z.infer<typeof SchedulerExecutionRequestSnapshotV2Schema>;
