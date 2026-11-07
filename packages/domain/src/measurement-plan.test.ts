import { describe, expect, it } from "vitest";
import { AllowedBrowserKeySchema, BrowserActionV2Schema } from "./browser-program.js";
import { BrowserActionV3Schema } from "./browser-program-v3.js";
import { storageFaultCapabilitiesV1 } from "./storage-fault.js";
import { ProductResearchReportSchema, ProductResearchReportV1Schema, productDevelopmentContext } from "./product-development.js";
import { StaticWebActionSchema, StaticWebCapabilitiesSchema, VerificationCapabilitiesContextSchema, VerificationCapabilitiesSchema } from "./verification-capabilities.js";
import { RunVerificationPayloadSchema } from "./autonomy.js";
import { ReviewVerificationContextSchema, StaticWebAcceptanceReportSchema } from "./verification-observation.js";
import { MeasurementPlanPolicyV1Schema, MeasurementNeedV1Schema, ProductMeasurementPlanV1Schema, MeasurementPlanSummaryV1Schema,
  canonicalMeasurementPlanV1, evaluateDeclaredMeasurementPlanV1, type MeasurementNeedV1, type MeasurementPlanSummaryV1 } from "./measurement-plan.js";

const hash = (digit = "a") => `sha256:${digit.repeat(64)}`;
const policy = { version: 1 as const, coverage: "every-must-criterion" as const };
const binding = { command_id: "browser", config_digest: hash("b"), contract_digest: hash("c") };
function contract(version: 1 | 2 | 3 = 3, storage = false) {
  return StaticWebCapabilitiesSchema.parse({ version, kind: "static-web", claim: "configured", browser_steps_version: version,
    actions: version === 1 ? StaticWebActionSchema.options : version === 2 ? BrowserActionV2Schema.options : BrowserActionV3Schema.options,
    viewports: [{ id: version === 1 ? "width-390" : "compact", width: 390, height: version === 1 ? 900 : 844 }],
    stage_policy: { research: "no-browser", design: "prototype-only", implementation: "declared-cases", validation: "declared-cases" },
    screenshots: version === 3 ? "each-created-page-visible-viewport" : "final-visible-viewport",
    pages: version === 3 ? { max_pages: 3, counting: "cumulative-created", same_origin: true, same_browser_context: true, name_reuse: "rejected", main_close: "rejected" }
      : { max_pages: 1, same_browser_context: true },
    limits: { max_cases: 50, max_steps_per_case: 100, action_timeout_ms: 1000 }, checks: ["horizontal-overflow", "dom-control-name-heuristic"],
    unavailable: [...(version === 1 ? ["keyboard-navigation"] : []), ...(version < 3 ? ["multiple-pages"] : []),
      ...(storage ? [] : ["storage-exception-injection"]), "native-screen-reader", "browser-zoom"],
    ...(version >= 2 ? { legacy_browser_steps: "rejected", device_scale_factor: 1, keyboard: { allowed_keys: AllowedBrowserKeySchema.options,
      typing_max_length: 1000, focus_setup: "programmatic", focus_scope: "main-frame-dom" } } : {}),
    ...(storage ? { storage_fault: storageFaultCapabilitiesV1(hash("d")) } : {}),
  });
}
function fixture(version: 1 | 2 | 3 = 3, storage = false) {
  const configured = contract(version, storage);
  const capabilities = VerificationCapabilitiesSchema.parse({ version: 1, profile_digest: hash(), measurement_plan_policy: policy,
    checks: [{ ...binding, contract: configured }] });
  const plan = ProductMeasurementPlanV1Schema.parse({ version: 1, profile_digest: hash(), entries: [0, 1].map(criterion_index => ({
    ...binding, requirement_id: "save", criterion_index, actions: ["navigate", "click", "assert_text"], keys: [],
    viewports: configured.viewports, needs: [],
  })) });
  const research = ProductResearchReportV1Schema.parse({ version: 1, objective: "Storage app", assumptions: [],
    requirements: [{ id: "save", description: "Keep data", priority: "must", acceptance_criteria: ["Saved data remains", "Saved data remains"] },
      { id: "optional", description: "Nice to have", priority: "should", acceptance_criteria: ["Extra theme"] }],
    sources: [{ id: "spec", url: "https://example.com/spec", title: "Controlled schema fixture", retrieved_at: "2026-11-05T00:00:00Z", content_digest: hash() }],
    findings: [{ summary: "Storage behavior", source_ids: ["spec"] }], decisions: [], measurement_plan: plan });
  return { capabilities, research, plan: research.measurement_plan!, evaluate: () => evaluateDeclaredMeasurementPlanV1({ research, policy, capabilities }) };
}
const storageNeed = (mode: "read-security" | "write-quota" = "read-security"): MeasurementNeedV1 => ({ kind: "storage-fault", version: 1,
  mode, invariant: "sampled-equal", page_scope: "main-only", api_scope: "fixed-entry" });
