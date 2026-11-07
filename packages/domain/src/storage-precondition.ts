import { z } from "zod";
import { CriterionRefSchema, criterionRefKey, type CriterionRef } from "./release-capabilities.js";
import { BrowserActionV3Schema, BrowserPageIdV3Schema, deriveBrowserPageLifecycleV3 } from "./browser-program-v3.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const index = z.number().int().finite().min(0).max(99);
const epoch = z.number().int().finite().min(1).max(100);
const unique = <T>(values: readonly T[]): boolean => new Set(values).size === values.length;
const criteria = z.array(CriterionRefSchema).min(1).max(100)
  .refine(items => unique(items.map(criterionRefKey)), "Duplicate criterion references");
const assertionSteps = z.array(index).min(1).max(100).refine(unique, "Duplicate UI assertion references");
const refsShape = { requirement_criteria: criteria, ui_assertion_steps: assertionSteps };
const preservationShape = { after_step: index, ...refsShape };
const assertionActions = new Set(["assert_text", "assert_value", "assert_count"]);

export const MAX_STORAGE_PRECONDITION_KEY_UTF8_BYTES = 512;
export const MAX_STORAGE_PRECONDITION_VALUE_UTF8_BYTES = 65536;

/** Count scalar UTF-8 bytes without silently replacing unpaired UTF-16 surrogates. */
function scalarUtf8Bytes(value: string): number | undefined {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) return undefined;
    else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return bytes;
}
const raw = (limit: number, nonempty = false) => z.string().max(limit).refine(value => {
  const bytes = scalarUtf8Bytes(value);
  return bytes !== undefined && bytes <= limit && (!nonempty || bytes > 0);
}, "Expected a bounded Unicode scalar string");

export const StoragePreconditionOptionsV1Schema = z.object({ version: z.literal(1) }).strict();
export type StoragePreconditionOptionsV1 = z.infer<typeof StoragePreconditionOptionsV1Schema>;
interface ReferenceShape { requirement_criteria: CriterionRef[]; ui_assertion_steps: number[] }
interface PreservationShape extends ReferenceShape { after_step: number }
function refinePreservation(check: PreservationShape, ctx: z.RefinementCtx): void {
  if (check.after_step === 0 || check.ui_assertion_steps.some(step => step === 0 || step > check.after_step)
    || Math.max(...check.ui_assertion_steps) !== check.after_step) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["after_step"],
      message: "Preservation samples follow the last named substantive UI assertion after navigation" });
  }
}
export const StoragePreconditionPreservationCheckV1Schema = z.object(preservationShape).strict().superRefine(refinePreservation);
export type StoragePreconditionPreservationCheckV1 = z.infer<typeof StoragePreconditionPreservationCheckV1Schema>;
function refineReferences(value: ReferenceShape & { preservation_checks?: PreservationShape[] }, ctx: z.RefinementCtx): void {
  const refs = new Set(value.requirement_criteria.map(criterionRefKey));
  if (value.ui_assertion_steps.includes(0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ui_assertion_steps"],
    message: "Precondition UI assertions must follow the first navigation" });
  value.preservation_checks?.forEach((check, i, all) => {
    if (i > 0 && check.after_step <= all[i - 1]!.after_step) ctx.addIssue({ code: z.ZodIssueCode.custom,
      path: ["preservation_checks", i, "after_step"], message: "Preservation checkpoints must be distinct and ordered" });
    if (check.requirement_criteria.some(ref => !refs.has(criterionRefKey(ref)))
      || check.ui_assertion_steps.some(step => !value.ui_assertion_steps.includes(step))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["preservation_checks", i],
        message: "Preservation references must belong to the precondition" });
    }
  });
}

/** Raw fixture data only: never parsed, trimmed, normalized or interpreted as executable source. */
export const ProductStoragePreconditionV1Schema = z.object({ version: z.literal(1),
  local_storage: z.object({ key: raw(MAX_STORAGE_PRECONDITION_KEY_UTF8_BYTES, true),
    value: raw(MAX_STORAGE_PRECONDITION_VALUE_UTF8_BYTES) }).strict(), ...refsShape,
  preservation_checks: z.array(StoragePreconditionPreservationCheckV1Schema).max(4).optional(),
}).strict().superRefine(refineReferences);
export type ProductStoragePreconditionV1 = z.infer<typeof ProductStoragePreconditionV1Schema>;
export const ProductStoragePreconditionSourceV1Schema = z.object({ path: z.literal(".artoo/product/design.json"),
  checksum: digest, size: z.number().int().finite().min(1).max(1024 * 1024), case_id: identifier }).strict();
