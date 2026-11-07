import { describe, expect, it } from "vitest";
import { ProductBrowserProgramV3Schema } from "./browser-program-v3.js";
import { BrowserOperationTraceV3Schema } from "./browser-operation-trace-v3.js";
import { ProductDesignSchema, productDevelopmentContext } from "./product-development.js";
import { StaticWebCapabilitiesSchema, VerificationCapabilitiesContextSchema } from "./verification-capabilities.js";
import { StaticWebAcceptanceReportSchema, VerificationObservationSchema } from "./verification-observation.js";
import { ProductStorageChecksV1Schema, StorageFaultCapabilitiesV1Schema, StorageFaultReportV1Schema, StorageFaultTraceV1Schema,
  storageFaultCapabilitiesV1, storageFaultReportFromTraceV1, validateProductStorageChecksV1 } from "./storage-fault.js";

const digest = `sha256:${"a".repeat(64)}`, changedDigest = `sha256:${"b".repeat(64)}`;
const viewport = { id: "phone", width: 390, height: 844 };
const binding = { version: 1, command_id: "browser", profile_digest: digest, config_digest: digest, contract_digest: digest };
const program = () => ProductBrowserProgramV3Schema.parse({ version: 3, contract_digest: digest, steps: [
  { action: "navigate", page: "main", path: "/" },
  { action: "assert_text", page: "main", selector: "#status", text: "Could not load" },
  { action: "fill", page: "main", selector: "#entry", value: "Draft" },
  { action: "click", page: "main", selector: "#save" },
  { action: "assert_text", page: "main", selector: "#status", text: "Could not save" },
  { action: "assert_value", page: "main", selector: "#entry", value: "Draft" },
  { action: "reload", page: "main" },
  { action: "assert_count", page: "main", selector: ".error", count: 1 },
] });
const checks = () => ProductStorageChecksV1Schema.parse({ version: 1, windows: [
  { id: "read", page: "main", mode: "read-security", arm_before_step: 0, settle_after_step: 1,
    requirement_criteria: [{ requirement_id: "storage", criterion_index: 0 }], ui_assertion_steps: [1],
    min_hits: 1, native_storage: { scope: "all", comparison: "sampled-equal" } },
  { id: "write", page: "main", mode: "write-quota", arm_before_step: 3, settle_after_step: 5,
    requirement_criteria: [{ requirement_id: "storage", criterion_index: 1 }], ui_assertion_steps: [4, 5],
    min_hits: 1, native_storage: { scope: "all", comparison: "sampled-equal" } },
  { id: "reload", page: "main", mode: "read-security", arm_before_step: 6, settle_after_step: 7,
    requirement_criteria: [{ requirement_id: "storage", criterion_index: 0 }], ui_assertion_steps: [7],
    min_hits: 1, native_storage: { scope: "all", comparison: "sampled-equal" } },
] });
const design = () => ({ version: 1, requirement_ids: ["storage"], information_architecture: ["Editor"],
  user_flows: [{ id: "write", name: "Write", requirement_ids: ["storage"], steps: ["Save an entry"] }],
  screens: [{ id: "editor", name: "Editor", purpose: "Write", states: ["Empty"], accessibility: ["Labels"], responsive: ["Phone"] }],
  prototype: { entrypoint: "product/index.html", description: "Editor" }, data_model: [], api_contracts: [],
  decisions: [{ decision: "Local storage", rationale: "Offline" }], validation_cases: [{ id: "storage", requirement_ids: ["storage"],
    procedure: ["Save draft"], expected_result: "Error and draft retained", browser_program: program(), storage_checks: checks() }] });
