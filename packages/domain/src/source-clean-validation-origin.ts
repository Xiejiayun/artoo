import { z } from "zod";
import { SourceCleanRestartGrantV1Schema, SourceCleanRestartCheckpointV1Schema, SourceCleanRestartReceiptV1Schema,
  inspectSourceCleanCheckpointV1, sourceCleanDigestV1 } from "./source-clean-restart.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";

/** Public provenance for a wholly new Supervisor/store generation. This is not
 * a surviving-Guardian recovery checkpoint and cannot revive any native brand.
 * Server readers require the committed rows/events; node readers additionally
 * require the actual current in-process registration and checkpoint ACK. */
export const SourceCleanValidationOriginV1Schema = z.object({
  version: z.literal(1), kind: z.literal("clean-restart.v1"),
  generation_id: z.string().uuid(), lineage_id: z.string().uuid(),
  grant: SourceCleanRestartGrantV1Schema,
  checkpoint: SourceCleanRestartCheckpointV1Schema,
  receipt: SourceCleanRestartReceiptV1Schema,
  settlement_event_id: z.string().min(1).max(128),
}).strict().superRefine((value, ctx) => {
  const { grant, checkpoint, receipt } = value;
  if (value.generation_id !== grant.generation_id || value.generation_id !== checkpoint.generation_id
    || value.generation_id !== receipt.generation_id || value.lineage_id !== grant.lineage_id
    || value.lineage_id !== checkpoint.lineage_id || value.lineage_id !== receipt.lineage_id
    || checkpoint.grant_digest !== receipt.grant_digest
    || receipt.registration_id !== checkpoint.lifecycle_registration.registration.registration_id
    || receipt.session_id !== checkpoint.lifecycle_registration.registration.epoch.session_id)
    ctx.addIssue({ code: "custom", message: "Clean validation origin must name one committed fresh generation and paired checkpoint" });
});
export type SourceCleanValidationOriginV1 = z.infer<typeof SourceCleanValidationOriginV1Schema>;
export function inspectSourceCleanValidationOriginV1(input: unknown, sha: SourceOperationSha) {
  const value = SourceCleanValidationOriginV1Schema.parse(input);
  const checkpoint = inspectSourceCleanCheckpointV1(value.grant, value.checkpoint, sha);
  if (value.receipt.grant_digest !== sourceCleanDigestV1(value.grant, sha)
    || value.receipt.checkpoint_digest !== sourceCleanDigestV1(checkpoint, sha)
    || canonical(value.receipt.source_state) !== canonical("unverified"))
    throw Error("Clean validation origin changed its exact committed unverified checkpoint");
  return value;
}
export function sourceCleanValidationOriginDigestV1(input: unknown, sha: SourceOperationSha): string {
  return sourceCleanDigestV1(inspectSourceCleanValidationOriginV1(input, sha), sha);
}
