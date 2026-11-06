import { z } from "zod";
import { ReleaseCapabilitiesV1Schema, ReleaseAcceptanceBindingV1Schema, ReleaseAcceptanceReceiptV1Schema,
  canonicalReleaseJson } from "./release-capabilities.js";

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const endpoint = z.string().url().max(4096).refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Expected an HTTP endpoint without credentials");

/** Local administrator configuration is selected by ID; never accept remote argv or paths. */
export const ProductReleaseRequestSchema = z.object({
  version: z.literal(1), release_id: id, goal_id: id, project_id: id, run_id: id,
  release_profile_id: id, verification_request_id: id, verification_profile_id: id,
  verification_profile_digest: digest, subject_digest: digest,
  acceptance_binding: ReleaseAcceptanceBindingV1Schema.optional(),
}).strict().superRefine((request, ctx) => {
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
}).strict().superRefine((value, ctx) => {
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
  status: z.enum(["queued", "published", "rolled_back", "failed"]),
  request: ProductReleaseRequestSchema, receipt: ProductReleaseReceiptSchema.nullable(),
  health: ProductReleaseHealthReportSchema.nullish(),
  created_at: z.string(), updated_at: z.string(),
}).superRefine((value, ctx) => {
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