const trace = () => StorageFaultTraceV1Schema.parse({ version: 1, checks_digest: digest, windows: checks().windows.map((window, i) => ({
  id: window.id, page_id: "main", mode: window.mode, arm_before_step: window.arm_before_step, settle_after_step: window.settle_after_step,
  start_step_digest: digest, end_step_digest: digest, requirement_criteria: window.requirement_criteria, ui_assertion_steps: window.ui_assertion_steps,
  baseline_phase: i === 0 ? "first-document-paused" : "before-step", document_epoch: i === 2 ? 2 : 1,
  installation: { script_digest: digest, confirmed: true }, sequence: ["baseline", "armed", "settled", "disarmed"],
  hits: { baseline: i, final: i + 1, delta: 1 },
  native_storage: { scope: "all", comparison: "sampled-equal", equal: true,
    before: { digest, key_count: 1, utf8_bytes: 10 }, after: { digest, key_count: 1, utf8_bytes: 10 } },
  events: { coverage: "observed-only", observed_mutations: 0 },
})) });
const fullTrace = () => ({ version: 3, format: "static-web-trace.v3", case_id: "storage", viewport, device_scale_factor: 1,
  program_digest: digest, captures: [{ page_id: "main", timing: { kind: "case-end" }, screenshot_digest: digest }],
  operations: program().steps.map((step, index) => ({ index, action: step.action, page_id: step.page, planned_step_digest: digest,
    observation: ["navigate", "reload"].includes(step.action) ? { kind: "navigation", status_code: 200 }
      : step.action.startsWith("assert_") ? { kind: "assertion", passed: true } : { kind: "action-completed" } })),
  storage_fault: trace(),
});
const contract = () => ({ version: 3, kind: "static-web", claim: "configured", browser_steps_version: 3, legacy_browser_steps: "rejected",
  actions: ["navigate", "reload", "assert_text"], viewports: [viewport], device_scale_factor: 1,
  stage_policy: { research: "no-browser", design: "declared-cases", implementation: "declared-cases", validation: "declared-cases" },
  screenshots: "each-created-page-visible-viewport", pages: { max_pages: 3, counting: "cumulative-created", same_origin: true,
    same_browser_context: true, name_reuse: "rejected", main_close: "rejected" },
  limits: { max_cases: 50, max_steps_per_case: 100, action_timeout_ms: 5000 }, checks: ["horizontal-overflow"],
  keyboard: { allowed_keys: ["Tab"], typing_max_length: 1000, focus_setup: "programmatic", focus_scope: "main-frame-dom" },
  unavailable: ["native-screen-reader", "browser-zoom"], storage_fault: storageFaultCapabilitiesV1(digest) });

