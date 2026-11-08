import { z } from "zod";
import { ApplicationVerificationObservationV1Schema } from "./application-development.js";
import { MeasurementPlanSummarySchema } from "./measurement-plan.js";
import { DevelopmentStageSchema } from "./product-development.js";
import { StaticWebCapabilityBindingSchema } from "./verification-capabilities.js";
import { BrowserViewportV2Schema } from "./browser-program.js";
import { MAX_BROWSER_OPERATION_TRACE_BYTES } from "./browser-operation-trace.js";
import { BrowserCaptureV3Schema } from "./browser-operation-trace-v3.js";
import { StorageFaultReportV1Schema } from "./storage-fault.js";
import { StoragePreconditionReportV1Schema } from "./storage-precondition.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(128);
const opaqueReference = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const browserCase = z.object({
  case_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  viewport: z.number().int().min(1).max(8192),
  assertions: z.number().int().min(0).max(100),
  screenshot_digest: digest,
}).strict();
const uniqueCases = (cases: { case_id: string; viewport: number }[]) =>
  new Set(cases.map((item) => `${item.case_id}:${item.viewport}`)).size === cases.length;

/** Output of the explicitly configured protected browser verifier, not model output. */
export const StaticWebAcceptanceReportV1Schema = z.object({
  version: z.literal(1), format: z.literal("static-web-acceptance.v1"), stage: DevelopmentStageSchema,
  passed: z.literal(true), requirements: z.number().int().min(0).max(100),
  capability_binding: StaticWebCapabilityBindingSchema.optional(),
  cases: z.array(browserCase).max(1600).refine(uniqueCases, "Browser case and viewport pairs must be unique"),
}).strict();
export type StaticWebAcceptanceReportV1 = z.infer<typeof StaticWebAcceptanceReportV1Schema>;

