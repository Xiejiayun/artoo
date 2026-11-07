import { z } from "zod";
import { AllowedBrowserKeySchema, BrowserViewportV2Schema } from "./browser-program.js";
import { BrowserActionV3Schema } from "./browser-program-v3.js";
import { ReleaseCapabilitiesV1Schema, ReleaseCapabilityBindingV1Schema, ReleaseCriterionBindingV1Schema,
  CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT, CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST,
  canonicalReleaseJson, canonicalReleaseCriterion, compareCriterionRefs, type ReleaseCapabilitiesV1 } from "./release-capabilities.js";
import type { ProductResearchReport } from "./product-development.js";
import type { VerificationCapabilities, StaticWebCapabilities } from "./verification-capabilities.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const commandId = z.string().min(1).max(128);
const unique = <T>(values: readonly T[]): boolean => new Set(values).size === values.length;
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export const MAX_MEASUREMENT_PLAN_CRITERIA = 10000;
export const MAX_MEASUREMENT_RESEARCH_BYTES = 1024 * 1024;

/** Local protected policy. Public copies describe it but cannot install its authority. */
export const MeasurementPlanPolicyV1Schema = z.object({ version: z.literal(1), coverage: z.literal("every-must-criterion") }).strict();
export type MeasurementPlanPolicyV1 = z.infer<typeof MeasurementPlanPolicyV1Schema>;
export const MeasurementPlanPolicyV2Schema = z.object({ version: z.literal(2), coverage: z.literal("every-must-criterion"),
  methods: z.tuple([z.literal("workspace-check"), z.literal("configured-static-release")]) }).strict();
export type MeasurementPlanPolicyV2 = z.infer<typeof MeasurementPlanPolicyV2Schema>;
export const MeasurementPlanPolicySchema = z.discriminatedUnion("version", [MeasurementPlanPolicyV1Schema, MeasurementPlanPolicyV2Schema]);
export type MeasurementPlanPolicy = z.infer<typeof MeasurementPlanPolicySchema>;

/** Explicit claims, not inferred meanings of the natural-language criterion. */
export const MeasurementNeedV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("keyboard-events") }).strict(),
  z.object({ kind: z.literal("focus"), scope: z.enum(["main-frame-dom", "shadow-dom", "frame-dom"]) }).strict(),
  // False explicitly requests different origins/contexts; it is not an unspecified preference.
  z.object({ kind: z.literal("pages"), max_created: z.number().int().min(1).max(100),
    same_origin: z.boolean(), same_browser_context: z.boolean() }).strict(),
  z.object({ kind: z.literal("storage-fault"), version: z.literal(1), mode: z.enum(["read-security", "write-quota"]),
    invariant: z.enum(["sampled-equal", "no-mutation-in-window"]), page_scope: z.enum(["main-only", "multiple-pages"]),
    api_scope: z.enum(["fixed-entry", "all-paths"]) }).strict(),
  z.object({ kind: z.literal("native-screen-reader") }).strict(),
  z.object({ kind: z.literal("browser-zoom"), percentage: z.number().int().min(25).max(500) }).strict(),
]);
export type MeasurementNeedV1 = z.infer<typeof MeasurementNeedV1Schema>;
/** The extension is admitted only by a version-2 workspace declaration; V1 keeps its exact schema. */
export const StoragePreconditionMeasurementNeedV1Schema = z.object({ kind: z.literal("storage-precondition"), version: z.literal(1),
  input: z.literal("raw-local-document"), phase: z.literal("before-first-product-script"), page_scope: z.literal("main-seed-same-origin-pages"),
  preservation: z.enum(["seeded-sampled-equal", "not-requested"]) }).strict();
