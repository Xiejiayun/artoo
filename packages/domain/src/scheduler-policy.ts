import { z } from "zod";

const labels = z
  .array(z.string().trim().min(1).max(128))
  .max(64)
  .refine((values) => new Set(values).size === values.length, "labels must be unique");
const capacity = z.number().int().min(1).max(64);
const ref = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== "@" &&
      !/^[-./]|[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|\/\//.test(value) &&
      !/[/.]$/.test(value) &&
      !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")),
    "invalid baseline branch",
  );

/** Scheduling metadata only. A repository or label never grants local execution. */
export const SchedulerProjectPolicyV1Schema = z
  .object({
    version: z.literal(1),
    repo_url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine((value) => !/[\x00-\x1f\x7f]/.test(value), "invalid repository metadata")
      .nullable(),
    default_branch: ref,
    max_concurrent_runs: capacity,
  })
  .strict();
export const SchedulerAgentPolicyV1Schema = z
  .object({
    version: z.literal(1),
    max_concurrent_runs: capacity,
    pinned_computer_id: z.string().min(1).max(128).nullable(),
    required_runtimes: labels,
    required_labels: labels,
  })
  .strict();
export const SchedulerComputerPolicyV1Schema = z
  .object({
    version: z.literal(1),
    max_concurrent_runs: capacity,
    labels,
  })
  .strict();
export type SchedulerProjectPolicyV1 = z.infer<typeof SchedulerProjectPolicyV1Schema>;
export type SchedulerAgentPolicyV1 = z.infer<typeof SchedulerAgentPolicyV1Schema>;
export type SchedulerComputerPolicyV1 = z.infer<typeof SchedulerComputerPolicyV1Schema>;
