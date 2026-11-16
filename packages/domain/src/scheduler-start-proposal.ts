import { z } from "zod";
import { RunStartPayloadSchema } from "./node-payloads.js";
import { canonicalReleaseJson } from "./release-capabilities.js";
import { SchedulerPreparedStartSnapshotV1Schema } from "./scheduler-prepared-start.js";

const shape = z
  .object({
    version: z.literal(1),
    prepared_start: SchedulerPreparedStartSnapshotV1Schema,
    run_start: RunStartPayloadSchema,
  })
  .strict();

/** A distinct, false-authority proposal. Never reinterpret it as run.start or
 * silently strip fields from the complete immutable launch binding. */
export const SchedulerStartProposalV1Schema = z.unknown().transform((raw, ctx) => {
  const parsed = shape.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
    return z.NEVER;
  }
  try {
    if (canonicalReleaseJson(raw) !== canonicalReleaseJson(parsed.data)) {
      throw new Error("Unsupported fields cannot be stripped from a scheduler start proposal");
    }
    const { prepared_start: prepared, run_start: start } = parsed.data;
    if (
      prepared.run_id !== start.run_id ||
      prepared.task_id !== start.task_id ||
      prepared.agent_instance_id !== start.agent_instance_id ||
      start.context_pack.payload?.task.id !== prepared.task_id ||
      start.context_pack.payload?.project.id !== prepared.project_id
    ) {
      throw new Error("Scheduler proposal identities and inline context must agree");
    }
    if (new TextEncoder().encode(canonicalReleaseJson(parsed.data)).byteLength > 1024 * 1024) {
      throw new Error("Scheduler proposal exceeds the bounded journal payload size");
    }
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Invalid scheduler proposal JSON",
    });
    return z.NEVER;
  }
  return parsed.data;
});
export type SchedulerStartProposalV1 = z.infer<typeof SchedulerStartProposalV1Schema>;

/** Metadata/hash input only. Arrays retain order; object keys use UTF-16 order. */
export function canonicalSchedulerStartProposalV1(raw: unknown): string {
  return canonicalReleaseJson({ kind: "scheduler-start-proposal.v1", ...SchedulerStartProposalV1Schema.parse(raw) });
}
