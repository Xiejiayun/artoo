import { z } from "zod";
import { VerificationCapabilitiesSchema } from "./verification-capabilities.js";

export const PRODUCT_SOURCE_TRANSFER_FEATURE_V1 = "product-source-transfer.v1" as const;
export const PRODUCT_SOURCE_TRANSFER_MAX_BYTES_V1 = 12 * 1024 * 1024;
const id = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const workspace = z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$/u);

/** An immutable request to transport bytes. It is never a verifier or writer permit. */
export const ProductSourceTransferRequestV1Schema = z.object({
  version: z.literal(1), kind: z.literal(PRODUCT_SOURCE_TRANSFER_FEATURE_V1),
  transfer_id: id, organization_id: id, project_id: id, goal_id: id, plan_id: id,
  authorization: z.object({ actor_user_id: id, consent_id: id.nullable(), policy_version: id }).strict(),
  source: z.object({ node_id: id, task_id: id, run_id: id, evidence_id: id, verification_request_id: id,
    profile_id: id, profile_digest: digest, workspace_root: workspace, subject_digest: digest,
    review_id: id, reviewer_run_id: id, reviewer_evidence_id: id,
    capsule_digest: digest, manifest_digest: digest,
    capsule_bytes: z.number().int().min(1).max(PRODUCT_SOURCE_TRANSFER_MAX_BYTES_V1),
  }).strict(),
  destination: z.object({ node_id: id, profile_id: id, workspace_root: workspace,
    capabilities: VerificationCapabilitiesSchema, capability_digest: digest,
  }).strict(),
}).strict().superRefine((request, ctx) => {
  if (request.source.node_id === request.destination.node_id) ctx.addIssue({ code: "custom", message: "Transfer v1 requires different nodes" });
});
export type ProductSourceTransferRequestV1 = z.infer<typeof ProductSourceTransferRequestV1Schema>;

/** Key ordering does not let a replay evade the full immutable request binding. */
export function canonicalProductSourceTransferValueV1(value: unknown): string {
  const normalize = (input: unknown): unknown => Array.isArray(input) ? input.map(normalize)
    : input !== null && typeof input === "object" ? Object.fromEntries(Object.entries(input)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, normalize(child)])) : input;
  return JSON.stringify(normalize(value));
}
export function productSourceTransferRequestDigestV1(value: unknown, sha256: (value: string) => string): string {
  return digest.parse(sha256(canonicalProductSourceTransferValueV1(ProductSourceTransferRequestV1Schema.parse(value))));
}

/** available means only that this exact authorized destination can fetch bytes. */
export const ProductSourceTransferReceiptV1Schema = z.object({
  version: z.literal(1), transfer_id: id, request_digest: digest, capsule_digest: digest,
  status: z.enum(["awaiting_upload", "available"]), execution_authorized: z.literal(false),
}).strict();
export type ProductSourceTransferReceiptV1 = z.infer<typeof ProductSourceTransferReceiptV1Schema>;