describe("optional v3 storage check sidecars", () => {
  it("retains exact criterion and UI references and permits first-load, interaction and later-reload windows", () => {
    expect(() => validateProductStorageChecksV1(program().steps, checks(), ["storage"])).not.toThrow();
    expect(ProductDesignSchema.parse(design())).toEqual(design());
    const old = design(); delete (old.validation_cases[0] as Partial<typeof old.validation_cases[number]>).storage_checks;
    expect(ProductDesignSchema.parse(old)).toEqual(old);
    expect(ProductDesignSchema.parse(old).validation_cases[0]).not.toHaveProperty("storage_checks");
  });

  it("rejects unknown versions, keys, modes, unsupported claims and unbounded values", () => {
    const first = checks().windows[0]!;
    for (const change of [{ id: "" }, { id: "a".repeat(129) }, { id: "中文" }, { page: "peer" }, { mode: "none" },
      { min_hits: 0 }, { min_hits: 2 }, { arm_before_step: -1 }, { arm_before_step: 0.5 }, { settle_after_step: 100 },
      { settle_after_step: Infinity }, { script: "setup()" }, { native_storage: { scope: "key", comparison: "sampled-equal" } },
      { native_storage: { scope: "all", comparison: "no-mutation-in-window" } },
      { requirement_criteria: [] }, { requirement_criteria: [{ requirement_id: "storage", criterion_index: 100 }] },
      { requirement_criteria: [first.requirement_criteria[0], first.requirement_criteria[0]] },
      { ui_assertion_steps: [] }, { ui_assertion_steps: [1, 1] }, { ui_assertion_steps: [0, 2] }]) {
      expect(ProductStorageChecksV1Schema.safeParse({ version: 1, windows: [{ ...first, ...change }] }).success).toBe(false);
    }
    for (const changed of [{ version: 2, windows: [first] }, { version: 1, windows: [] }, { ...checks(), extra: true },
      { version: 1, windows: Array.from({ length: 5 }, (_, i) => ({ ...first, id: `w${i}`, arm_before_step: i * 2,
        settle_after_step: i * 2 + 1, ui_assertion_steps: [i * 2 + 1] })) }]) {
      expect(ProductStorageChecksV1Schema.safeParse(changed).success).toBe(false);
    }
  });

  it("rejects reused IDs, overlaps, reversed ranges and unknown steps or case requirements", () => {
    const first = checks().windows[0]!, next = checks().windows[1]!;
    for (const windows of [[first, { ...next, id: first.id }], [next, first], [first, { ...next, arm_before_step: 1 }],
      [{ ...first, arm_before_step: 2 }]]) expect(ProductStorageChecksV1Schema.safeParse({ version: 1, windows }).success).toBe(false);
    expect(() => validateProductStorageChecksV1(program().steps.slice(0, 7), checks())).toThrow("absent step");
    expect(() => validateProductStorageChecksV1(program().steps, checks(), ["other"])).toThrow("outside its case");
  });

  it("rejects legacy programs, multiple pages and navigation inside an active window", () => {
    const value = design(), test = value.validation_cases[0]!;
    for (const browser_program of [undefined, { ...program(), version: 2 }]) {
      expect(ProductDesignSchema.safeParse({ ...value, validation_cases: [{ ...test, browser_program }] }).success).toBe(false);
    }
    expect(ProductDesignSchema.safeParse({ ...value, validation_cases: [{ ...test, browser_program: undefined,
      browser_steps: [{ action: "navigate", path: "/" }, { action: "assert_text", selector: "body", text: "Error" }] }] }).success).toBe(false);
    const steps = program().steps;
    for (const action of ["navigate", "reload", "open_page", "close_page"]) {
      expect(() => validateProductStorageChecksV1(steps.map((step, i) => i === 4 ? { action, page: "main" } : step), checks())).toThrow();
    }
    expect(() => validateProductStorageChecksV1(steps.map((step, i) => i === 2 ? { ...step, page: "peer" } : step), checks())).toThrow("main-only");
    for (const action of ["assert_visible", "assert_hidden", "assert_focused", "assert_focus_within", "click"]) {
      expect(() => validateProductStorageChecksV1(steps.map((step, i) => i === 1 ? { action, page: "main" } : step), checks())).toThrow("UI assertions");
    }
  });
});