export type StoragePreconditionMeasurementNeedV1 = z.infer<typeof StoragePreconditionMeasurementNeedV1Schema>;
export const MeasurementNeedV2Schema = z.discriminatedUnion("kind", [...MeasurementNeedV1Schema.options, StoragePreconditionMeasurementNeedV1Schema]);
export type MeasurementNeedV2 = z.infer<typeof MeasurementNeedV2Schema>;
const needKey = (need: MeasurementNeedV2): string => need.kind === "storage-fault" ? `${need.kind}:${need.mode}` : need.kind;
const checkBinding = z.object({ command_id: commandId, config_digest: digest, contract_digest: digest }).strict();
export const MeasurementPlanEntryV1Schema = checkBinding.extend({
  requirement_id: identifier, criterion_index: z.number().int().min(0).max(99),
  actions: z.array(BrowserActionV3Schema).min(1).max(17).refine(unique, "Duplicate declared actions"),
  keys: z.array(AllowedBrowserKeySchema).max(13).refine(unique, "Duplicate declared keys"),
  viewports: z.array(BrowserViewportV2Schema).min(1).max(8)
    .refine(items => unique(items.map(item => item.id)), "Duplicate declared viewport IDs"),
  needs: z.array(MeasurementNeedV1Schema).max(7).refine(items => unique(items.map(needKey)), "Duplicate declared needs"),
}).strict();
export type MeasurementPlanEntryV1 = z.infer<typeof MeasurementPlanEntryV1Schema>;
const criterionKey = (entry: Pick<MeasurementPlanEntryV1, "requirement_id" | "criterion_index">): string => `${entry.requirement_id}:${entry.criterion_index}`;
export const ProductMeasurementPlanV1Schema = z.object({ version: z.literal(1), profile_digest: digest,
  entries: z.array(MeasurementPlanEntryV1Schema).min(1).max(MAX_MEASUREMENT_PLAN_CRITERIA)
    .refine(entries => unique(entries.map(criterionKey)), "Duplicate criterion declarations"),
}).strict();
export type ProductMeasurementPlanV1 = z.infer<typeof ProductMeasurementPlanV1Schema>;
export const WorkspaceMeasurementPlanEntryV2Schema = MeasurementPlanEntryV1Schema.extend({ method: z.literal("workspace-check"),
  needs: z.array(MeasurementNeedV2Schema).max(8).refine(items => unique(items.map(needKey)), "Duplicate declared needs") }).strict();
export type WorkspaceMeasurementPlanEntryV2 = z.infer<typeof WorkspaceMeasurementPlanEntryV2Schema>;
export const ReleaseMeasurementPlanEntryV2Schema = z.object({ method: z.literal("configured-static-release"),
  requirement_id: identifier, criterion_index: z.number().int().min(0).max(99), release_binding: ReleaseCapabilityBindingV1Schema,
  claim_id: z.literal(CONFIGURED_STATIC_PUBLICATION_CLAIM), statement_digest: z.literal(CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST) }).strict();
export type ReleaseMeasurementPlanEntryV2 = z.infer<typeof ReleaseMeasurementPlanEntryV2Schema>;
export const MeasurementPlanEntryV2Schema = z.discriminatedUnion("method", [WorkspaceMeasurementPlanEntryV2Schema, ReleaseMeasurementPlanEntryV2Schema]);
export type MeasurementPlanEntryV2 = z.infer<typeof MeasurementPlanEntryV2Schema>;
export const ProductMeasurementPlanV2Schema = z.object({ version: z.literal(2), profile_digest: digest,
  entries: z.array(MeasurementPlanEntryV2Schema).min(1).max(MAX_MEASUREMENT_PLAN_CRITERIA)
    .refine(entries => unique(entries.map(criterionKey)), "Duplicate criterion declarations") }).strict();
export type ProductMeasurementPlanV2 = z.infer<typeof ProductMeasurementPlanV2Schema>;
export const ProductMeasurementPlanSchema = z.discriminatedUnion("version", [ProductMeasurementPlanV1Schema, ProductMeasurementPlanV2Schema]);
export type ProductMeasurementPlan = z.infer<typeof ProductMeasurementPlanSchema>;

