import { z } from "zod";
import { ImportedValidationReleaseOriginV1Schema } from "./imported-validation-context.js";
import { ImportedRecoveryReleaseOriginV1Schema } from "./source-recovery-context.js";
import { ImportedCleanReleaseOriginV1Schema } from "./clean-validation-context.js";
import { ReleaseCapabilitiesV1Schema, ReleaseAcceptanceBindingV1Schema, ReleaseAcceptanceReceiptV1Schema,
  canonicalReleaseJson } from "./release-capabilities.js";

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const endpoint = z.string().url().max(4096).refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Expected an HTTP endpoint without credentials");

export const PRODUCT_RELEASE_RETRY_FEATURE_V1 = "product-release.retry.v1" as const;
export const PRODUCT_RELEASE_CLEAN_FEATURE_V1 = "product-release.clean-restart.v1" as const;
export const ProductReleaseRetryV1Schema = z.object({
  version: z.literal(1), root_release_id: id, previous_release_id: id,
  generation: z.number().int().min(1).max(2147483647), source_id: id,
  previous_request_digest: digest, previous_receipt_digest: digest,
  authorization: z.object({ event_id: id, goal_id: id, actor_user_id: id,
    attempt_index: z.number().int().min(1).max(2147483647) }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.generation === 1 && value.root_release_id !== value.previous_release_id)
    ctx.addIssue({ code: "custom", path: ["root_release_id"], message: "First retry must name its original release as predecessor" });
});
export type ProductReleaseRetryV1 = z.infer<typeof ProductReleaseRetryV1Schema>;

/** A projection of a live executor's private settled failure; JSON alone is not retry authority. */
export const ProductReleaseRetrySourceV1Schema = z.object({
  version: z.literal(1), source_id: id, closure: z.literal("local-release-settled.v1"),
  recovery: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("listener-closed"), active_release_id: z.null(), active_artifact_digest: z.null() }).strict(),
    z.object({ kind: z.literal("previous-restored"), active_release_id: id, active_artifact_digest: digest }).strict(),
  ]),
}).strict();
export type ProductReleaseRetrySourceV1 = z.infer<typeof ProductReleaseRetrySourceV1Schema>;

/** Local administrator configuration is selected by ID; never accept remote argv or paths. */
export const ProductReleaseRequestSchema = z.object({
  version: z.literal(1), release_id: id, goal_id: id, project_id: id, run_id: id,
  release_profile_id: id, verification_request_id: id, verification_profile_id: id,
  verification_profile_digest: digest, subject_digest: digest,
  acceptance_binding: ReleaseAcceptanceBindingV1Schema.optional(),
  imported_validation: ImportedValidationReleaseOriginV1Schema.optional(),
  imported_recovery: ImportedRecoveryReleaseOriginV1Schema.optional(),
  imported_clean: ImportedCleanReleaseOriginV1Schema.optional(),
  retry: ProductReleaseRetryV1Schema.optional(),
}).strict().superRefine((request, ctx) => {
  if (request.imported_clean && (request.imported_validation || request.imported_recovery
    || request.imported_clean.authorization.goal_id !== request.goal_id || request.imported_clean.interrupted_release_id === request.release_id
    || request.imported_clean.subject_digest !== request.subject_digest || !request.acceptance_binding))
    ctx.addIssue({ code: "custom", path: ["imported_clean"], message: "Clean publication requires its exclusive newly accepted source and configured release contract" });
  if (request.imported_clean && request.retry && (request.retry.root_release_id === request.imported_clean.interrupted_release_id
    || request.retry.previous_release_id === request.imported_clean.interrupted_release_id
    || request.retry.authorization.actor_user_id !== request.imported_clean.authorization.actor_user_id
    || request.retry.authorization.event_id === request.imported_clean.authorization.event_id
    || request.retry.authorization.attempt_index <= request.imported_clean.authorization.attempt_index))
    ctx.addIssue({ code: "custom", path: ["retry"], message: "Clean publication retry requires a separate bounded decision after its own actual closed failure" });
  if (request.imported_recovery && (request.imported_validation || request.imported_recovery.authorization.goal_id !== request.goal_id || request.imported_recovery.recovery_of_release_id === request.release_id || request.imported_recovery.subject_digest !== request.subject_digest || !request.acceptance_binding))
    ctx.addIssue({ code: "custom", path: ["imported_recovery"], message: "Recovery publication requires its exclusive newly reviewed source and configured acceptance binding" });
  if (request.imported_recovery && request.retry && (request.retry.root_release_id === request.imported_recovery.recovery_of_release_id
    || request.retry.previous_release_id === request.imported_recovery.recovery_of_release_id
    || request.retry.authorization.actor_user_id !== request.imported_recovery.authorization.actor_user_id
    || request.retry.authorization.event_id === request.imported_recovery.authorization.event_id
    || request.retry.authorization.attempt_index <= request.imported_recovery.authorization.attempt_index))
    ctx.addIssue({ code: "custom", path: ["retry"], message: "Recovery source retry must follow its fresh publication with a separate bounded decision" });
  if (request.retry && (request.retry.authorization.goal_id !== request.goal_id
    || request.retry.previous_release_id === request.release_id || request.retry.root_release_id === request.release_id))
    ctx.addIssue({ code: "custom", path: ["retry"], message: "A retry must preserve its goal and create a distinct successor release" });
  if (request.imported_validation && (request.imported_validation.subject_digest !== request.subject_digest || !request.acceptance_binding))
    ctx.addIssue({ code: "custom", path: ["imported_validation"], message: "Imported validation release requires its exact final subject and configured acceptance binding" });
  const binding = request.acceptance_binding?.release_binding;
  if (binding && (binding.release_profile_id !== request.release_profile_id || binding.project_id !== request.project_id
    || binding.verification_profile_id !== request.verification_profile_id || binding.verification_profile_digest !== request.verification_profile_digest)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["acceptance_binding"], message: "Release acceptance must match the request's exact profile and project" });
  }
});
export type ProductReleaseRequest = z.infer<typeof ProductReleaseRequestSchema>;
export function canonicalProductReleaseRequest(request: ProductReleaseRequest): string {
  return canonicalReleaseJson(ProductReleaseRequestSchema.parse(request));
}
export function productReleaseRequestsEqual(left: ProductReleaseRequest, right: ProductReleaseRequest): boolean {
  return canonicalProductReleaseRequest(left) === canonicalProductReleaseRequest(right);
}