describe("actual storage evidence", () => {
  it("projects only fresh hits and sampled native equality from the actual bounded trace", () => {
    expect(BrowserOperationTraceV3Schema.parse(fullTrace())).toEqual(fullTrace());
    const summary = storageFaultReportFromTraceV1(trace());
    expect(summary).toEqual({ version: 1, checks_digest: digest, windows: ["read", "write", "reload"].map((id, i) => ({
      id, mode: i === 1 ? "write-quota" : "read-security", fresh_hits: 1,
      native_storage: { scope: "all", comparison: "sampled-equal", digest }, events: { coverage: "observed-only", observed_mutations: 0 },
    })) });
    expect(summary).not.toHaveProperty("sequence");
    expect(summary.windows[0]).not.toHaveProperty("raw_values");
    expect(StorageFaultReportV1Schema.parse(summary)).toEqual(summary);
  });

  it("rejects non-fresh, inconsistent, unsafe and non-finite counter claims", () => {
    const actual = trace();
    for (const hits of [{ baseline: 1, final: 1, delta: 0 }, { baseline: 2, final: 3, delta: 2 },
      { baseline: 2, final: 1, delta: 1 }, { baseline: -1, final: 1, delta: 2 }, { baseline: 0, final: 1.5, delta: 1.5 },
      { baseline: 0, final: Number.MAX_SAFE_INTEGER + 1, delta: Number.MAX_SAFE_INTEGER + 1 },
      { baseline: 0, final: Infinity, delta: Infinity }, { baseline: NaN, final: 1, delta: 1 }]) {
      expect(StorageFaultTraceV1Schema.safeParse({ ...actual, windows: [{ ...actual.windows[0], hits }] }).success).toBe(false);
    }
  });

  it("requires matching bounded native snapshots and observed-only zero-mutation results", () => {
    const window = trace().windows[0]!, native = window.native_storage;
    for (const change of [{ equal: false }, { scope: "selected" }, { comparison: "no-mutation-in-window" },
      { after: { ...native.after, digest: changedDigest } }, { after: { ...native.after, key_count: 2 } },
      { after: { ...native.after, utf8_bytes: 11 } }, { before: { ...native.before, key_count: 513 } },
      { before: { ...native.before, utf8_bytes: 1048577 } }, { before: { ...native.before, key_count: 0 } },
      { before: { ...native.before, raw_values: { private: "value" } } }]) {
      expect(StorageFaultTraceV1Schema.safeParse({ version: 1, checks_digest: digest,
        windows: [{ ...window, native_storage: { ...native, ...change } }] }).success).toBe(false);
    }
    for (const events of [{ coverage: "complete", observed_mutations: 0 }, { coverage: "observed-only", observed_mutations: 1 },
      { coverage: "observed-only", observed_mutations: 0, no_mutation: true }]) {
      expect(StorageFaultTraceV1Schema.safeParse({ version: 1, checks_digest: digest, windows: [{ ...window, events }] }).success).toBe(false);
    }
  });

  it("binds baseline phases, actual operation digests, sequence and new-document epochs", () => {
    const full = fullTrace(), fault = full.storage_fault, first = fault.windows[0]!, last = fault.windows[2]!;
    for (const change of [{ start_step_digest: changedDigest }, { end_step_digest: changedDigest }, { document_epoch: 2 },
      { document_epoch: 0 }, { document_epoch: 101 }, { baseline_phase: "before-step" },
      { installation: { script_digest: digest, confirmed: false } }, { installation: { script_digest: "claimed", confirmed: true } },
      { sequence: ["baseline", "settled", "armed", "disarmed"] }, { sequence: ["baseline", "armed", "settled"] },
      { ui_assertion_steps: [0] }]) {
      expect(BrowserOperationTraceV3Schema.safeParse({ ...full, storage_fault: { ...fault, windows: [{ ...first, ...change }] } }).success).toBe(false);
    }
    for (const change of [{ baseline_phase: "first-document-paused" }, { document_epoch: 1 }]) {
      expect(BrowserOperationTraceV3Schema.safeParse({ ...full, storage_fault: { ...fault, windows: [{ ...last, ...change }] } }).success).toBe(false);
    }
    // The later navigation baseline precedes the new faulted document; its expected phase remains before-step.
    expect(BrowserOperationTraceV3Schema.safeParse({ ...full, storage_fault: { ...fault, windows: [last] } }).success).toBe(true);
  });

  it("rejects altered report claims and keeps the optional extension confined to single-page v3 cases", () => {
    const full = fullTrace(), summary = storageFaultReportFromTraceV1(full.storage_fault);
    const measuredCase = { case_id: "storage", viewport, program_digest: digest, assertions: 4, operation_count: full.operations.length,
      trace_digest: digest, trace_size: JSON.stringify(full).length, captures: full.captures, storage_fault: summary };
    const report = { version: 3, format: "static-web-acceptance.v3", stage: "validation", passed: true, requirements: 1,
      device_scale_factor: 1, capability_binding: binding, cases: [measuredCase] };
    expect(StaticWebAcceptanceReportSchema.parse(report)).toEqual(report);
    const observation = { version: 3, format: "static-web-acceptance.v3", stage: "validation", scope: "final",
      device_scale_factor: 1, capability_binding: binding, evidence_bundle: { bundle_id: "bundle", manifest_digest: digest },
      cases: [{ ...measuredCase, trace_ref: "trace", captures: [{ ...full.captures[0], screenshot_ref: "image" }] }] };
    expect(VerificationObservationSchema.parse(observation)).toEqual(observation);
    for (const change of [{ fresh_hits: 0 }, { fresh_hits: Number.MAX_SAFE_INTEGER + 1 },
      { events: { coverage: "complete", observed_mutations: 0 } }, { raw_values: [] }]) {
      expect(StorageFaultReportV1Schema.safeParse({ ...summary, windows: [{ ...summary.windows[0], ...change }] }).success).toBe(false);
    }
    expect(StorageFaultReportV1Schema.safeParse({ ...summary, windows: [summary.windows[0], summary.windows[0]] }).success).toBe(false);
    expect(StaticWebAcceptanceReportSchema.safeParse({ ...report, cases: [{ ...measuredCase,
      captures: [...full.captures, { ...full.captures[0], page_id: "peer" }] }] }).success).toBe(false);
    expect(StaticWebAcceptanceReportSchema.safeParse({ ...report, version: 2, format: "static-web-acceptance.v2",
      cases: [{ ...measuredCase, captures: [{ page_id: "main", screenshot_digest: digest }] }] }).success).toBe(false);
  });
});

