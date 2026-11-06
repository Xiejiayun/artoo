import { z } from "zod";
import { ProductDesignV2Schema, ProductResearchReportV2Schema, validateProductDevelopmentHandoff } from "./product-development.js";
import { canonicalReleaseJson, CriterionRefSchema, criterionRefKey } from "./release-capabilities.js";

/** Reviewer intent only. The trusted server must independently bind and authorize a revision. */
export const AdditiveDesignRevisionRequestV1Schema = z.object({
  version: z.literal(1),
  kind: z.literal("add-validation-cases"),
  reason: z.string().trim().min(1).max(2000),
  requirement_criteria: z.array(CriterionRefSchema).min(1).max(100),
}).strict().refine(value => new Set(value.requirement_criteria.map(criterionRefKey)).size === value.requirement_criteria.length,
  "Duplicate requested design revision criteria");
export type AdditiveDesignRevisionRequestV1 = z.infer<typeof AdditiveDesignRevisionRequestV1Schema>;

export const PRODUCT_DESIGN_REVISION_FEATURE_V1 = "product-design-revision.v1";
export const MAX_PRODUCT_DESIGN_REVISION_BYTES = 1024 * 1024;
const revisionId = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u);
const revisionDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const designPin = z.object({ path: z.literal(".artoo/product/design.json"), checksum: revisionDigest,
  size: z.number().int().min(1).max(MAX_PRODUCT_DESIGN_REVISION_BYTES) }).strict();

/** Server-retained immutable baseline and independently qualified request. No serialized field grants execution authority. */
export const ProductDesignRevisionContextV1Schema = z.object({
  version: z.literal(1), revision_id: revisionId, project_id: revisionId, goal_id: revisionId, plan_id: revisionId,
  computer_id: revisionId, workspace_root: z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
  design_task_id: revisionId, author_run_id: revisionId, request: AdditiveDesignRevisionRequestV1Schema,
  requesting_review: z.object({ review_id: revisionId, subject_run_id: revisionId, subject_evidence_id: revisionId,
    reviewer_instance_id: revisionId, reviewer_run_id: revisionId, reviewer_evidence_id: revisionId,
    turn_id: revisionId, response_message_id: revisionId, response_digest: revisionDigest }).strict(),
  baseline: z.object({ run_id: revisionId, evidence_id: revisionId, review_id: revisionId,
    reviewer_run_id: revisionId, reviewer_evidence_id: revisionId,
    design: designPin.extend({ text: z.string().min(1).max(MAX_PRODUCT_DESIGN_REVISION_BYTES) }).strict(),
    research: z.object({ path: z.literal(".artoo/product/research.json"), checksum: revisionDigest,
      size: z.number().int().min(1).max(MAX_PRODUCT_DESIGN_REVISION_BYTES), source_task_id: revisionId,
      source_run_id: revisionId, evidence_id: revisionId }).strict(),
  }).strict(),
}).strict();
export type ProductDesignRevisionContextV1 = z.infer<typeof ProductDesignRevisionContextV1Schema>;

/** Hash the returned UTF-8 JSON with SHA-256. Runtime-specific hashing stays outside the shared domain. */
export function canonicalProductDesignRevisionContextV1(value: unknown): string {
  return canonicalReleaseJson(ProductDesignRevisionContextV1Schema.parse(value));
}

/** Emitted only by the node after raw comparison and all declared design cases actually pass. */
export const ProductDesignRevisionEvidenceV1Schema = z.object({
  version: z.literal(1), revision_id: revisionId, scope: z.literal("all-declared-workspace-design-cases"),
  descriptor_digest: revisionDigest, baseline_checksum: revisionDigest, revised_design: designPin,
}).strict();
export type ProductDesignRevisionEvidenceV1 = z.infer<typeof ProductDesignRevisionEvidenceV1Schema>;

/**
 * Compare raw JSON, before schema normalization can discard unknown fields or trim text.
 * The caller supplies a separately authenticated, hash-checked baseline and pinned research.
 * This structural check does not prove meaningful assertions, measured execution or review.
 */
export function validateAdditiveDesignRevision(baseline: unknown, candidate: unknown, research: unknown,
  request: unknown): string[] {
  const original = ProductDesignV2Schema.safeParse(baseline), revised = ProductDesignV2Schema.safeParse(candidate);
  const requirements = ProductResearchReportV2Schema.safeParse(research), intent = AdditiveDesignRevisionRequestV1Schema.safeParse(request);
  if (!original.success || !revised.success || !requirements.success || !intent.success) {
    return ["Additive design revision requires valid policy-v2 research, v2 designs and a versioned request."];
  }
  const errors: string[] = [];
  const priorHandoff = validateProductDevelopmentHandoff(requirements.data, original.data);
  if (priorHandoff.length) errors.push("The accepted design baseline does not match its pinned research.");
  errors.push(...validateProductDevelopmentHandoff(requirements.data, revised.data));
  const wanted = new Set(intent.data.requirement_criteria.map(criterionRefKey));
  const workspaceCriteria = new Set(requirements.data.measurement_plan.entries
    .filter(entry => entry.method === "workspace-check").map(criterionRefKey));
  if ([...wanted].some(ref => !workspaceCriteria.has(ref))) errors.push("A design revision may target only existing accepted workspace criteria.");
  // Parsed designs are objects, but equality must use their original, unnormalized values.
  const before = baseline as Record<string, unknown>, after = candidate as Record<string, unknown>;
  const beforeCases = before.validation_cases as unknown[], afterCases = after.validation_cases as unknown[];
  try {
    const fields = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "validation_cases"));
    if (canonicalReleaseJson(fields(before)) !== canonicalReleaseJson(fields(after))) {
      errors.push("A design revision must preserve every accepted non-case field.");
    }
    if (afterCases.length <= beforeCases.length) errors.push("A design revision must append at least one new validation case.");
    if (beforeCases.some((item, index) => index >= afterCases.length || canonicalReleaseJson(item) !== canonicalReleaseJson(afterCases[index]))) {
      errors.push("A design revision must preserve all accepted cases and their order exactly.");
    }
  } catch {
    errors.push("Design revision comparison requires finite, acyclic JSON values.");
  }
  const covered = new Set<string>();
  for (const item of revised.data.validation_cases.slice(original.data.validation_cases.length)) {
    if (item.method !== "workspace-check") {
      errors.push("A design revision may append only workspace validation cases.");
      continue;
    }
    for (const criterion of item.requirement_criteria) {
      const key = criterionRefKey(criterion);
      if (!wanted.has(key)) errors.push(`New case ${item.id} references a criterion outside the revision request.`);
      covered.add(key);
    }
  }
  if ([...wanted].some(ref => !covered.has(ref))) errors.push("Every requested criterion needs an appended validation case.");
  return [...new Set(errors)];
}