export const ReleaseProfileAdvertisementSchema = z.object({
  profile_id: id, project_id: id, workspace_root: z.string().min(1).max(4096),
  verification_profile_id: id, target_kind: z.literal("static_site"),
  capabilities: ReleaseCapabilitiesV1Schema.optional(),
}).strict().superRefine((profile, ctx) => {
  const binding = profile.capabilities?.binding;
  if (binding && (binding.release_profile_id !== profile.profile_id || binding.project_id !== profile.project_id
    || binding.workspace_root !== profile.workspace_root || binding.verification_profile_id !== profile.verification_profile_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: "Release advertisement and capability binding differ" });
  }
});
export const ReleaseProfileAdvertisementsSchema = z.array(ReleaseProfileAdvertisementSchema).max(64)
  .refine((profiles) => new Set(profiles.map((profile) => profile.profile_id)).size === profiles.length, "Duplicate release profile ID");
export type ReleaseProfileAdvertisement = z.infer<typeof ReleaseProfileAdvertisementSchema>;

const ReleaseHealthCheckSchema = z.object({
  path: z.string().min(1).max(1024), status_code: z.number().int().min(100).max(599).nullable(),
  body_digest: digest.nullable(), passed: z.boolean(), checked_at: z.string().datetime(),
}).strict().refine((check) => !check.passed || (check.status_code === 200 && check.body_digest !== null), {
  message: "A successful health measurement requires HTTP 200 and a measured response body",
});

/** Node-owned receipt: deployment is successful only after the actual endpoint passes health checks. */
export const ProductReleaseReceiptSchema = z.object({
  request: ProductReleaseRequestSchema,
  release_profile_digest: digest,
  artifact_digest: digest.nullable(),
  outcome: z.enum(["published", "rolled_back", "failed"]),
  endpoint: endpoint.nullable(),
  previous_release_id: id.nullable(),
  health_checks: z.array(ReleaseHealthCheckSchema).max(32),
  recovery_checks: z.array(ReleaseHealthCheckSchema).max(32).optional(),
  reason: z.string().max(2000).optional(),
  acceptance: ReleaseAcceptanceReceiptV1Schema.optional(),
  retry_source: ProductReleaseRetrySourceV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.retry_source) {
    const recovery = value.retry_source.recovery;
    if (value.outcome === "published")
      ctx.addIssue({ code: "custom", path: ["retry_source"], message: "A successful publication cannot authorize a failed-attempt retry" });
    if (recovery.kind === "previous-restored" && (recovery.active_release_id !== value.previous_release_id
      || recovery.active_release_id === value.request.release_id || !value.recovery_checks?.length || value.recovery_checks.some(check => !check.passed)))
      ctx.addIssue({ code: "custom", path: ["retry_source", "recovery"], message: "Restored retry source requires the exact previous version and successful recovery measurements" });
  }
  const binding = value.request.acceptance_binding;
  if (binding && value.release_profile_digest !== binding.release_binding.release_profile_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["release_profile_digest"], message: "Publication profile differs from its fixed acceptance binding" });
  }
  if (value.acceptance && (!binding || value.outcome !== "published"
    || canonicalReleaseJson(value.acceptance.settled_criteria) !== canonicalReleaseJson(binding.criteria))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["acceptance"], message: "Only a matching published receipt can settle the exact release criteria" });
  }
  if (binding && value.outcome === "published" && !value.acceptance) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["acceptance"], message: "Bound publication requires a release acceptance receipt" });
  }
  if (value.outcome === "published" && (value.artifact_digest !== value.request.subject_digest || !value.endpoint
    || !value.health_checks.length || value.health_checks.some((check) => !check.passed))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Publication requires the verified immutable artifact and successful endpoint checks" });
  }
  if (value.outcome === "rolled_back" && value.previous_release_id !== null
    && (!value.recovery_checks?.length || value.recovery_checks.some((check) => !check.passed))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recovery_checks"], message: "Rollback requires successful measurements of the previous release" });
  }
});
export type ProductReleaseReceipt = z.infer<typeof ProductReleaseReceiptSchema>;