function summary(): MeasurementPlanSummaryV1 {
  return { version: 1, claim: "declared-mapping-feasibility", scope: "final", policy,
    research: { path: ".artoo/product/research.json", checksum: hash("e"), size: 1000 }, measurement_plan_digest: hash("f"),
    must_criterion_count: 2, mapped_criterion_count: 2, used_checks: [{ ...binding }] };
}
function receipts() {
  const measurement = summary();
  const observation = { version: 3, format: "static-web-acceptance.v3", scope: "final", stage: "research", device_scale_factor: 1,
    capability_binding: { ...binding, version: 1, profile_digest: hash() }, cases: [], evidence_bundle: { bundle_id: "browser_fixture", manifest_digest: hash() } };
  const run = { version: 1, request_id: "request", profile_id: "profile", profile_digest: hash(), subject_digest: hash(), outcome: "passed",
    checks: [{ id: "browser", exit_code: 0, duration_ms: 1, output_digest: hash(), observation }], required_files: [measurement.research], measurement_plan: measurement };
  const review = { version: 1, request_id: "request", profile_id: "profile", profile_digest: hash(),
    checks: [{ id: "browser", output_digest: hash(), observation }], measurement_plan: measurement };
  return { run, review, measurement, observation };
}

describe("declared measurement-plan feasibility", () => {
  it.each([1, 2, 3] as const)("accepts exact configured v%i mappings without inventing executed browser observations", version => {
    const f = fixture(version), before = JSON.stringify(f.research), result = f.evaluate();
    expect(result.must_criterion_count).toBe(2); expect(result.mapped_criterion_count).toBe(2);
    expect(result.used_checks).toEqual([binding]); expect(result.canonical_plan).toBe(canonicalMeasurementPlanV1(f.plan));
    expect(result).not.toHaveProperty("assertions"); expect(result).not.toHaveProperty("passed");
    expect(JSON.stringify(f.research)).toBe(before);
  });
  it.each(["missing", "duplicate", "unknown", "out-of-range", "should", "extra"])("requires exact criterion identities, including identical prose at separate indices: %s", change => {
    const f = fixture();
    if (change === "missing") f.plan.entries.pop();
    if (change === "duplicate") f.plan.entries[1]!.criterion_index = 0;
    if (change === "unknown") f.plan.entries[1]!.requirement_id = "unknown";
    if (change === "out-of-range") f.plan.entries[1]!.criterion_index = 2;
    if (change === "should") { f.plan.entries[1]!.requirement_id = "optional"; f.plan.entries[1]!.criterion_index = 0; }
    if (change === "extra") f.plan.entries.push({ ...structuredClone(f.plan.entries[0]!), criterion_index: 2 });
    expect(() => f.evaluate()).toThrow(/Measurement plan|measurement-plan/);
  });
  it.each(["missing-plan", "local-policy", "public-policy", "profile", "command", "config", "contract", "generic"])("rejects absent authority or changed binding: %s", change => {
    const f = fixture();
    if (change === "missing-plan") delete f.research.measurement_plan;
    if (change === "public-policy") delete f.capabilities.measurement_plan_policy;
    if (change === "profile") f.plan.profile_digest = hash("0");
    if (change === "command") f.plan.entries[0]!.command_id = "other";
    if (change === "config") f.plan.entries[0]!.config_digest = hash("0");
    if (change === "contract") f.plan.entries[0]!.contract_digest = hash("0");
    if (change === "generic") Object.assign(f.capabilities.checks[0]!.contract, { kind: "generic-command" });
    if (change === "local-policy") expect(() => evaluateDeclaredMeasurementPlanV1({ ...f, policy: { version: 2 } as never })).toThrow(/policy/);
    else expect(() => f.evaluate()).toThrow();
  });
  it("returns the unique used checks sorted independently of entry order", () => {
    const f = fixture(), other = { ...structuredClone(f.capabilities.checks[0]!), command_id: "aaa", config_digest: hash("1") };
    f.capabilities.checks.push(other); Object.assign(f.plan.entries[1]!, { command_id: other.command_id, config_digest: other.config_digest });
    expect(f.evaluate().used_checks.map(check => check.command_id)).toEqual(["aaa", "browser"]);
    const result = f.evaluate(); result.used_checks[0]!.config_digest = hash("0");
    expect(f.capabilities.checks[1]!.config_digest).toBe(hash("1"));
  });
  it.each(["navigation-only", "visible-only", "viewport-id", "viewport-width", "viewport-height", "duplicate-viewport", "unknown-action", "duplicate-action"])("rejects unsupported or incomplete declared primitives: %s", change => {
    const f = fixture(), entry = f.plan.entries[0]!;
    if (change === "navigation-only") entry.actions = ["navigate"];
    if (change === "visible-only") entry.actions = ["assert_visible"];
    if (change === "viewport-id") entry.viewports[0]!.id = "wrong";
    if (change === "viewport-width") entry.viewports[0]!.width++;
    if (change === "viewport-height") entry.viewports[0]!.height++;
    if (change === "duplicate-viewport") entry.viewports.push({ ...entry.viewports[0]! });
    if (change === "unknown-action") Object.assign(entry, { actions: ["evaluate", "assert_text"] });
    if (change === "duplicate-action") entry.actions.push("assert_text");
    expect(() => f.evaluate()).toThrow();
  });
  it("supports configured keyboard events and main-frame focus, separately from programmatic setup", () => {
    const f = fixture(2), entry = f.plan.entries[0]!;
    entry.actions = ["navigate", "press", "type_text", "assert_focused"]; entry.keys = ["Tab"];
    entry.needs = [{ kind: "keyboard-events" }, { kind: "focus", scope: "main-frame-dom" }];
    expect(() => f.evaluate()).not.toThrow();
    entry.actions = ["navigate", "focus", "assert_text"]; entry.keys = []; entry.needs = [{ kind: "keyboard-events" }, { kind: "focus", scope: "main-frame-dom" }];
    expect(() => f.evaluate()).toThrow(/keyboard-events/);
  });
  it.each(["press-no-keys", "keys-no-press", "no-keyboard-need", "no-focus-need", "shadow", "frame", "unknown-key", "unconfigured-key", "v1-keyboard"])("rejects keyboard/focus inconsistency: %s", change => {
    const f = fixture(change === "v1-keyboard" ? 1 : 2), entry = f.plan.entries[0]!;
    entry.actions = ["navigate", "press", "assert_focused"]; entry.keys = ["Tab"];
    entry.needs = [{ kind: "keyboard-events" }, { kind: "focus", scope: "main-frame-dom" }];
    if (change === "press-no-keys") entry.keys = [];
    if (change === "keys-no-press") entry.actions = ["navigate", "assert_focused"];
    if (change === "no-keyboard-need") entry.needs.shift();
    if (change === "no-focus-need") entry.needs.pop();
    if (change === "shadow") entry.needs[1] = { kind: "focus", scope: "shadow-dom" };
    if (change === "frame") entry.needs[1] = { kind: "focus", scope: "frame-dom" };
    if (change === "unknown-key") Object.assign(entry, { keys: ["Control+C"] });
    if (change === "unconfigured-key") {
      const configured = f.capabilities.checks[0]!.contract; if (configured.version !== 1) configured.keyboard.allowed_keys = ["Enter"];
    }
    expect(() => f.evaluate()).toThrow();
  });
  it.each(["v1", "v2", "over-limit", "no-need", "one-page", "cross-origin", "separate-context", "no-open"])("rejects impossible page claims: %s", change => {
    const f = fixture(change === "v1" ? 1 : change === "v2" ? 2 : 3), entry = f.plan.entries[0]!;
    entry.actions = ["navigate", "open_page", "close_page", "assert_text"];
    const pages = { kind: "pages" as const, max_created: 3, same_origin: true, same_browser_context: true }; entry.needs = [pages];
    if (change === "over-limit") pages.max_created = 4;
    if (change === "no-need") entry.needs = [];
    if (change === "one-page") pages.max_created = 1;
    if (change === "cross-origin") pages.same_origin = false;
    if (change === "separate-context") pages.same_browser_context = false;
    if (change === "no-open") entry.actions = ["navigate", "close_page", "assert_text"];
    expect(() => f.evaluate()).toThrow();
  });
  it("admits cumulative v3 pages and the older single-page meaning", () => {
    for (const version of [1, 2, 3] as const) {
      const f = fixture(version), entry = f.plan.entries[0]!;
      entry.needs = [{ kind: "pages", max_created: version === 3 ? 3 : 1, same_origin: true, same_browser_context: true }];
      if (version === 3) entry.actions.push("open_page", "close_page");
      expect(() => f.evaluate()).not.toThrow();
    }
  });
  it.each(["read-security", "write-quota"] as const)("accepts only configured I4 %s declared scope", mode => {
    const f = fixture(3, true); f.plan.entries[0]!.needs = [storageNeed(mode)]; expect(() => f.evaluate()).not.toThrow();
    const unopted = fixture(3); unopted.plan.entries[0]!.needs = [storageNeed(mode)]; expect(() => unopted.evaluate()).toThrow(/opted-in/);
  });
  it.each(["invariant", "all-paths", "multi-scope", "combined-pages", "focus-only", "contradictory-contract"])("refuses stronger storage claims without weakening them: %s", change => {
    const f = fixture(3, true), entry = f.plan.entries[0]!, need = storageNeed(); entry.needs = [need];
    if (change === "invariant") Object.assign(need, { invariant: "no-mutation-in-window" });
    if (change === "all-paths") Object.assign(need, { api_scope: "all-paths" });
    if (change === "multi-scope") Object.assign(need, { page_scope: "multiple-pages" });
    if (change === "combined-pages") { entry.actions.push("open_page"); entry.needs.push({ kind: "pages", max_created: 2, same_origin: true, same_browser_context: true }); }
    if (change === "focus-only") { entry.actions = ["navigate", "assert_focused"]; entry.needs.push({ kind: "focus", scope: "main-frame-dom" }); }
    if (change === "contradictory-contract") f.capabilities.checks[0]!.contract.unavailable.push("storage-exception-injection");
    const before = JSON.stringify(f.research); expect(() => f.evaluate()).toThrow(); expect(JSON.stringify(f.research)).toBe(before);
  });
  it("accepts distinct declared storage modes but rejects duplicate needs", () => {
    const f = fixture(3, true); f.plan.entries[0]!.needs = [storageNeed(), storageNeed("write-quota")];
    expect(() => f.evaluate()).not.toThrow(); f.plan.entries[0]!.needs.push(storageNeed()); expect(() => f.evaluate()).toThrow(/Invalid/);
  });
  it.each([{ kind: "native-screen-reader" }, { kind: "browser-zoom", percentage: 200 }])("rejects explicit unsupported needs %j", need => {
    const f = fixture(); f.plan.entries[0]!.needs = [MeasurementNeedV1Schema.parse(need)]; expect(() => f.evaluate()).toThrow(/no installed measurement/);
  });
  it("does not infer semantic completeness from prose whose stronger needs were omitted", () => {
    const f = fixture(); f.research.requirements[0]!.acceptance_criteria[0] = "A native screen reader announces every change at 200% browser zoom";
    const facts = f.evaluate(); expect(facts.mapped_criterion_count).toBe(2); expect(facts).not.toHaveProperty("semantic_coverage");
    expect(MeasurementPlanSummaryV1Schema.parse(summary()).claim).toBe("declared-mapping-feasibility");
    f.plan.entries[0]!.needs = [{ kind: "native-screen-reader" }]; expect(() => f.evaluate()).toThrow();
  });
  it("canonicalizes object property order without reordering entries or mutating research", () => {
    const f = fixture(), original = canonicalMeasurementPlanV1(f.plan);
    const reordered = JSON.parse(JSON.stringify(f.plan), (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value);
    expect(canonicalMeasurementPlanV1(reordered)).toBe(original);
    f.plan.entries.reverse(); expect(canonicalMeasurementPlanV1(f.plan)).not.toBe(original);
  });
  it("bounds declaration input and errors without including requirement prose", () => {
    const f = fixture(), secret = "private criterion text ".repeat(100);
    f.research.requirements[0]!.acceptance_criteria[0] = secret; f.plan.entries.pop();
    try { f.evaluate(); throw new Error("Expected a missing mapping"); } catch (error) {
      expect((error as Error).message.length).toBeLessThan(500); expect((error as Error).message).not.toContain(secret);
    }
    const entries = Array.from({ length: 10000 }, (_, index) => ({ ...f.plan.entries[0]!, requirement_id: `R${Math.floor(index / 100)}`, criterion_index: index % 100 }));
    // This is the schema's count bound; the node separately enforces the full research file's 1 MiB byte bound.
    expect(ProductMeasurementPlanV1Schema.safeParse({ ...f.plan, entries }).success).toBe(true);
    entries.push({ ...entries[0]!, requirement_id: "extra" });
    expect(ProductMeasurementPlanV1Schema.safeParse({ ...f.plan, entries }).success).toBe(false);
    for (const value of [{ kind: "unknown" }, { kind: "storage-fault", version: 2 }, { kind: "keyboard-events", script: "execute" }]) {
      expect(MeasurementNeedV1Schema.safeParse(value).success).toBe(false);
    }
    expect(MeasurementPlanPolicyV1Schema.safeParse({ ...policy, bypass: true }).success).toBe(false);
  });
});

describe("node-only declared-feasibility summaries and optional compatibility", () => {
  it("accepts successful bound research summaries without inventing browser cases", () => {
    const f = receipts(); expect(RunVerificationPayloadSchema.parse(f.run).measurement_plan).toEqual(f.measurement);
    expect(ReviewVerificationContextSchema.parse(f.review).measurement_plan).toEqual(f.measurement);
    expect(f.observation.cases).toEqual([]);
  });
  it.each(["failed", "preview-final-mismatch", "no-file", "file-hash", "file-size", "no-observation", "unknown-check", "config", "contract"])("requires successful measured research and exact observed bindings: %s", change => {
    const f = receipts();
    if (change === "failed") f.run.outcome = "failed";
    if (change === "preview-final-mismatch") f.measurement.scope = "preview";
    if (change === "no-file") f.run.required_files = [];
    if (change === "file-hash") f.run.required_files = [{ ...f.measurement.research, checksum: hash("0") }];
    if (change === "file-size") f.run.required_files = [{ ...f.measurement.research, size: 999 }];
    if (change === "no-observation") delete (f.run.checks[0]! as { observation?: unknown }).observation;
    if (change === "unknown-check") f.measurement.used_checks[0]!.command_id = "other";
    if (change === "config") f.measurement.used_checks[0]!.config_digest = hash("0");
    if (change === "contract") f.measurement.used_checks[0]!.contract_digest = hash("0");
    expect(RunVerificationPayloadSchema.safeParse(f.run).success).toBe(false);
  });
  it("accepts matching preview facts only on the node payload, never the review context", () => {
    const f = receipts(); f.measurement.scope = "preview"; f.observation.scope = "preview";
    expect(RunVerificationPayloadSchema.safeParse(f.run).success).toBe(true);
    expect(ReviewVerificationContextSchema.safeParse(f.review).success).toBe(false);
  });
  it.each(["claim", "unequal-count", "zero-count", "research-path", "research-size", "duplicate-check", "unsorted-checks", "too-many-checks", "extra"])("rejects impossible or broader summary claims: %s", change => {
    const value = summary();
    if (change === "claim") Object.assign(value, { claim: "complete-requirement-coverage" });
    if (change === "unequal-count") value.mapped_criterion_count = 1;
    if (change === "zero-count") value.must_criterion_count = value.mapped_criterion_count = 0;
    if (change === "research-path") Object.assign(value.research, { path: "other.json" });
    if (change === "research-size") value.research.size = 1048577;
    if (change === "duplicate-check") value.used_checks.push({ ...binding });
    if (change === "unsorted-checks") value.used_checks.push({ ...binding, command_id: "aaa" });
    if (change === "too-many-checks") { value.must_criterion_count = value.mapped_criterion_count = 1; value.used_checks.push({ ...binding, command_id: "z" }); }
    if (change === "extra") Object.assign(value, { executable: true });
    expect(MeasurementPlanSummaryV1Schema.safeParse(value).success).toBe(false);
  });
  it("keeps absent extensions out of legacy serialized research, capabilities and receipts", () => {
    const f = fixture(); delete f.research.measurement_plan; delete f.capabilities.measurement_plan_policy;
    expect(JSON.stringify(ProductResearchReportSchema.parse(f.research))).toBe(JSON.stringify(f.research));
    expect(JSON.stringify(VerificationCapabilitiesSchema.parse(f.capabilities))).toBe(JSON.stringify(f.capabilities));
    const measured = receipts(); delete (measured.run as { measurement_plan?: unknown }).measurement_plan;
    delete (measured.review as { measurement_plan?: unknown }).measurement_plan;
    expect(JSON.stringify(RunVerificationPayloadSchema.parse(measured.run))).toBe(JSON.stringify(measured.run));
    expect(JSON.stringify(ReviewVerificationContextSchema.parse(measured.review))).toBe(JSON.stringify(measured.review));
    const current = productDevelopmentContext("research", { checks: f.capabilities.checks });
    expect(current).toEqual(productDevelopmentContext("research"));
  });
  it("advertises conditional guidance and preserves the strict CLI stdout boundary", () => {
    const f = fixture(3, true), context = VerificationCapabilitiesContextSchema.parse({ ...f.capabilities, profile_id: "profile" });
    const instructions = productDevelopmentContext("research", context).instructions.join(" ");
    expect(instructions).toContain("declared-mapping-feasibility"); expect(instructions).toContain("exactly once");
    const report = { version: 1, format: "static-web-acceptance.v1", stage: "research", passed: true, requirements: 1, cases: [], measurement_plan: summary() };
    expect(StaticWebAcceptanceReportSchema.safeParse(report).success).toBe(false);
  });
});