/** Measured execution scope supplies review evidence; it never replaces the verifier receipt. */
export const VerificationObservationV1Schema = z.object({
  version: z.literal(1), format: z.literal("static-web-acceptance.v1"),
  scope: z.enum(["preview", "final"]), stage: DevelopmentStageSchema,
  capability_binding: StaticWebCapabilityBindingSchema.optional(),
  cases: z.array(browserCase.extend({ screenshot_ref: opaqueReference.optional() })).max(1600)
    .refine(uniqueCases, "Browser case and viewport pairs must be unique"),
  evidence_bundle: z.object({
    bundle_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), manifest_digest: digest,
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  const refs = value.cases.flatMap((item) => item.screenshot_ref ? [item.screenshot_ref] : []);
  if ((value.evidence_bundle && refs.length !== value.cases.length) || (!value.evidence_bundle && refs.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence_bundle"], message: "Screenshot references require a complete node evidence bundle" });
  }
  if (new Set(refs).size !== refs.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cases"], message: "Screenshot references must be unique" });
  }
});
export type VerificationObservationV1 = z.infer<typeof VerificationObservationV1Schema>;

const browserCaptureV2 = z.object({ page_id: z.literal("main"), screenshot_digest: digest }).strict();
const browserCaseV2 = z.object({
  case_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/), viewport: BrowserViewportV2Schema,
  program_digest: digest, assertions: z.number().int().min(0).max(100), operation_count: z.number().int().min(1).max(100),
  trace_digest: digest, trace_size: z.number().int().min(1).max(MAX_BROWSER_OPERATION_TRACE_BYTES),
  captures: z.array(browserCaptureV2).length(1),
}).strict();
const uniqueCasesV2 = (cases: { case_id: string; viewport: { id: string } }[]) =>
  new Set(cases.map((item) => `${item.case_id}:${item.viewport.id}`)).size === cases.length;
const validAssertionCounts = (cases: { assertions: number; operation_count: number }[]) =>
  cases.every((item) => item.assertions <= item.operation_count);

export const StaticWebAcceptanceReportV2Schema = z.object({
  version: z.literal(2), format: z.literal("static-web-acceptance.v2"), stage: DevelopmentStageSchema,
  passed: z.literal(true), requirements: z.number().int().min(0).max(100), device_scale_factor: z.literal(1),
  capability_binding: StaticWebCapabilityBindingSchema,
  cases: z.array(browserCaseV2).max(400).refine(uniqueCasesV2, "Browser case and viewport IDs must be unique")
    .refine(validAssertionCounts, "Assertions exceed executed operations"),
}).strict();
export type StaticWebAcceptanceReportV2 = z.infer<typeof StaticWebAcceptanceReportV2Schema>;
const browserCaseV3 = browserCaseV2.extend({ captures: z.array(BrowserCaptureV3Schema).min(1).max(3),
  storage_fault: StorageFaultReportV1Schema.optional(), storage_precondition: StoragePreconditionReportV1Schema.optional() }).strict();
const validCapturesV3 = (cases: z.infer<typeof browserCaseV3>[]) => cases.every((item) => {
  const first = item.captures[0];
  const closes = item.captures.flatMap((capture) => capture.timing.kind === "before-close" ? [capture.timing.step_index] : []);
  return first?.page_id === "main" && first.timing.kind === "case-end"
    && (!item.storage_fault || item.captures.length === 1)
    && (!item.storage_precondition || item.storage_precondition.source.case_id === item.case_id
      && item.storage_precondition.program_digest === item.program_digest
      && item.storage_precondition.ui_assertion_steps.length <= item.assertions
      && item.storage_precondition.ui_assertion_steps.every(step => step < item.operation_count))
    && new Set(item.captures.map((capture) => capture.page_id)).size === item.captures.length
    && new Set(closes).size === closes.length && closes.every((index) => index > 0 && index < item.operation_count);
});
export const StaticWebAcceptanceReportV3Schema = StaticWebAcceptanceReportV2Schema.extend({
  version: z.literal(3), format: z.literal("static-web-acceptance.v3"),
  cases: z.array(browserCaseV3).max(400).refine(uniqueCasesV2, "Browser case and viewport IDs must be unique")
    .refine(validAssertionCounts, "Assertions exceed executed operations")
    .refine(validCapturesV3, "Captures require unique pages with main first and valid close positions"),
}).strict();
export type StaticWebAcceptanceReportV3 = z.infer<typeof StaticWebAcceptanceReportV3Schema>;
export const StaticWebAcceptanceReportSchema = z.discriminatedUnion("version", [StaticWebAcceptanceReportV1Schema, StaticWebAcceptanceReportV2Schema, StaticWebAcceptanceReportV3Schema]);
export type StaticWebAcceptanceReport = z.infer<typeof StaticWebAcceptanceReportSchema>;

/** V2 evidence always carries sealed trace and image grants, even for an empty research bundle. */
export const VerificationObservationV2Schema = z.object({
  version: z.literal(2), format: z.literal("static-web-acceptance.v2"), scope: z.enum(["preview", "final"]),
  stage: DevelopmentStageSchema, device_scale_factor: z.literal(1), capability_binding: StaticWebCapabilityBindingSchema,
  cases: z.array(browserCaseV2.extend({ trace_ref: opaqueReference,
    captures: z.array(browserCaptureV2.extend({ screenshot_ref: opaqueReference }).strict()).length(1),
  }).strict()).max(400).refine(uniqueCasesV2, "Browser case and viewport IDs must be unique")
    .refine(validAssertionCounts, "Assertions exceed executed operations"),
  evidence_bundle: z.object({ bundle_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), manifest_digest: digest }).strict(),
}).strict().superRefine((value, ctx) => {
  const refs = value.cases.flatMap((item) => [item.trace_ref, ...item.captures.map((capture) => capture.screenshot_ref)]);
  if (new Set(refs).size !== refs.length || refs.includes(value.evidence_bundle.bundle_id)) ctx.addIssue({
    code: z.ZodIssueCode.custom, path: ["cases"], message: "Trace and image references must be unique within their evidence bundle",
  });
});
export type VerificationObservationV2 = z.infer<typeof VerificationObservationV2Schema>;

