import { z } from "zod";
import { AllowedBrowserKeySchema, BrowserActionV2Schema, BrowserViewportV2Schema } from "./browser-program.js";
import { BrowserActionV3Schema } from "./browser-program-v3.js";
import { StorageFaultCapabilitiesV1Schema } from "./storage-fault.js";
import { StoragePreconditionCapabilitiesV1Schema } from "./storage-precondition.js";
import { MeasurementPlanPolicySchema } from "./measurement-plan.js";
import { ApplicationCapabilitiesV1Schema } from "./application-development.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(128);
const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;

export const StaticWebActionSchema = z.enum(["navigate", "reload", "click", "fill", "check",
  "assert_visible", "assert_hidden", "assert_text", "assert_value", "assert_count"]);
export const UnavailableWebMeasurementSchema = z.enum(["keyboard-navigation", "multiple-pages",
  "storage-exception-injection", "native-screen-reader", "browser-zoom"]);

/** Configured measurement limits, never evidence that a product has passed them. */
export const StaticWebCapabilitiesV1Schema = z.object({
  version: z.literal(1), kind: z.literal("static-web"), claim: z.literal("configured"), browser_steps_version: z.literal(1),
  actions: z.array(StaticWebActionSchema).min(1).max(10).refine(unique, "Duplicate browser actions"),
  viewports: z.array(z.object({ id: identifier, width: z.number().int().min(240).max(8192), height: z.literal(900) }).strict()).min(1).max(8)
    .refine((items) => unique(items.map((item) => item.id)) && unique(items.map((item) => item.width)), "Duplicate viewports"),
  stage_policy: z.object({ research: z.literal("no-browser"), design: z.enum(["prototype-only", "declared-cases"]),
    implementation: z.literal("declared-cases"), validation: z.literal("declared-cases") }).strict(),
  screenshots: z.literal("final-visible-viewport"),
  pages: z.object({ max_pages: z.literal(1), same_browser_context: z.literal(true) }).strict(),
  limits: z.object({ max_cases: z.literal(50), max_steps_per_case: z.literal(100),
    action_timeout_ms: z.number().int().min(500).max(10000) }).strict(),
  checks: z.array(z.enum(["horizontal-overflow", "dom-control-name-heuristic"])).max(2).refine(unique, "Duplicate browser checks"),
  unavailable: z.array(UnavailableWebMeasurementSchema).max(5).refine(unique, "Duplicate unavailable measurements"),
}).strict();
export type StaticWebCapabilitiesV1 = z.infer<typeof StaticWebCapabilitiesV1Schema>;

/** Version 2 executes only explicitly bound v2 programs; old steps are never reinterpreted. */
export const StaticWebCapabilitiesV2Schema = StaticWebCapabilitiesV1Schema.extend({
  version: z.literal(2), browser_steps_version: z.literal(2), legacy_browser_steps: z.literal("rejected"),
  actions: z.array(BrowserActionV2Schema).min(1).max(15).refine(unique, "Duplicate browser actions"),
  viewports: z.array(BrowserViewportV2Schema).min(1).max(8)
    .refine((items) => unique(items.map((item) => item.id)), "Duplicate viewport IDs"),
  device_scale_factor: z.literal(1),
  keyboard: z.object({ allowed_keys: z.array(AllowedBrowserKeySchema).min(1).max(13).refine(unique, "Duplicate allowed keys"),
    typing_max_length: z.literal(1000), focus_setup: z.literal("programmatic"), focus_scope: z.literal("main-frame-dom") }).strict(),
}).strict();
export type StaticWebCapabilitiesV2 = z.infer<typeof StaticWebCapabilitiesV2Schema>;
/** Version 3 admits only bound v3 programs and counts every created page for the whole case. */
export const StaticWebCapabilitiesV3Schema = StaticWebCapabilitiesV2Schema.extend({
  version: z.literal(3), browser_steps_version: z.literal(3),
  storage_fault: StorageFaultCapabilitiesV1Schema.optional(),
  storage_precondition: StoragePreconditionCapabilitiesV1Schema.optional(),
  actions: z.array(BrowserActionV3Schema).min(1).max(17).refine(unique, "Duplicate browser actions"),
  screenshots: z.literal("each-created-page-visible-viewport"),
  pages: z.object({ max_pages: z.literal(3), counting: z.literal("cumulative-created"), same_origin: z.literal(true),
    same_browser_context: z.literal(true), name_reuse: z.literal("rejected"), main_close: z.literal("rejected") }).strict(),
  unavailable: z.array(z.enum(["storage-exception-injection", "native-screen-reader", "browser-zoom"])).max(3)
    .refine(unique, "Duplicate unavailable measurements"),
}).strict();
export type StaticWebCapabilitiesV3 = z.infer<typeof StaticWebCapabilitiesV3Schema>;
export const StaticWebCapabilitiesSchema = z.discriminatedUnion("version", [StaticWebCapabilitiesV1Schema, StaticWebCapabilitiesV2Schema, StaticWebCapabilitiesV3Schema]);
export type StaticWebCapabilities = z.infer<typeof StaticWebCapabilitiesSchema>;

const checkBinding = z.object({ command_id: identifier, config_digest: digest, contract_digest: digest }).strict();
const uniqueCommands = (checks: { command_id: string }[]) => unique(checks.map((check) => check.command_id));
const capabilitiesShape = {
  version: z.literal(1), profile_digest: digest,
  application: ApplicationCapabilitiesV1Schema.optional(),
  measurement_plan_policy: MeasurementPlanPolicySchema.optional(),
  checks: z.array(checkBinding.extend({ contract: StaticWebCapabilitiesSchema }).strict()).min(1).max(32)
    .refine(uniqueCommands, "Duplicate capability check IDs"),
};

/** Derived by the authenticated execution node from its protected local configuration. */
const applicationPolicy = (value: { application?: unknown; measurement_plan_policy?: unknown; checks: { contract: { version: number } }[] }, ctx: z.RefinementCtx) => {
  if (value.application && value.measurement_plan_policy) ctx.addIssue({ code: z.ZodIssueCode.custom,
    path: ["measurement_plan_policy"], message: "Application development cannot claim the static measurement-plan contract" });
  if (value.application && value.checks.some(check => check.contract.version !== 3)) ctx.addIssue({ code: z.ZodIssueCode.custom,
    path: ["checks"], message: "Application development requires version-3 browser program capabilities" });
};
export const VerificationCapabilitiesSchema = z.object(capabilitiesShape).strict().superRefine(applicationPolicy);
export type VerificationCapabilities = z.infer<typeof VerificationCapabilitiesSchema>;
export const VerificationCapabilitiesContextSchema = z.object({ ...capabilitiesShape, profile_id: identifier }).strict().superRefine(applicationPolicy);
export type VerificationCapabilitiesContext = z.infer<typeof VerificationCapabilitiesContextSchema>;

/** The selected public snapshot is checked against the node's local prepared profile at admission. */
export const VerificationCapabilityBindingSchema = z.object({
  version: z.literal(1), profile_digest: digest,
  checks: z.array(checkBinding).min(1).max(32).refine(uniqueCommands, "Duplicate capability binding check IDs"),
}).strict();
export type VerificationCapabilityBinding = z.infer<typeof VerificationCapabilityBindingSchema>;

/** A single protected command reports this binding; the node still owns final verification. */
export const StaticWebCapabilityBindingSchema = checkBinding.extend({ version: z.literal(1), profile_digest: digest }).strict();
export type StaticWebCapabilityBinding = z.infer<typeof StaticWebCapabilityBindingSchema>;