export type ProductStoragePreconditionSourceV1 = z.infer<typeof ProductStoragePreconditionSourceV1Schema>;
export const ProductStoragePreconditionBindingV1Schema = z.object({ source: ProductStoragePreconditionSourceV1Schema,
  precondition: ProductStoragePreconditionV1Schema }).strict();
export type ProductStoragePreconditionBindingV1 = z.infer<typeof ProductStoragePreconditionBindingV1Schema>;

/** Structural/reference checks; the protected caller supplies exact accepted research refs and authority. */
export function validateProductStoragePreconditionV1(steps: readonly { action: string; page: string }[],
  precondition: ProductStoragePreconditionV1, requirementIds?: readonly string[], exactCriterionRefs?: readonly CriterionRef[]): void {
  ProductStoragePreconditionV1Schema.parse(precondition);
  validateStoragePreconditionReferencesV1(steps, precondition, requirementIds, exactCriterionRefs);
}
/** Also applies to native evidence without exposing raw fixture values. */
export function validateStoragePreconditionReferencesV1(steps: readonly { action: string; page: string }[],
  refs: ReferenceShape & { preservation_checks?: PreservationShape[] }, requirementIds?: readonly string[],
  exactCriterionRefs?: readonly CriterionRef[]): void {
  if (steps.length < 2 || steps.length > 100 || steps[0]?.action !== "navigate" || steps[0]?.page !== "main") {
    throw new Error("Storage precondition cases require 2 to 100 v3 steps starting with navigate on main");
  }
  // Seed only the first main document. Other controlled pages reuse the existing shared-origin v3 lifecycle.
  deriveBrowserPageLifecycleV3(steps.map(step => ({ action: BrowserActionV3Schema.parse(step.action), page: BrowserPageIdV3Schema.parse(step.page) })));
  const allowed = exactCriterionRefs && new Set(exactCriterionRefs.map(criterionRefKey));
  if (refs.requirement_criteria.some(ref => requirementIds && !requirementIds.includes(ref.requirement_id)
    || allowed && !allowed.has(criterionRefKey(ref)))) throw new Error("Storage precondition criterion is outside its case or accepted research");
  for (const item of [refs, ...(refs.preservation_checks ?? [])]) {
    if (item.ui_assertion_steps.some(step => step === 0 || !steps[step] || !assertionActions.has(steps[step]!.action))) {
      throw new Error("Storage precondition requires existing content, value or count UI assertions after navigation");
    }
  }
}

/** Same bounded native all-key summary semantics as storage-fault/v1; no raw data is public. */
export const NativeStorageSnapshotV1Schema = z.object({ digest, key_count: z.number().int().finite().min(0).max(512),
  utf8_bytes: z.number().int().finite().min(0).max(1024 * 1024) }).strict().refine(
  value => value.key_count !== 0 || value.utf8_bytes === 0, "An empty native snapshot has zero key/value bytes");
export type NativeStorageSnapshotV1 = z.infer<typeof NativeStorageSnapshotV1Schema>;
const snapshotsEqual = (a: NativeStorageSnapshotV1, b: NativeStorageSnapshotV1): boolean =>
  a.digest === b.digest && a.key_count === b.key_count && a.utf8_bytes === b.utf8_bytes;
