import { z } from "zod";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const index = z.number().int().finite().min(0).max(99);
const counter = z.number().int().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const unique = <T>(values: readonly T[]): boolean => new Set(values).size === values.length;

export const StorageFaultOptionsV1Schema = z.object({ version: z.literal(1) }).strict();
export type StorageFaultOptionsV1 = z.infer<typeof StorageFaultOptionsV1Schema>;
export const StorageFaultModeV1Schema = z.enum(["read-security", "write-quota"]);
export type StorageFaultModeV1 = z.infer<typeof StorageFaultModeV1Schema>;
export const StorageFaultBaselinePhaseV1Schema = z.enum(["first-document-paused", "before-step"]);
export type StorageFaultBaselinePhaseV1 = z.infer<typeof StorageFaultBaselinePhaseV1Schema>;

const nativeComparison = z.object({ scope: z.literal("all"), comparison: z.literal("sampled-equal") }).strict();
const criterion = z.object({ requirement_id: identifier, criterion_index: index }).strict();
const windowShape = {
  id: identifier, mode: StorageFaultModeV1Schema, arm_before_step: index, settle_after_step: index,
  requirement_criteria: z.array(criterion).min(1).max(100)
    .refine((items) => unique(items.map((item) => `${item.requirement_id}:${item.criterion_index}`)), "Duplicate criterion references"),
  ui_assertion_steps: z.array(index).min(1).max(100).refine(unique, "Duplicate UI assertion references"),
};
interface WindowBounds { id: string; arm_before_step: number; settle_after_step: number; ui_assertion_steps: number[] }
function refineWindow(window: WindowBounds, ctx: z.RefinementCtx): void {
  if (window.arm_before_step > window.settle_after_step) ctx.addIssue({ code: z.ZodIssueCode.custom,
    path: ["settle_after_step"], message: "A storage window must end at or after its first step" });
  if (window.ui_assertion_steps.some((step) => step < window.arm_before_step || step > window.settle_after_step)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ui_assertion_steps"], message: "UI assertions must be inside their storage window" });
  }
}
function refineWindows(windows: WindowBounds[], ctx: z.RefinementCtx): void {
  if (!unique(windows.map((window) => window.id))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate storage window IDs" });
  windows.forEach((window, i) => {
    if (i > 0 && window.arm_before_step <= windows[i - 1]!.settle_after_step) ctx.addIssue({ code: z.ZodIssueCode.custom,
      path: [i, "arm_before_step"], message: "Storage windows must be ordered and nonoverlapping" });
  });
}

export const StorageCheckWindowV1Schema = z.object({ ...windowShape, page: z.literal("main"), min_hits: z.literal(1),
  native_storage: nativeComparison }).strict().superRefine(refineWindow);
export type StorageCheckWindowV1 = z.infer<typeof StorageCheckWindowV1Schema>;
export const ProductStorageChecksV1Schema = z.object({ version: z.literal(1),
  windows: z.array(StorageCheckWindowV1Schema).min(1).max(4).superRefine(refineWindows) }).strict();
export type ProductStorageChecksV1 = z.infer<typeof ProductStorageChecksV1Schema>;

/** Structural and reference checks only; accepted research and execution authority belong to the node. */
export function validateProductStorageChecksV1(steps: readonly { action: string; page: string }[],
  checks: ProductStorageChecksV1, requirementIds?: readonly string[]): void {
  ProductStorageChecksV1Schema.parse(checks);
  if (steps.length < 1 || steps.length > 100 || steps[0]?.action !== "navigate" || steps[0]?.page !== "main"
    || steps.some((step) => step.page !== "main" || step.action === "open_page" || step.action === "close_page")) {
    throw new Error("Storage fault cases require 1 to 100 main-only steps, starting with navigate, without open_page or close_page");
  }
  for (const window of checks.windows) {
    if (window.settle_after_step >= steps.length) throw new Error(`Storage window ${window.id} references an absent step`);
    if (window.requirement_criteria.some((ref) => requirementIds !== undefined && !requirementIds.includes(ref.requirement_id))) {
      throw new Error(`Storage window ${window.id} references a requirement outside its case`);
    }
    for (let i = window.arm_before_step + 1; i <= window.settle_after_step; i++) {
      if (steps[i]!.action === "navigate" || steps[i]!.action === "reload") {
        throw new Error(`Storage window ${window.id} permits document navigation only at its first step`);
      }
    }
    if (window.ui_assertion_steps.some((i) => !["assert_text", "assert_value", "assert_count"].includes(steps[i]!.action))) {
      throw new Error(`Storage window ${window.id} requires content, value or count UI assertions`);
    }
  }
}

const snapshot = z.object({ digest, key_count: z.number().int().finite().min(0).max(512),
  utf8_bytes: z.number().int().finite().min(0).max(1024 * 1024) }).strict().refine(
  (value) => value.key_count !== 0 || value.utf8_bytes === 0, "An empty native snapshot has zero key/value bytes");
const events = z.object({ coverage: z.literal("observed-only"), observed_mutations: z.literal(0) }).strict();
export const StorageFaultTraceWindowV1Schema = z.object({ ...windowShape, page_id: z.literal("main"),
  start_step_digest: digest, end_step_digest: digest, baseline_phase: StorageFaultBaselinePhaseV1Schema,
  document_epoch: z.number().int().finite().min(1).max(100),
  installation: z.object({ script_digest: digest, confirmed: z.literal(true) }).strict(),
  sequence: z.tuple([z.literal("baseline"), z.literal("armed"), z.literal("settled"), z.literal("disarmed")]),
  hits: z.object({ baseline: counter, final: counter, delta: counter.min(1) }).strict(),
  native_storage: nativeComparison.extend({ before: snapshot, after: snapshot, equal: z.literal(true) }).strict(), events,
}).strict().superRefine((window, ctx) => {
  refineWindow(window, ctx);
  if (window.hits.final - window.hits.baseline !== window.hits.delta) ctx.addIssue({ code: z.ZodIssueCode.custom,
    path: ["hits"], message: "Fresh hits must equal the final counter minus its own window baseline" });
  const { before, after } = window.native_storage;
  if (before.digest !== after.digest || before.key_count !== after.key_count || before.utf8_bytes !== after.utf8_bytes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["native_storage"], message: "Native snapshot digests, counts and bytes must agree" });
  }
  if (window.baseline_phase !== (window.arm_before_step === 0 ? "first-document-paused" : "before-step")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baseline_phase"], message: "Only the first navigation uses a paused first-document baseline" });
  }
});
export type StorageFaultTraceWindowV1 = z.infer<typeof StorageFaultTraceWindowV1Schema>;
export const StorageFaultTraceV1Schema = z.object({ version: z.literal(1), checks_digest: digest,
  windows: z.array(StorageFaultTraceWindowV1Schema).min(1).max(4).superRefine(refineWindows) }).strict();