/** Node-owned statement of declared mapping feasibility, never a browser result or semantic completeness claim. */
export const MeasurementPlanSummaryV1Schema = z.object({
  version: z.literal(1), claim: z.literal("declared-mapping-feasibility"), scope: z.enum(["preview", "final"]),
  policy: MeasurementPlanPolicyV1Schema,
  research: z.object({ path: z.literal(".artoo/product/research.json"), checksum: digest,
    size: z.number().int().min(1).max(MAX_MEASUREMENT_RESEARCH_BYTES) }).strict(),
  measurement_plan_digest: digest,
  must_criterion_count: z.number().int().min(1).max(MAX_MEASUREMENT_PLAN_CRITERIA),
  mapped_criterion_count: z.number().int().min(1).max(MAX_MEASUREMENT_PLAN_CRITERIA),
  used_checks: z.array(checkBinding).min(1).max(32)
    .refine(checks => checks.every((check, i) => i === 0 || compare(checks[i - 1]!.command_id, check.command_id) < 0), "Used check IDs must be unique and sorted"),
}).strict().superRefine((summary, ctx) => {
  if (summary.must_criterion_count !== summary.mapped_criterion_count || summary.used_checks.length > summary.mapped_criterion_count) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mapped_criterion_count"], message: "Declared criterion counts must agree and cover every used check" });
  }
});
export type MeasurementPlanSummaryV1 = z.infer<typeof MeasurementPlanSummaryV1Schema>;
export const PendingReleaseCriterionV1Schema = ReleaseCriterionBindingV1Schema.extend({
  statement_digest: z.literal(CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST), release_binding: ReleaseCapabilityBindingV1Schema,
}).strict();
export type PendingReleaseCriterionV1 = z.infer<typeof PendingReleaseCriterionV1Schema>;
export const MeasurementPlanSummaryV2Schema = z.object({
  version: z.literal(2), claim: z.literal("declared-mapping-feasibility"), scope: z.enum(["preview", "final"]), policy: MeasurementPlanPolicyV2Schema,
  research: z.object({ path: z.literal(".artoo/product/research.json"), checksum: digest,
    size: z.number().int().min(1).max(MAX_MEASUREMENT_RESEARCH_BYTES) }).strict(), measurement_plan_digest: digest,
  must_criterion_count: z.number().int().min(1).max(MAX_MEASUREMENT_PLAN_CRITERIA), mapped_criterion_count: z.number().int().min(1).max(MAX_MEASUREMENT_PLAN_CRITERIA),
  workspace_criterion_count: z.number().int().min(1).max(MAX_MEASUREMENT_PLAN_CRITERIA), release_criterion_count: z.number().int().min(0).max(MAX_MEASUREMENT_PLAN_CRITERIA),
  used_checks: z.array(checkBinding).min(1).max(32)
    .refine(checks => checks.every((check, i) => i === 0 || compare(checks[i - 1]!.command_id, check.command_id) < 0), "Used check IDs must be unique and sorted"),
  pending_release: z.array(PendingReleaseCriterionV1Schema).max(MAX_MEASUREMENT_PLAN_CRITERIA)
    .refine(refs => refs.every((ref, i) => i === 0 || compareCriterionRefs(refs[i - 1]!, ref) < 0), "Pending release criteria must be unique and sorted"),
}).strict().superRefine((summary, ctx) => {
  if (summary.must_criterion_count !== summary.mapped_criterion_count
    || summary.workspace_criterion_count + summary.release_criterion_count !== summary.mapped_criterion_count
    || summary.pending_release.length !== summary.release_criterion_count || summary.used_checks.length > summary.workspace_criterion_count
    || summary.pending_release.some(ref => canonicalReleaseJson(ref.release_binding) !== canonicalReleaseJson(summary.pending_release[0]!.release_binding))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pending_release"], message: "Criterion partition counts and release bindings must agree" });
  }
});
export type MeasurementPlanSummaryV2 = z.infer<typeof MeasurementPlanSummaryV2Schema>;
export const MeasurementPlanSummarySchema = z.union([MeasurementPlanSummaryV1Schema, MeasurementPlanSummaryV2Schema]);
export type MeasurementPlanSummary = z.infer<typeof MeasurementPlanSummarySchema>;
export interface MeasurementPlanFeasibilityV1 {
  must_criterion_count: number;
  mapped_criterion_count: number;
  used_checks: MeasurementPlanSummaryV1["used_checks"];
  /** The node hashes these exact UTF-8 bytes with its existing SHA-256 implementation. */
  canonical_plan: string;
}