export const StoragePreconditionPreservationTraceV1Schema = z.object({ ...preservationShape, step_digest: digest, document_epoch: epoch,
  native_storage: z.object({ scope: z.literal("all"), comparison: z.literal("sampled-equal"),
    snapshot: NativeStorageSnapshotV1Schema, equal: z.literal(true) }).strict(),
}).strict().superRefine(refinePreservation);
export type StoragePreconditionPreservationTraceV1 = z.infer<typeof StoragePreconditionPreservationTraceV1Schema>;
const origin = z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/).refine(value => {
  try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol)
    && parsed.origin === value && !parsed.username && !parsed.password; } catch { return false; }
}, "Expected a canonical protected product origin");
const reportShape = { version: z.literal(1), descriptor_digest: digest, source: ProductStoragePreconditionSourceV1Schema,
  program_digest: digest, page_id: z.literal("main"), document_epoch: z.literal(1), origin,
  initial_step_digest: digest, seed_apply_count: z.literal(1), ...refsShape,
  native_storage: z.object({ scope: z.literal("all"), before: NativeStorageSnapshotV1Schema, seeded: NativeStorageSnapshotV1Schema }).strict(),
  preservation_checks: z.array(StoragePreconditionPreservationTraceV1Schema).max(4),
};
function refineEvidence(value: z.infer<z.ZodObject<typeof reportShape>>, ctx: z.RefinementCtx): void {
  refineReferences(value, ctx);
  const { before, seeded } = value.native_storage;
  if (before.key_count !== 0 || before.utf8_bytes !== 0 || seeded.key_count !== 1 || seeded.utf8_bytes < 1
    || seeded.utf8_bytes > MAX_STORAGE_PRECONDITION_KEY_UTF8_BYTES + MAX_STORAGE_PRECONDITION_VALUE_UTF8_BYTES
    || before.digest === seeded.digest) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["native_storage"],
      message: "Native seed evidence requires an empty baseline and a distinct bounded one-key readback" });
  value.preservation_checks.forEach((check, i) => {
    if (!snapshotsEqual(seeded, check.native_storage.snapshot)) ctx.addIssue({ code: z.ZodIssueCode.custom,
      path: ["preservation_checks", i, "native_storage"], message: "Preservation must equal the actual seeded native snapshot" });
  });
}
export const StoragePreconditionTraceV1Schema = z.object({ ...reportShape,
  installation: z.object({ script_digest: digest, confirmed: z.literal(true) }).strict(),
  sequence: z.tuple([z.literal("empty-baseline"), z.literal("native-seed-readback"), z.literal("resumed")]),
}).strict().superRefine(refineEvidence);
export type StoragePreconditionTraceV1 = z.infer<typeof StoragePreconditionTraceV1Schema>;
export const StoragePreconditionReportV1Schema = z.object(reportShape).strict().superRefine(refineEvidence);
export type StoragePreconditionReportV1 = z.infer<typeof StoragePreconditionReportV1Schema>;
/** Project validated actual native observations only; planned input cannot manufacture a receipt. */
export function storagePreconditionReportFromTraceV1(trace: StoragePreconditionTraceV1): StoragePreconditionReportV1 {
  const { installation: _installation, sequence: _sequence, ...report } = StoragePreconditionTraceV1Schema.parse(trace);
  return StoragePreconditionReportV1Schema.parse(report);
}

export const StoragePreconditionCapabilitiesV1Schema = z.object({ version: z.literal(1), initializer_digest: digest,
  input: z.object({ kind: z.literal("raw-local-document"), max_keys: z.literal(1), max_key_utf8_bytes: z.literal(512),
    max_value_utf8_bytes: z.literal(65536), unicode: z.literal("scalar-values") }).strict(),
  cases: z.object({ seed_page: z.literal("main"), observation_pages: z.literal("existing-v3-lifecycle"),
    context: z.literal("new-isolated"), extra_realms: z.literal("uncontrolled-rejected"),
    main_document_changes: z.literal("explicit-v3-actions-only") }).strict(),
  installation: z.object({ phase: z.literal("before-first-product-script"), baseline: z.literal("empty-native-storage"),
    native_readback: z.literal("exact-single-entry"), seed_count: z.literal(1), reload: z.literal("no-replay") }).strict(),
  preservation: z.object({ comparison: z.literal("seeded-sampled-equal"), scope: z.literal("all"), max_checkpoints: z.literal(4),
    ui_assertions: z.tuple([z.literal("assert_text"), z.literal("assert_value"), z.literal("assert_count")]) }).strict(),
  unavailable: z.tuple([z.literal("fixture-semantic-validity"), z.literal("continuous-preservation"), z.literal("non-main-seeding")]),
}).strict();
export type StoragePreconditionCapabilitiesV1 = z.infer<typeof StoragePreconditionCapabilitiesV1Schema>;
export function storagePreconditionCapabilitiesV1(initializerDigest: string): StoragePreconditionCapabilitiesV1 {
  return StoragePreconditionCapabilitiesV1Schema.parse({ version: 1, initializer_digest: initializerDigest,
    input: { kind: "raw-local-document", max_keys: 1, max_key_utf8_bytes: 512, max_value_utf8_bytes: 65536, unicode: "scalar-values" },
    cases: { seed_page: "main", observation_pages: "existing-v3-lifecycle", context: "new-isolated",
      extra_realms: "uncontrolled-rejected", main_document_changes: "explicit-v3-actions-only" },
    installation: { phase: "before-first-product-script", baseline: "empty-native-storage", native_readback: "exact-single-entry", seed_count: 1, reload: "no-replay" },
    preservation: { comparison: "seeded-sampled-equal", scope: "all", max_checkpoints: 4, ui_assertions: ["assert_text", "assert_value", "assert_count"] },
    unavailable: ["fixture-semantic-validity", "continuous-preservation", "non-main-seeding"] });
}