export type StorageFaultTraceV1 = z.infer<typeof StorageFaultTraceV1Schema>;
export const StorageFaultReportV1Schema = z.object({ version: z.literal(1), checks_digest: digest,
  windows: z.array(z.object({ id: identifier, mode: StorageFaultModeV1Schema, fresh_hits: counter.min(1),
    native_storage: nativeComparison.extend({ digest }).strict(), events }).strict()).min(1).max(4)
    .refine((windows) => unique(windows.map((window) => window.id)), "Duplicate storage window IDs"),
}).strict();
export type StorageFaultReportV1 = z.infer<typeof StorageFaultReportV1Schema>;

/** Only actual validated trace data supplies the compact report, never a planned outcome. */
export function storageFaultReportFromTraceV1(trace: StorageFaultTraceV1): StorageFaultReportV1 {
  const parsed = StorageFaultTraceV1Schema.parse(trace);
  return StorageFaultReportV1Schema.parse({ version: 1, checks_digest: parsed.checks_digest,
    windows: parsed.windows.map((window) => ({ id: window.id, mode: window.mode, fresh_hits: window.hits.delta,
      native_storage: { scope: "all", comparison: "sampled-equal", digest: window.native_storage.before.digest },
      events: window.events })) });
}

/** These fixed limits describe configured measurement, not passing product evidence. */
export const StorageFaultCapabilitiesV1Schema = z.object({ version: z.literal(1), initializer_digest: digest,
  modes: z.tuple([
    z.object({ mode: z.literal("read-security"), entry: z.literal("Window.localStorage.get"), exception: z.literal("SecurityError") }).strict(),
    z.object({ mode: z.literal("write-quota"), entry: z.literal("Storage.prototype.setItem"), exception: z.literal("QuotaExceededError") }).strict(),
  ]),
  cases: z.object({ page: z.literal("main"), extra_realms: z.literal("rejected"),
    document_changes: z.literal("explicit-navigate-or-reload-only") }).strict(),
  windows: z.object({ max_windows: z.literal(4), documents_per_window: z.literal(1), navigation: z.literal("first-step-only"),
    min_hits: z.literal(1), ui_assertions: z.tuple([z.literal("assert_text"), z.literal("assert_value"), z.literal("assert_count")]) }).strict(),
  native_storage: nativeComparison.extend({ max_keys: z.literal(512), max_utf8_bytes: z.literal(1048576) }).strict(),
  events: z.object({ coverage: z.literal("observed-only"), observed_mutation: z.literal("fails"), max_observed_events_per_case: z.literal(512) }).strict(),
  unavailable: z.tuple([z.literal("cached-object-read-denial"), z.literal("all-write-path-denial"),
    z.literal("no-mutation-in-window"), z.literal("multiple-page-faults")]),
}).strict();
export type StorageFaultCapabilitiesV1 = z.infer<typeof StorageFaultCapabilitiesV1Schema>;
export function storageFaultCapabilitiesV1(initializerDigest: string): StorageFaultCapabilitiesV1 {
  return StorageFaultCapabilitiesV1Schema.parse({ version: 1, initializer_digest: initializerDigest,
    modes: [{ mode: "read-security", entry: "Window.localStorage.get", exception: "SecurityError" },
      { mode: "write-quota", entry: "Storage.prototype.setItem", exception: "QuotaExceededError" }],
    cases: { page: "main", extra_realms: "rejected", document_changes: "explicit-navigate-or-reload-only" },
    windows: { max_windows: 4, documents_per_window: 1, navigation: "first-step-only", min_hits: 1,
      ui_assertions: ["assert_text", "assert_value", "assert_count"] },
    native_storage: { scope: "all", comparison: "sampled-equal", max_keys: 512, max_utf8_bytes: 1048576 },
    events: { coverage: "observed-only", observed_mutation: "fails", max_observed_events_per_case: 512 },
    unavailable: ["cached-object-read-denial", "all-write-path-denial", "no-mutation-in-window", "multiple-page-faults"] });
}