/** Later measurements are separate from the immutable publication receipt. */
export const ProductReleaseHealthReportSchema = z.object({
  version: z.literal(1), event_id: id, sequence: z.number().int().min(1).max(2147483647),
  request: ProductReleaseRequestSchema, release_profile_digest: digest, artifact_digest: digest,
  state: z.enum(["healthy", "degraded", "rolled_back", "unavailable"]),
  active_release_id: id.nullable(), active_artifact_digest: digest.nullable(),
  consecutive_failures: z.number().int().min(0).max(2147483647),
  health_checks: z.array(ReleaseHealthCheckSchema).min(1).max(32),
  recovery_checks: z.array(ReleaseHealthCheckSchema).max(32),
  checked_at: z.string().datetime(), reason: z.string().min(1).max(2000).optional(),
}).strict().superRefine((value, ctx) => {
  const reject = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (value.request.acceptance_binding && value.release_profile_digest !== value.request.acceptance_binding.release_binding.release_profile_digest) {
    reject("release_profile_digest", "Health observations require the fixed release acceptance profile");
  }
  if (value.artifact_digest !== value.request.subject_digest) reject("artifact_digest", "Health reports must bind the verified immutable artifact");
  for (const key of ["health_checks", "recovery_checks"] as const) {
    if (new Set(value[key].map((check) => check.path)).size !== value[key].length) reject(key, "Health measurement paths must be unique");
    if (value[key].some((check) => Date.parse(check.checked_at) > Date.parse(value.checked_at))) reject(key, "Measurements cannot follow the report time");
  }
  if (value.state === "healthy" || value.state === "degraded") {
    if (value.active_release_id !== value.request.release_id || value.active_artifact_digest !== value.artifact_digest) {
      reject("active_release_id", "The monitored release must remain active until recovery");
    }
    if (value.recovery_checks.length) reject("recovery_checks", "An active monitored release has no recovery measurements");
  }
  if (value.state === "healthy") {
    if (value.consecutive_failures !== 0 || value.health_checks.some((check) => !check.passed)) reject("state", "Healthy requires successful measurements and no consecutive failures");
  } else if (value.consecutive_failures < 1 || value.health_checks.every((check) => check.passed)) {
    reject("state", "Unhealthy reports require a failed measurement and positive failure count");
  }
  if (value.state === "rolled_back") {
    if (value.active_release_id === null || value.active_release_id === value.request.release_id || value.active_artifact_digest === null
      || !value.recovery_checks.length || value.recovery_checks.some((check) => !check.passed)) {
      reject("state", "Rollback requires another active immutable version and successful recovery measurements");
    }
  }
  if (value.state === "unavailable" && (value.active_release_id !== null || value.active_artifact_digest !== null)) {
    reject("active_release_id", "Unavailable publication must have no active version");
  }
});
export type ProductReleaseHealthReport = z.infer<typeof ProductReleaseHealthReportSchema>;

export const ProductReleaseSchema = z.object({
  id, goal_id: id, project_id: id, computer_id: id, run_id: id, evidence_id: id,
  status: z.enum(["queued", "published", "rolled_back", "failed", "interrupted"]),
  request: ProductReleaseRequestSchema, receipt: ProductReleaseReceiptSchema.nullable(),
  health: ProductReleaseHealthReportSchema.nullish(),
  interruption: z.object({ version: z.literal(1), recovery_id: id, settlement_event_id: id,
    checkpoint_digest: digest }).strict().nullish(),
  clean_interruption: z.object({ version: z.literal(1), clean_generation_id: id, settlement_event_id: id,
    checkpoint_digest: digest }).strict().nullish(),
  created_at: z.string(), updated_at: z.string(),
}).superRefine((value, ctx) => {
  if ((value.status === "interrupted") !== !!(value.interruption || value.clean_interruption)
    || value.interruption && value.clean_interruption || value.status === "interrupted" && value.receipt !== null)
    ctx.addIssue({ code: "custom", path: ["interruption"], message: "Interrupted publication requires exact recovery settlement and retains its absent receipt" });
  if (value.request.acceptance_binding && value.receipt && !productReleaseRequestsEqual(value.request, value.receipt.request)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receipt"], message: "Receipt must bind the complete product release request" });
  }
  if (!value.health) return;
  if (value.status !== "published" || value.receipt?.outcome !== "published" || value.id !== value.health.request.release_id
    || !productReleaseRequestsEqual(value.request, value.health.request)
    || value.receipt.release_profile_digest !== value.health.release_profile_digest || value.receipt.artifact_digest !== value.health.artifact_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["health"], message: "Health observations must belong to this confirmed immutable publication" });
  }
});
export type ProductRelease = z.infer<typeof ProductReleaseSchema>;