describe("configured limited storage capability and conditional guidance", () => {
  it("exposes fixed exception entries, limits and unsupported stronger claims", () => {
    const extension = storageFaultCapabilitiesV1(digest);
    expect(StorageFaultCapabilitiesV1Schema.parse(extension)).toEqual(extension);
    expect(StaticWebCapabilitiesSchema.parse(contract())).toEqual(contract());
    for (const change of [{ version: 2 }, { initializer_digest: "claimed" }, { modes: extension.modes.slice(0, 1) },
      { cases: { ...extension.cases, page: "any" } }, { windows: { ...extension.windows, max_windows: 5 } },
      { windows: { ...extension.windows, documents_per_window: 2 } },
      { native_storage: { ...extension.native_storage, comparison: "no-mutation-in-window" } },
      { events: { ...extension.events, coverage: "complete" } }, { events: { ...extension.events, max_observed_events_per_case: 513 } },
      { unavailable: extension.unavailable.slice(1) }]) {
      expect(StorageFaultCapabilitiesV1Schema.safeParse({ ...extension, ...change }).success).toBe(false);
    }
    extension.modes[0].entry = "polluted" as typeof extension.modes[0]["entry"];
    expect(storageFaultCapabilitiesV1(digest).modes[0].entry).toBe("Window.localStorage.get");
  });

  it("adds scoped storage instructions only for an explicitly configured v3 extension", () => {
    const capabilities = VerificationCapabilitiesContextSchema.parse({ version: 1, profile_id: "profile", profile_digest: digest,
      checks: [{ command_id: "browser", config_digest: digest, contract_digest: digest, contract: contract() }] });
    const legacy = structuredClone(capabilities);
    const { storage_fault: _extension, ...unoptedContract } = contract();
    legacy.checks[0]!.contract = StaticWebCapabilitiesSchema.parse(unoptedContract);
    for (const stage of ["research", "design", "implementation", "validation"] as const) {
      expect(productDevelopmentContext(stage, legacy)).toEqual(productDevelopmentContext(stage));
      expect(JSON.stringify(productDevelopmentContext(stage))).not.toContain("storage_checks");
      const actual = productDevelopmentContext(stage, capabilities), instructions = actual.instructions.join("\n");
      expect(actual.instructions.length).toBeLessThanOrEqual(20);
      expect(instructions).toContain("observed-only");
      expect(instructions).toContain("all localStorage entries at two samples");
      expect(instructions).toContain("Preserve stronger original requirements as unmet");
      expect(instructions).toContain("spontaneous navigation are rejected even outside windows");
      expect(instructions).not.toContain("multi-device collaboration, storage exceptions, native screen-reader");
    }
  });
});