/** V3 adds a sealed capture for every created page, including pages closed during the case. */
export const VerificationObservationV3Schema = z.object({
  version: z.literal(3), format: z.literal("static-web-acceptance.v3"), scope: z.enum(["preview", "final"]),
  stage: DevelopmentStageSchema, device_scale_factor: z.literal(1), capability_binding: StaticWebCapabilityBindingSchema,
  cases: z.array(browserCaseV3.extend({ trace_ref: opaqueReference,
    captures: z.array(BrowserCaptureV3Schema.extend({ screenshot_ref: opaqueReference }).strict()).min(1).max(3),
  }).strict()).max(400).refine(uniqueCasesV2, "Browser case and viewport IDs must be unique")
    .refine(validAssertionCounts, "Assertions exceed executed operations")
    .refine(validCapturesV3, "Captures require unique pages with main first and valid close positions"),
  evidence_bundle: z.object({ bundle_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), manifest_digest: digest }).strict(),
}).strict().superRefine((value, ctx) => {
  const refs = value.cases.flatMap((item) => [item.trace_ref, ...item.captures.map((capture) => capture.screenshot_ref)]);
  if (new Set(refs).size !== refs.length || refs.includes(value.evidence_bundle.bundle_id)) ctx.addIssue({
    code: z.ZodIssueCode.custom, path: ["cases"], message: "Trace and image references must be unique within their evidence bundle",
  });
});
export type VerificationObservationV3 = z.infer<typeof VerificationObservationV3Schema>;
// Each strict branch has distinct literal version and format, with its own refinement rules.
export const VerificationObservationSchema = z.union([VerificationObservationV1Schema, VerificationObservationV2Schema, VerificationObservationV3Schema]);
export type VerificationObservation = z.infer<typeof VerificationObservationSchema>;

export const MAX_VERIFICATION_OBSERVATIONS_LENGTH = 1024 * 1024;

/** Missing observations mean unknown execution scope, including for legacy verifier profiles. */
export const ReviewVerificationContextSchema = z.object({
  version: z.literal(1), request_id: identifier, profile_id: identifier, profile_digest: digest,
  application: ApplicationVerificationObservationV1Schema.optional(),
  measurement_plan: MeasurementPlanSummarySchema.optional(),
  checks: z.array(z.object({
    id: identifier, output_digest: digest, observation: VerificationObservationSchema.optional(),
  }).strict()).max(64),
}).strict().superRefine((value, ctx) => {
  if (value.application && (value.application.request_id !== value.request_id || value.measurement_plan)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["application"], message: "Application review observation requires its original request without a static measurement plan" });
  }
  if (value.measurement_plan && (value.measurement_plan.scope !== "final" || value.measurement_plan.used_checks.some(used => {
    const binding = value.checks.find(check => check.id === used.command_id)?.observation?.capability_binding;
    return !binding || binding.config_digest !== used.config_digest || binding.contract_digest !== used.contract_digest;
  }))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["measurement_plan"], message: "Review requires a final declared-feasibility summary bound to its observed checks" });
  if (value.measurement_plan?.version === 2 && value.measurement_plan.pending_release.some(ref =>
    ref.release_binding.verification_profile_id !== value.profile_id || ref.release_binding.verification_profile_digest !== value.profile_digest)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["measurement_plan"], message: "Review pending release criteria must bind the measured verifier" });
  }
  if (new Set(value.checks.map((check) => check.id)).size !== value.checks.length
    || value.checks.some((check) => check.observation?.scope === "preview")
    || JSON.stringify(value.checks.flatMap((check) => check.observation ? [check.observation] : [])).length > MAX_VERIFICATION_OBSERVATIONS_LENGTH) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks"], message: "Review requires bounded, unique final verification observations" });
  }
  value.checks.forEach((check, index) => {
    const binding = check.observation?.capability_binding;
    if (binding && (binding.command_id !== check.id || binding.profile_digest !== value.profile_digest)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", index, "observation", "capability_binding"],
        message: "Review capability binding must match its measured command and profile" });
    }
  });
});