function parsePlan(input: unknown): ProductMeasurementPlanV1 {
  const parsed = ProductMeasurementPlanV1Schema.safeParse(input);
  if (!parsed.success) {
    // Schema diagnostics never echo criterion prose or unbounded submitted values.
    const path = parsed.error.issues[0]?.path.slice(0, 6).map(part => String(part).slice(0, 64)).join(".") || "measurement_plan";
    throw new Error(`Invalid measurement-plan declaration at ${path}`);
  }
  return parsed.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => compare(a, b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Unsupported measurement-plan canonical value");
  return encoded;
}
/** Object keys sort by UTF-16 code units; array order is preserved. No defaults or rewriting of declarations. */
export function canonicalMeasurementPlanV1(plan: ProductMeasurementPlanV1): string { return canonical(parsePlan(plan)); }
export function canonicalMeasurementPlanV2(plan: ProductMeasurementPlanV2): string { return canonical(ProductMeasurementPlanV2Schema.parse(plan)); }

const contentAssertions = new Set(["assert_text", "assert_value", "assert_count"]);
const focusActions = new Set(["focus", "assert_focused", "assert_focus_within"]);
function validateMethod(entry: MeasurementPlanEntryV1 | WorkspaceMeasurementPlanEntryV2, contract: StaticWebCapabilities): void {
  const needs: readonly MeasurementNeedV2[] = entry.needs;
  const fail = (reason: string): never => { throw new Error(`Measurement plan ${criterionKey(entry)}: ${reason}`); };
  if (contract.kind !== "static-web" || contract.claim !== "configured" || ![1, 2, 3].includes(contract.version)
    || contract.browser_steps_version !== contract.version) fail("the selected check has no supported configured measurement contract");
  if (entry.actions.some(action => !(contract.actions as readonly string[]).includes(action))) fail("actions exceed the configured check");
  const substantive = entry.actions.some(action => contentAssertions.has(action)
    || contract.version >= 2 && ["assert_focused", "assert_focus_within"].includes(action));
  if (!substantive) fail("a supported content, value, count or focus assertion is required");
  if (entry.viewports.some(viewport => !contract.viewports.some(actual => actual.id === viewport.id && actual.width === viewport.width && actual.height === viewport.height))) {
    fail("viewports must match configured IDs, widths and heights exactly");
  }
  const press = entry.actions.includes("press"), typing = entry.actions.includes("type_text");
  const keyboard = needs.find(need => need.kind === "keyboard-events");
  if (press !== (entry.keys.length > 0)) fail("press requires configured keys, and keys require press");
  if ((press || typing) !== (keyboard !== undefined)) fail("key actions and the keyboard-events need must be declared together");
  if (press || typing) {
    if (contract.version === 1) fail("keyboard events are unavailable in this contract");
    else if (entry.keys.some(key => !contract.keyboard.allowed_keys.includes(key)) || typing && contract.keyboard.typing_max_length < 1) {
      fail("keyboard keys or typing exceed the configured scope");
    }
  }
  const focus = needs.find(need => need.kind === "focus");
  const hasFocusAction = entry.actions.some(action => focusActions.has(action));
  if (hasFocusAction !== (focus !== undefined)) fail("focus operations and a focus scope must be declared together");
  if (focus && (contract.version === 1 || focus.scope !== contract.keyboard.focus_scope)) fail("focus scope is unavailable; programmatic setup is not native traversal");
  const pages = needs.find(need => need.kind === "pages");
  const openPage = entry.actions.includes("open_page"), closePage = entry.actions.includes("close_page");
  if ((openPage || closePage) && (!pages || pages.max_created < 2)) fail("page actions require a cumulative pages declaration of at least two");
  if (closePage && !openPage) fail("closing another page requires a declared open_page action");
  if (pages && (pages.max_created > contract.pages.max_pages || !pages.same_origin || !pages.same_browser_context)) {
    fail("pages exceed the configured cumulative count, origin or shared-context scope");
  }
  if (pages && pages.max_created > 1 && !openPage) fail("multiple created pages require open_page");
  for (const need of needs) {
    if (need.kind === "native-screen-reader" || need.kind === "browser-zoom") fail(`${need.kind} has no installed measurement implementation`);
    if (need.kind === "storage-precondition") {
      if (contract.version !== 3 || !contract.storage_precondition) fail("storage-precondition requires an opted-in v3 check");
      else {
        const configured = contract.storage_precondition;
        if (need.version !== configured.version || need.input !== configured.input.kind || need.phase !== configured.installation.phase
          || need.preservation !== "not-requested" && need.preservation !== configured.preservation.comparison) fail("storage-precondition exceeds the configured scope");
        if (!entry.actions.includes("navigate") || !entry.actions.some(action => contentAssertions.has(action))) {
          fail("storage-precondition requires navigation and a content, value or count UI assertion");
        }
      }
      continue;
    }
    if (need.kind !== "storage-fault") continue;
    if (contract.version !== 3 || !contract.storage_fault || contract.unavailable.includes("storage-exception-injection")) fail("storage-fault requires an opted-in v3 check");
    else {
      const fault = contract.storage_fault;
      if (fault.version !== need.version || !fault.modes.some(mode => mode.mode === need.mode)) fail("storage-fault mode is not configured");
      if (need.invariant !== fault.native_storage.comparison) fail("storage-fault cannot prove no-mutation-in-window with sampled-equal and observed-only measurements");
      if (need.api_scope !== "fixed-entry") fail("storage-fault cannot prove all-paths read denial or write failure");
      if (need.page_scope !== "main-only" || openPage || closePage || pages && pages.max_created !== 1) {
        fail("storage-fault requires main-only cases even when ordinary multiple pages are configured");
      }
      if (!entry.actions.some(action => (fault.windows.ui_assertions as readonly string[]).includes(action))) {
        fail("storage-fault requires a declared content, value or count UI assertion");
      }
    }
  }
}

/** Pure checks over parsed research and the exact protected snapshot; never proves prose completeness or actual program execution. */
export function evaluateDeclaredMeasurementPlanV1(input: {
  research: Pick<ProductResearchReport, "requirements" | "measurement_plan">;
  policy: MeasurementPlanPolicyV1;
  capabilities: VerificationCapabilities;
}): MeasurementPlanFeasibilityV1 {
  const { research, capabilities } = input;
  const local = MeasurementPlanPolicyV1Schema.safeParse(input.policy), advertised = MeasurementPlanPolicyV1Schema.safeParse(capabilities.measurement_plan_policy);
  if (!local.success || !advertised.success || local.data.version !== advertised.data.version || local.data.coverage !== advertised.data.coverage) {
    throw new Error("Measurement-plan policy must match the protected capability snapshot");
  }
  const plan = parsePlan(research.measurement_plan);
  const expected = new Set(research.requirements.filter(requirement => requirement.priority === "must")
    .flatMap(requirement => requirement.acceptance_criteria.map((_, criterion_index) => criterionKey({ requirement_id: requirement.id, criterion_index }))));
  if (expected.size < 1 || expected.size > MAX_MEASUREMENT_PLAN_CRITERIA) throw new Error("Measurement plan requires a bounded nonempty set of must criteria");
  const mustCount = expected.size;
  for (const entry of plan.entries) {
    if (!expected.delete(criterionKey(entry))) throw new Error(`Measurement plan ${criterionKey(entry)} is not a required criterion`);
  }
  if (expected.size) throw new Error(`Measurement plan is missing must criterion ${expected.values().next().value}`);
  if (plan.profile_digest !== capabilities.profile_digest) throw new Error("Measurement plan profile digest differs from the protected snapshot");
  const checks = new Map(capabilities.checks.map(check => [check.command_id, check]));
  if (checks.size !== capabilities.checks.length) throw new Error("Measurement plan requires unique configured command IDs");
  const used = new Map<string, MeasurementPlanSummaryV1["used_checks"][number]>();
  for (const entry of plan.entries) {
    const check = checks.get(entry.command_id);
    if (!check || check.config_digest !== entry.config_digest || check.contract_digest !== entry.contract_digest) {
      throw new Error(`Measurement plan ${criterionKey(entry)} has an unknown or mismatched command/config/contract binding`);
    }
    validateMethod(entry, check.contract);
    used.set(check.command_id, { command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest });
  }
  return { must_criterion_count: mustCount, mapped_criterion_count: plan.entries.length,
    used_checks: [...used.values()].sort((a, b) => compare(a.command_id, b.command_id)), canonical_plan: canonical(plan) };
}

export interface MeasurementPlanFeasibilityV2 extends MeasurementPlanFeasibilityV1 {
  workspace_criterion_count: number;
  release_criterion_count: number;
  pending_release: PendingReleaseCriterionV1[];
}
/** Hashing is supplied by the trusted caller; domain remains usable in browsers without node:crypto. */
export function evaluateDeclaredMeasurementPlanV2(input: {
  research: Pick<ProductResearchReport, "requirements" | "measurement_plan">;
  policy: MeasurementPlanPolicyV2; capabilities: VerificationCapabilities; releaseCapabilities?: ReleaseCapabilitiesV1;
  digest: (canonical: string) => string;
}): MeasurementPlanFeasibilityV2 {
  const { research, capabilities } = input;
  const policy = MeasurementPlanPolicyV2Schema.parse(input.policy);
  if (canonical(policy) !== canonical(MeasurementPlanPolicyV2Schema.parse(capabilities.measurement_plan_policy))) {
    throw new Error("Measurement-plan policy must match the protected capability snapshot");
  }
  const plan = ProductMeasurementPlanV2Schema.parse(research.measurement_plan);
  if (plan.profile_digest !== capabilities.profile_digest) throw new Error("Measurement plan profile digest differs from the protected snapshot");
  if (!capabilities.checks.length || new Set(capabilities.checks.map(check => check.command_id)).size !== capabilities.checks.length
    || capabilities.checks.some(check => check.contract.version !== 3)) throw new Error("Measurement-plan v2 requires unique configured v3 browser checks");
  const expected = new Set(research.requirements.filter(item => item.priority === "must")
    .flatMap(item => item.acceptance_criteria.map((_, criterion_index) => criterionKey({ requirement_id: item.id, criterion_index }))));
  if (!expected.size || expected.size > MAX_MEASUREMENT_PLAN_CRITERIA) throw new Error("Measurement plan requires bounded must criteria");
  const must_criterion_count = expected.size, used = new Map<string, MeasurementPlanSummaryV1["used_checks"][number]>();
  const pending_release: PendingReleaseCriterionV1[] = [];
  let workspace_criterion_count = 0;
  const release = input.releaseCapabilities === undefined ? undefined : ReleaseCapabilitiesV1Schema.parse(input.releaseCapabilities);
  for (const entry of plan.entries) {
    if (!expected.delete(criterionKey(entry))) throw new Error(`Measurement plan ${criterionKey(entry)} is not a unique required criterion`);
    if (entry.method === "workspace-check") {
      const check = capabilities.checks.find(item => item.command_id === entry.command_id);
      if (!check || check.config_digest !== entry.config_digest || check.contract_digest !== entry.contract_digest) {
        throw new Error(`Measurement plan ${criterionKey(entry)} has a mismatched check binding`);
      }
      validateMethod(entry, check.contract); workspace_criterion_count++;
      used.set(check.command_id, { command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest });
    } else {
      if (!release || canonicalReleaseJson(entry.release_binding) !== canonicalReleaseJson(release.binding)
        || release.binding.verification_profile_digest !== plan.profile_digest) throw new Error("Release mapping differs from the protected release capability");
      const requirement = research.requirements.find(item => item.id === entry.requirement_id)!;
      if (requirement.acceptance_criteria[entry.criterion_index] !== CONFIGURED_STATIC_PUBLICATION_STATEMENT) {
        throw new Error("Only the exact configured static publication criterion can remain pending release");
      }
      pending_release.push(PendingReleaseCriterionV1Schema.parse({ requirement_id: entry.requirement_id, criterion_index: entry.criterion_index,
        criterion_digest: input.digest(canonicalReleaseCriterion(requirement, entry.criterion_index)), claim_id: entry.claim_id,
        statement_digest: entry.statement_digest, release_binding: entry.release_binding }));
    }
  }
  if (expected.size) throw new Error(`Measurement plan is missing must criterion ${expected.values().next().value}`);
  if (!workspace_criterion_count) throw new Error("Static product acceptance requires workspace measurements");
  return { must_criterion_count, mapped_criterion_count: plan.entries.length, workspace_criterion_count,
    release_criterion_count: pending_release.length, pending_release: pending_release.sort(compareCriterionRefs),
    used_checks: [...used.values()].sort((a, b) => compare(a.command_id, b.command_id)), canonical_plan: canonical(plan) };
}
