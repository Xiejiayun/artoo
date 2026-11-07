import { isAbsolute } from "node:path";
import { z } from "zod";
import { BrowserViewportV2Schema, StaticWebCapabilityBindingSchema, StorageFaultOptionsV1Schema, StoragePreconditionOptionsV1Schema,
  type BrowserViewportV2, type StorageFaultOptionsV1, type StoragePreconditionOptionsV1 } from "@artoo/domain";

/** Protected, operator-supplied configuration. Legacy callers keep their original optional shape. */
export interface WebAcceptanceOptionsV1 {
  windows_browser_process?: { version: 1 };
  browser_executable?: string;
  evidence_root?: string;
  action_timeout_ms?: number;
  viewports?: number[];
  design_capture_cases?: boolean;
}
export interface WebAcceptanceOptionsV2 extends Omit<WebAcceptanceOptionsV1, "viewports"> {
  browser_program: { version: 2; viewports: BrowserViewportV2[] };
}
export interface WebAcceptanceOptionsV3 extends Omit<WebAcceptanceOptionsV1, "viewports"> {
  browser_program: { version: 3; viewports: BrowserViewportV2[] };
  storage_fault?: StorageFaultOptionsV1;
  storage_precondition?: StoragePreconditionOptionsV1;
}
export type WebAcceptanceOptions = WebAcceptanceOptionsV1 | WebAcceptanceOptionsV2 | WebAcceptanceOptionsV3;
export const STATIC_WEB_VIEWPORT_HEIGHT = 900;
export const STATIC_WEB_MAX_CASES = 50;
export const STATIC_WEB_MAX_STEPS = 100;
export const STATIC_WEB_MAX_CONFIG_BYTES = 16 * 1024;
export const STATIC_WEB_FULL_PAGE_SCREENSHOT = false;
export const STATIC_WEB_DEFAULT_TIMEOUT = 5000;
export const STATIC_WEB_DEFAULT_VIEWPORTS = Object.freeze([1280, 390]);

const protectedPath = z.string().min(1).max(4096)
  .refine((value) => isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value), "Expected an absolute protected path");
const optionsShape = {
  windows_browser_process: z.object({ version: z.literal(1) }).strict().optional(),
  browser_executable: protectedPath.optional(),
  evidence_root: protectedPath.optional(),
  action_timeout_ms: z.number().int().min(500).max(10000),
  viewports: z.array(z.number().int().min(240).max(8192)).min(1).max(8)
    .refine((values) => new Set(values).size === values.length, "Duplicate protected viewports"),
  design_capture_cases: z.boolean(),
};
export const NormalizedWebAcceptanceOptionsV1Schema = z.object(optionsShape).strict();
export type NormalizedWebAcceptanceOptionsV1 = z.infer<typeof NormalizedWebAcceptanceOptionsV1Schema>;
const inputV1Schema = z.object({ ...optionsShape,
  action_timeout_ms: optionsShape.action_timeout_ms.default(STATIC_WEB_DEFAULT_TIMEOUT),
  viewports: optionsShape.viewports.default([...STATIC_WEB_DEFAULT_VIEWPORTS]),
  design_capture_cases: optionsShape.design_capture_cases.default(false),
}).strict();
const programOptions = z.object({ version: z.literal(2), viewports: z.array(BrowserViewportV2Schema).min(1).max(8)
  .refine((viewports) => new Set(viewports.map((viewport) => viewport.id)).size === viewports.length, "Duplicate protected viewport IDs") }).strict();
