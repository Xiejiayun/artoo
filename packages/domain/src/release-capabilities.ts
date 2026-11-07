import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const CONFIGURED_STATIC_PUBLICATION_CLAIM = "configured-static-publication" as const;
export const CONFIGURED_STATIC_PUBLICATION_STATEMENT = "The final verified immutable static product is activated at the configured endpoint, and the node's point-in-time HTTP checks confirm the configured paths, content digests and release identity.";
// SHA-256 of the exact UTF-8 statement. A wording change is a contract change.
export const CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST = "sha256:65cbd1da085b0caaa00787fd877924dd79ac1157e869285019fd01686411451f";

export const CriterionRefSchema = z.object({ requirement_id: id, criterion_index: z.number().int().min(0).max(99) }).strict();
export type CriterionRef = z.infer<typeof CriterionRefSchema>;
export const criterionRefKey = (ref: CriterionRef): string => `${ref.requirement_id}:${ref.criterion_index}`;
export const compareCriterionRefs = (a: CriterionRef, b: CriterionRef): number =>
  a.requirement_id < b.requirement_id ? -1 : a.requirement_id > b.requirement_id ? 1 : a.criterion_index - b.criterion_index;

/** Public descriptions cannot install local execution authority. */
export const ReleaseCapabilityBindingV1Schema = z.object({ version: z.literal(1),
  release_profile_id: id, release_profile_digest: digest, contract_digest: digest,
  project_id: id, workspace_root: z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
  verification_profile_id: id, verification_profile_digest: digest,
}).strict();
export type ReleaseCapabilityBindingV1 = z.infer<typeof ReleaseCapabilityBindingV1Schema>;
const healthPath = z.string().min(1).max(1024).refine(value => {
  if (!value.startsWith("/") || value.startsWith("//") || /[?#\\\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const decoded = decodeURIComponent(value).slice(1);
    const file = !decoded || decoded.endsWith("/") ? `${decoded}index.html` : decoded;
    return file.length <= 1024 && !/[\\:\u0000-\u001f\u007f]/u.test(file)
      && file.split("/").every(part => part !== "" && !part.startsWith("."));
  }
  catch { return false; }
}, "Expected a configured endpoint path");
export const ReleaseCapabilityContractV1Schema = z.object({ version: z.literal(1), kind: z.literal("configured-static-release"),
  claim: z.literal("configured"), execution_phase: z.literal("after-stage-acceptance"), endpoint_scope: z.literal("configured-origin"),
  measurement_scope: z.literal("node-http-point-in-time"), lifecycle: z.literal("while-configured-node-service-running"),
  health_checks: z.array(z.object({ path: healthPath, expected_status: z.literal(200), body: z.literal("immutable-artifact-equality"),
    identity: z.literal("release-id-and-artifact-digest-headers") }).strict()).min(1).max(32)
    .refine(checks => new Set(checks.map(check => check.path)).size === checks.length, "Duplicate release health paths"),
  criterion: z.object({ id: z.literal(CONFIGURED_STATIC_PUBLICATION_CLAIM), statement: z.literal(CONFIGURED_STATIC_PUBLICATION_STATEMENT),
    statement_digest: z.literal(CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST) }).strict(),
}).strict();
export type ReleaseCapabilityContractV1 = z.infer<typeof ReleaseCapabilityContractV1Schema>;
export const ReleaseCapabilitiesV1Schema = z.object({ version: z.literal(1), binding: ReleaseCapabilityBindingV1Schema,
  contract: ReleaseCapabilityContractV1Schema }).strict();
export type ReleaseCapabilitiesV1 = z.infer<typeof ReleaseCapabilitiesV1Schema>;

export const ReleaseCriterionBindingV1Schema = CriterionRefSchema.extend({ criterion_digest: digest,
  claim_id: z.literal(CONFIGURED_STATIC_PUBLICATION_CLAIM) }).strict();
export type ReleaseCriterionBindingV1 = z.infer<typeof ReleaseCriterionBindingV1Schema>;
const criteria = z.array(ReleaseCriterionBindingV1Schema).min(1).max(10000)
  .refine(refs => refs.every((ref, i) => i === 0 || compareCriterionRefs(refs[i - 1]!, ref) < 0), "Release criteria must be unique and sorted");
export const ReleaseAcceptanceBindingV1Schema = z.object({ version: z.literal(1),
  plan: z.object({ id, version: z.number().int().positive() }).strict(),
  research: z.object({ path: z.literal(".artoo/product/research.json"), checksum: digest, size: z.number().int().min(1).max(1024 * 1024) }).strict(),
  measurement_plan_digest: digest, release_binding: ReleaseCapabilityBindingV1Schema, criteria,
}).strict();
export type ReleaseAcceptanceBindingV1 = z.infer<typeof ReleaseAcceptanceBindingV1Schema>;
export const ReleaseAcceptanceReceiptV1Schema = z.object({ version: z.literal(1), binding_digest: digest,
  scope: z.literal("node-http-point-in-time"), settled_criteria: criteria }).strict();
export type ReleaseAcceptanceReceiptV1 = z.infer<typeof ReleaseAcceptanceReceiptV1Schema>;

/** JSON value comparison/hash input: object order is immaterial, array order is preserved. */
export function canonicalReleaseJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReleaseJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonicalReleaseJson(child)}`).join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Expected a finite JSON number");
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error("Expected a JSON value"); return encoded;
}
export function releaseCapabilityBinding(capabilities: ReleaseCapabilitiesV1): ReleaseCapabilityBindingV1 {
  return ReleaseCapabilitiesV1Schema.parse(capabilities).binding;
}
export function canonicalReleaseCapabilityContract(contract: ReleaseCapabilityContractV1): string {
  return canonicalReleaseJson(ReleaseCapabilityContractV1Schema.parse(contract));
}
export function canonicalReleaseAcceptanceBinding(binding: ReleaseAcceptanceBindingV1): string {
  return canonicalReleaseJson(ReleaseAcceptanceBindingV1Schema.parse(binding));
}
export function canonicalReleaseCriterion(requirement: { id: string; description: string; priority: "must" | "should"; acceptance_criteria: string[] }, criterion_index: number): string {
  const ref = CriterionRefSchema.parse({ requirement_id: requirement.id, criterion_index });
  const criterion_text = requirement.acceptance_criteria[criterion_index];
  if (typeof criterion_text !== "string") throw new Error("Unknown release criterion");
  return canonicalReleaseJson({ ...ref, description: requirement.description, priority: requirement.priority, criterion_text });
}
