import { z } from "zod";

const time = z.number().int().min(0).max(8_640_000_000_000_000);

/** Queue preferences only; never an execution, consent or verification grant. */
export const SchedulerQueueMetadataV1Schema = z
  .object({
    version: z.literal(1),
    not_before_ms: time,
    preferred_computer_id: z.string().min(1).max(128).nullable(),
    prefer_until_ms: time.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.preferred_computer_id === null) !== (value.prefer_until_ms === null))
      ctx.addIssue({ code: "custom", message: "Soft affinity requires both computer and deadline" });
  });

export type SchedulerQueueMetadataV1 = z.infer<typeof SchedulerQueueMetadataV1Schema>;