export const NormalizedWebAcceptanceOptionsV2Schema = z.object({
  windows_browser_process: optionsShape.windows_browser_process,
  browser_executable: optionsShape.browser_executable, evidence_root: optionsShape.evidence_root,
  action_timeout_ms: optionsShape.action_timeout_ms, design_capture_cases: optionsShape.design_capture_cases,
  browser_program: programOptions,
}).strict();
export type NormalizedWebAcceptanceOptionsV2 = z.infer<typeof NormalizedWebAcceptanceOptionsV2Schema>;
const inputV2Schema = NormalizedWebAcceptanceOptionsV2Schema.extend({
  action_timeout_ms: optionsShape.action_timeout_ms.default(STATIC_WEB_DEFAULT_TIMEOUT),
  design_capture_cases: optionsShape.design_capture_cases.default(false),
});
export const NormalizedWebAcceptanceOptionsV3Schema = NormalizedWebAcceptanceOptionsV2Schema.extend({
  browser_program: programOptions.extend({ version: z.literal(3) }).strict(),
  storage_fault: StorageFaultOptionsV1Schema.optional(),
  storage_precondition: StoragePreconditionOptionsV1Schema.optional(),
}).strict();
export type NormalizedWebAcceptanceOptionsV3 = z.infer<typeof NormalizedWebAcceptanceOptionsV3Schema>;
const inputV3Schema = NormalizedWebAcceptanceOptionsV3Schema.extend({
  action_timeout_ms: optionsShape.action_timeout_ms.default(STATIC_WEB_DEFAULT_TIMEOUT),
  design_capture_cases: optionsShape.design_capture_cases.default(false),
});
export const NormalizedWebAcceptanceOptionsSchema = z.union([NormalizedWebAcceptanceOptionsV1Schema, NormalizedWebAcceptanceOptionsV2Schema, NormalizedWebAcceptanceOptionsV3Schema]);
export type NormalizedWebAcceptanceOptions = z.infer<typeof NormalizedWebAcceptanceOptionsSchema>;
const inputSchema = z.union([inputV1Schema, inputV2Schema, inputV3Schema]);

export function isV2WebAcceptanceOptions(options: NormalizedWebAcceptanceOptions): options is NormalizedWebAcceptanceOptionsV2;
export function isV2WebAcceptanceOptions(options: WebAcceptanceOptions): options is WebAcceptanceOptionsV2;
export function isV2WebAcceptanceOptions(options: WebAcceptanceOptions): boolean {
  return "browser_program" in options && options.browser_program?.version === 2;
}
export function isV3WebAcceptanceOptions(options: NormalizedWebAcceptanceOptions): options is NormalizedWebAcceptanceOptionsV3;
export function isV3WebAcceptanceOptions(options: WebAcceptanceOptions): options is WebAcceptanceOptionsV3;
export function isV3WebAcceptanceOptions(options: WebAcceptanceOptions): boolean {
  return "browser_program" in options && options.browser_program?.version === 3;
}

/** Opt-in profiles only: both preparation and execution use these exact defaults and constraints. */
export function normalizeWebAcceptanceOptions(input: unknown): NormalizedWebAcceptanceOptions {
  const parsed = inputSchema.parse(input);
  const common = { ...(parsed.browser_executable !== undefined ? { browser_executable: parsed.browser_executable } : {}),
    ...(parsed.evidence_root !== undefined ? { evidence_root: parsed.evidence_root } : {}),
    action_timeout_ms: parsed.action_timeout_ms,
    ...(parsed.windows_browser_process !== undefined ? { windows_browser_process: parsed.windows_browser_process } : {}) };
  if (isV2WebAcceptanceOptions(parsed)) return { ...common, design_capture_cases: parsed.design_capture_cases, browser_program: parsed.browser_program };
  if (isV3WebAcceptanceOptions(parsed)) return { ...common, design_capture_cases: parsed.design_capture_cases, browser_program: parsed.browser_program,
    ...(parsed.storage_fault !== undefined ? { storage_fault: parsed.storage_fault } : {}),
    ...(parsed.storage_precondition !== undefined ? { storage_precondition: parsed.storage_precondition } : {}) };
  // Keep the exact v1 key order and absence of newly introduced optional fields.
  return { ...common, viewports: parsed.viewports, design_capture_cases: parsed.design_capture_cases };
}

export const StaticWebCapabilitySnapshotSchema = z.object({
  version: z.literal(1), binding: StaticWebCapabilityBindingSchema, options: NormalizedWebAcceptanceOptionsSchema,
}).strict();
export type StaticWebCapabilitySnapshot = z.infer<typeof StaticWebCapabilitySnapshotSchema>;
