import { describe, expect, it } from "vitest";
import { ProductBrowserProgramV3Schema } from "./browser-program-v3.js";
import { BrowserOperationTraceV3Schema } from "./browser-operation-trace-v3.js";
import { ProductDesignV2Schema, ProductDesignSchema, ProductResearchReportSchema,
  productDevelopmentContext, validateProductDevelopmentHandoff } from "./product-development.js";
import { MeasurementNeedV1Schema, MeasurementNeedV2Schema, ProductMeasurementPlanV1Schema, ProductMeasurementPlanV2Schema,
  evaluateDeclaredMeasurementPlanV2 } from "./measurement-plan.js";
import { StaticWebCapabilitiesSchema, VerificationCapabilitiesSchema, VerificationCapabilitiesContextSchema } from "./verification-capabilities.js";
import { StaticWebAcceptanceReportSchema, VerificationObservationSchema } from "./verification-observation.js";
import { StorageFaultTraceV1Schema } from "./storage-fault.js";
import { CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST } from "./release-capabilities.js";
import { ProductStoragePreconditionV1Schema, ProductStoragePreconditionBindingV1Schema, StoragePreconditionOptionsV1Schema,
  StoragePreconditionCapabilitiesV1Schema, StoragePreconditionTraceV1Schema, StoragePreconditionReportV1Schema,
  storagePreconditionCapabilitiesV1, storagePreconditionReportFromTraceV1, validateProductStoragePreconditionV1 } from "./storage-precondition.js";

const hash = (letter: string) => `sha256:${letter.repeat(64)}`;
const digest = hash("a"), seededDigest = hash("b"), programDigest = hash("c"), descriptorDigest = hash("d");
const ref = { requirement_id: "storage", criterion_index: 0 };
const viewport = { id: "phone", width: 390, height: 844 };
const policy = { version: 2 as const, coverage: "every-must-criterion" as const,
  methods: ["workspace-check", "configured-static-release"] as ["workspace-check", "configured-static-release"] };
const source = { path: ".artoo/product/design.json" as const, checksum: digest, size: 1024, case_id: "malformed" };
const before = { digest, key_count: 0, utf8_bytes: 0 }, seeded = { digest: seededDigest, key_count: 1, utf8_bytes: 8 };
const need = () => MeasurementNeedV2Schema.parse({ kind: "storage-precondition", version: 1, input: "raw-local-document",
  phase: "before-first-product-script", page_scope: "main-seed-same-origin-pages", preservation: "seeded-sampled-equal" });
const program = () => ProductBrowserProgramV3Schema.parse({ version: 3, contract_digest: digest, steps: [
  { action: "navigate", page: "main", path: "/" },
  { action: "assert_text", page: "main", selector: "#error", text: "Invalid saved data" },
  { action: "click", page: "main", selector: "#retry" },
  { action: "assert_text", page: "main", selector: "#error", text: "Invalid saved data" },
  { action: "assert_value", page: "main", selector: "#draft", value: "Draft retained" },
  { action: "reload", page: "main" },
  { action: "assert_count", page: "main", selector: ".error", count: 1 },
] });
const precondition = () => ProductStoragePreconditionV1Schema.parse({ version: 1, local_storage: { key: "journal", value: "{" },
  requirement_criteria: [ref], ui_assertion_steps: [1, 3, 4, 6], preservation_checks: [
    { after_step: 4, requirement_criteria: [ref], ui_assertion_steps: [3, 4] },
    { after_step: 6, requirement_criteria: [ref], ui_assertion_steps: [6] },
  ] });
const trace = () => StoragePreconditionTraceV1Schema.parse({ version: 1, descriptor_digest: descriptorDigest, source,
  program_digest: programDigest, page_id: "main", document_epoch: 1, origin: "http://127.0.0.1:4174", initial_step_digest: digest,
  installation: { script_digest: digest, confirmed: true }, seed_apply_count: 1,
  sequence: ["empty-baseline", "native-seed-readback", "resumed"],
  requirement_criteria: precondition().requirement_criteria, ui_assertion_steps: precondition().ui_assertion_steps,
  native_storage: { scope: "all", before, seeded }, preservation_checks: precondition().preservation_checks!.map(check => ({
    ...check, step_digest: digest, document_epoch: check.after_step === 6 ? 2 : 1,
    native_storage: { scope: "all", comparison: "sampled-equal", snapshot: seeded, equal: true },
  })),
});
const fullTrace = () => ({ version: 3, format: "static-web-trace.v3", case_id: source.case_id, viewport,
  device_scale_factor: 1, program_digest: programDigest,
  operations: program().steps.map((step, index) => ({ index, page_id: step.page, planned_step_digest: digest, action: step.action,
    observation: ["navigate", "reload"].includes(step.action) ? { kind: "navigation", status_code: 200 }
      : step.action.startsWith("assert_") ? { kind: "assertion", passed: true } : { kind: "action-completed" } })),
  captures: [{ page_id: "main", timing: { kind: "case-end" }, screenshot_digest: digest }], storage_precondition: trace(),
});
const contract = (opted = true) => StaticWebCapabilitiesSchema.parse({ version: 3, kind: "static-web", claim: "configured",
  browser_steps_version: 3, legacy_browser_steps: "rejected", actions: ["navigate", "reload", "click", "assert_text", "assert_value", "assert_count"],
  viewports: [viewport], device_scale_factor: 1, stage_policy: { research: "no-browser", design: "declared-cases",
    implementation: "declared-cases", validation: "declared-cases" }, screenshots: "each-created-page-visible-viewport",
  pages: { max_pages: 3, counting: "cumulative-created", same_origin: true, same_browser_context: true, name_reuse: "rejected", main_close: "rejected" },
  limits: { max_cases: 50, max_steps_per_case: 100, action_timeout_ms: 5000 }, checks: [],
  keyboard: { allowed_keys: ["Tab"], typing_max_length: 1000, focus_setup: "programmatic", focus_scope: "main-frame-dom" },
  unavailable: ["storage-exception-injection", "native-screen-reader", "browser-zoom"],
  ...(opted ? { storage_precondition: storagePreconditionCapabilitiesV1(digest) } : {}),
});
const capabilities = (opted = true) => VerificationCapabilitiesSchema.parse({ version: 1, profile_digest: digest,
  measurement_plan_policy: policy, checks: [{ command_id: "browser", config_digest: digest, contract_digest: digest, contract: contract(opted) }] });
const research = () => ProductResearchReportSchema.parse({ version: 1, objective: "Recover stored journal data", assumptions: [],
  requirements: [{ id: "storage", description: "Recover data", priority: "must", acceptance_criteria: ["Invalid data survives cancelled recovery"] }],
  sources: [{ id: "source", url: "https://example.com/", title: "Storage documentation", retrieved_at: "2026-11-05T00:00:00Z", content_digest: digest }],
  findings: [{ summary: "Storage input may be invalid", source_ids: ["source"] }], decisions: [],
  measurement_plan: { version: 2, profile_digest: digest, entries: [{ method: "workspace-check", ...ref, command_id: "browser",
    config_digest: digest, contract_digest: digest, actions: ["navigate", "reload", "click", "assert_text", "assert_value", "assert_count"],
    keys: [], viewports: [viewport], needs: [need()] }] },
});
const design = () => ProductDesignV2Schema.parse({ version: 2, requirement_ids: ["storage"], information_architecture: ["Editor"],
  user_flows: [{ id: "retry", name: "Retry", requirement_ids: ["storage"], steps: ["Retry load"] }],
  screens: [{ id: "editor", name: "Editor", purpose: "Write", states: ["Error"], accessibility: ["Labels"], responsive: ["Phone"] }],
  prototype: { entrypoint: "product/index.html", description: "Journal editor" }, data_model: [], api_contracts: [],
  decisions: [{ decision: "Local storage", rationale: "Offline" }], validation_cases: [{ id: source.case_id, method: "workspace-check",
    requirement_ids: ["storage"], requirement_criteria: [ref], procedure: ["Retry invalid data"], expected_result: "Retained input and error",
    browser_program: program(), storage_precondition: precondition() }] });
const measuredCase = () => ({ case_id: source.case_id, viewport, program_digest: programDigest, assertions: 4, operation_count: 7,
  trace_digest: digest, trace_size: JSON.stringify(fullTrace()).length, captures: fullTrace().captures,
  storage_precondition: storagePreconditionReportFromTraceV1(trace()) });
const report = () => ({ version: 3, format: "static-web-acceptance.v3", stage: "validation", passed: true, requirements: 1,
  device_scale_factor: 1, capability_binding: { version: 1, command_id: "browser", profile_digest: digest, config_digest: digest, contract_digest: digest },
  cases: [measuredCase()] });

describe("raw storage precondition contracts", () => {
  it("retains raw invalid JSON, whitespace, controls and scalar Unicode without parsing", () => {
    for (const value of ["{", " {\n", "", "\u0000\"\\", "😀".repeat(16384)]) {
      const input = { ...precondition(), local_storage: { key: "😀".repeat(128), value } };
      expect(ProductStoragePreconditionV1Schema.parse(input)).toEqual(input);
    }
    expect(ProductStoragePreconditionBindingV1Schema.parse({ source, precondition: precondition() })).toEqual({ source, precondition: precondition() });
  });

  it("rejects unknown authority-bearing fields, versions, byte overflow and unpaired surrogates", () => {
    for (const local_storage of [{ key: "", value: "x" }, { key: "😀".repeat(129), value: "x" },
      { key: "journal", value: "😀".repeat(16385) }, { key: "journal", value: "a".repeat(65537) },
      { key: "\ud800", value: "x" }, { key: "journal", value: "\udfff" }, { key: "x", value: "\ud800x" },
      { key: "journal", value: "{", origin: "http://example.com" }]) {
      expect(ProductStoragePreconditionV1Schema.safeParse({ ...precondition(), local_storage }).success).toBe(false);
    }
    for (const change of [{ version: 2 }, { script: "seed()" }, { origin: "http://example.com" },
      { requirement_criteria: [ref, ref] }, { ui_assertion_steps: [1, 1] }, { ui_assertion_steps: [0] },
      { preservation_checks: Array(5).fill(precondition().preservation_checks![0]) }]) {
      expect(ProductStoragePreconditionV1Schema.safeParse({ ...precondition(), ...change }).success).toBe(false);
    }
    expect(StoragePreconditionOptionsV1Schema.safeParse({ version: 1, seed: "x" }).success).toBe(false);
  });

  it("requires ordered checkpoint boundaries, subset refs and actual substantive assertion steps", () => {
    const input = precondition(), first = input.preservation_checks![0]!, last = input.preservation_checks![1]!;
    for (const preservation_checks of [[last, first], [first, first], [{ ...first, after_step: 3 }],
      [{ ...first, requirement_criteria: [{ ...ref, criterion_index: 1 }] }], [{ ...first, ui_assertion_steps: [2, 4] }]]) {
      expect(ProductStoragePreconditionV1Schema.safeParse({ ...input, preservation_checks }).success).toBe(false);
    }
    expect(() => validateProductStoragePreconditionV1(program().steps, input, ["storage"], [ref])).not.toThrow();
    expect(() => validateProductStoragePreconditionV1(program().steps.slice(0, 6), input)).toThrow("existing");
    expect(() => validateProductStoragePreconditionV1(program().steps, input, ["other"])).toThrow("outside");
    expect(() => validateProductStoragePreconditionV1(program().steps, input, ["storage"], [{ ...ref, criterion_index: 1 }])).toThrow("outside");
    for (const action of ["click", "assert_visible", "assert_hidden", "assert_focused"]) {
      expect(() => validateProductStoragePreconditionV1(program().steps.map((step, i) => i === 1 ? { ...step, action } : step), input)).toThrow("assertions");
    }
    for (const action of ["open_page", "close_page"]) expect(() => validateProductStoragePreconditionV1(
      program().steps.map((step, i) => i === 2 ? { ...step, action } : step), input)).toThrow();
    expect(() => validateProductStoragePreconditionV1(program().steps.map((step, i) => i === 1 ? { ...step, page: "peer" } : step), input)).toThrow();
  });
});

describe("storage precondition native evidence", () => {
  it("projects exact source, program, native readbacks and checkpoint bindings without raw data", () => {
    expect(BrowserOperationTraceV3Schema.parse(fullTrace())).toEqual(fullTrace());
    const actual = storagePreconditionReportFromTraceV1(trace());
    expect(StoragePreconditionReportV1Schema.parse(actual)).toEqual(actual);
    expect(actual).not.toHaveProperty("installation"); expect(actual).not.toHaveProperty("sequence");
    expect(JSON.stringify(actual)).not.toContain("local_storage");
    expect(StaticWebAcceptanceReportSchema.parse(report())).toEqual(report());
    const observation = { ...report(), scope: "final", evidence_bundle: { bundle_id: "bundle", manifest_digest: digest },
      cases: [{ ...measuredCase(), trace_ref: "trace", captures: [{ ...measuredCase().captures[0], screenshot_ref: "image" }] }] };
    const { passed: _passed, requirements: _requirements, ...valid } = observation;
    expect(VerificationObservationSchema.parse(valid)).toEqual(valid);
  });

  it("rejects missing/reordered readback phases, reseeding, nonempty baseline and changed native samples", () => {
    const actual = trace(), checkpoint = actual.preservation_checks[0]!;
    for (const change of [{ sequence: ["empty-baseline", "resumed", "native-seed-readback"] }, { sequence: ["empty-baseline", "resumed"] },
      { seed_apply_count: 0 }, { seed_apply_count: 2 }, { document_epoch: 2 }, { origin: "http://127.0.0.1:4174/" },
      { installation: { script_digest: digest, confirmed: false } }, { local_storage: precondition().local_storage },
      { native_storage: { ...actual.native_storage, before: seeded } }, { native_storage: { ...actual.native_storage, seeded: before } },
      { native_storage: { ...actual.native_storage, seeded: { ...seeded, key_count: 2 } } },
      { preservation_checks: [{ ...checkpoint, native_storage: { ...checkpoint.native_storage, snapshot: { ...seeded, digest } } }] },
      { preservation_checks: [{ ...checkpoint, native_storage: { ...checkpoint.native_storage, equal: false } }] }]) {
      expect(StoragePreconditionTraceV1Schema.safeParse({ ...actual, ...change }).success).toBe(false);
    }
    expect(StoragePreconditionTraceV1Schema.safeParse({ ...actual, preservation_checks: [] }).success).toBe(true);
    expect(ProductStoragePreconditionV1Schema.safeParse({ ...precondition(), preservation_checks: undefined }).success).toBe(true);
    expect(ProductStoragePreconditionV1Schema.safeParse({ ...precondition(), preservation_checks: [] }).success).toBe(true);
  });

  it("binds source case, actual program, assertion digest and explicit reload epoch", () => {
    const full = fullTrace(), actual = trace();
    for (const change of [{ source: { ...source, case_id: "other" } }, { program_digest: digest }, { initial_step_digest: seededDigest },
      { preservation_checks: [{ ...actual.preservation_checks[0], step_digest: seededDigest }] },
      { preservation_checks: [{ ...actual.preservation_checks[1], document_epoch: 1 }] }]) {
      expect(BrowserOperationTraceV3Schema.safeParse({ ...full, storage_precondition: { ...actual, ...change } }).success).toBe(false);
    }
    for (const change of [{ case_id: "other" }, { program_digest: digest }, { operation_count: 6 }, { assertions: 3 }]) {
      expect(StaticWebAcceptanceReportSchema.safeParse({ ...report(), cases: [{ ...measuredCase(), ...change }] }).success).toBe(false);
    }
  });

  it("requires a combined first fault to start from the seeded readback using the same initializer", () => {
    const fault = StorageFaultTraceV1Schema.parse({ version: 1, checks_digest: digest, windows: [{
      id: "read", mode: "read-security", page_id: "main", arm_before_step: 0, settle_after_step: 1,
      requirement_criteria: [ref], ui_assertion_steps: [1], start_step_digest: digest, end_step_digest: digest,
      baseline_phase: "first-document-paused", document_epoch: 1, installation: { script_digest: digest, confirmed: true },
      sequence: ["baseline", "armed", "settled", "disarmed"], hits: { baseline: 0, final: 1, delta: 1 },
      native_storage: { scope: "all", comparison: "sampled-equal", before: seeded, after: seeded, equal: true },
      events: { coverage: "observed-only", observed_mutations: 0 },
    }] });
    expect(BrowserOperationTraceV3Schema.safeParse({ ...fullTrace(), storage_fault: fault }).success).toBe(true);
    for (const change of [{ native_storage: { ...fault.windows[0]!.native_storage, before, after: before } },
      { installation: { script_digest: seededDigest, confirmed: true } }]) {
      expect(BrowserOperationTraceV3Schema.safeParse({ ...fullTrace(), storage_fault: { ...fault,
        windows: [{ ...fault.windows[0], ...change }] } }).success).toBe(false);
    }
  });

  it("allows controlled peer UI assertions without reseeding or increasing the main epoch", () => {
    const full = fullTrace();
    const peerSteps = [{ action: "navigate", page: "main" }, { action: "assert_text", page: "main" },
      { action: "open_page", page: "peer" }, { action: "reload", page: "peer" },
      { action: "assert_text", page: "peer" }, { action: "click", page: "main" }, { action: "assert_text", page: "main" }];
    const sidecar = { ...precondition(), ui_assertion_steps: [1, 4, 6], preservation_checks: [
      { after_step: 4, requirement_criteria: [ref], ui_assertion_steps: [4] },
    ] };
    expect(() => validateProductStoragePreconditionV1(peerSteps, sidecar, ["storage"], [ref])).not.toThrow();
    const actual = trace(); actual.ui_assertion_steps = sidecar.ui_assertion_steps;
    actual.preservation_checks = [{ ...actual.preservation_checks[0]!, ui_assertion_steps: [4], document_epoch: 1 }];
    const peerTrace = { ...full, operations: peerSteps.map((step, index) => ({ index, action: step.action, page_id: step.page,
      planned_step_digest: digest, observation: step.action === "open_page" ? { kind: "page-opened", status_code: 200 }
        : ["navigate", "reload"].includes(step.action) ? { kind: "navigation", status_code: 200 }
          : step.action.startsWith("assert_") ? { kind: "assertion", passed: true } : { kind: "action-completed" } })),
      captures: [...full.captures, { ...full.captures[0], page_id: "peer" }], storage_precondition: actual };
    expect(BrowserOperationTraceV3Schema.safeParse(peerTrace).success).toBe(true);
    expect(BrowserOperationTraceV3Schema.safeParse({ ...peerTrace, storage_precondition: { ...actual,
      preservation_checks: [{ ...actual.preservation_checks[0], document_epoch: 2 }] } }).success).toBe(false);
    expect(StaticWebAcceptanceReportSchema.safeParse({ ...report(), cases: [{ ...measuredCase(), captures: peerTrace.captures,
      storage_precondition: storagePreconditionReportFromTraceV1(actual) }] }).success).toBe(true);
  });
});

describe("opt-in policy-v2 feasibility and handoff", () => {
  it("preserves legacy schemas and absent serialized fields", () => {
    expect(MeasurementNeedV1Schema.safeParse(need()).success).toBe(false);
    expect(MeasurementNeedV2Schema.parse(need())).toEqual(need());
    const plan = ProductMeasurementPlanV2Schema.parse(research().measurement_plan);
    const { method: _method, ...entry } = plan.entries[0]!;
    expect(ProductMeasurementPlanV1Schema.safeParse({ ...plan, version: 1, entries: [entry] }).success).toBe(false);
    const oldTrace = fullTrace(); delete (oldTrace as Partial<typeof oldTrace>).storage_precondition;
    expect(JSON.stringify(BrowserOperationTraceV3Schema.parse(oldTrace))).toBe(JSON.stringify(oldTrace));
    expect(contract(false)).not.toHaveProperty("storage_precondition");
    expect(JSON.stringify(StaticWebCapabilitiesSchema.parse(contract(false)))).toBe(JSON.stringify(contract(false)));
    const oldDesign = design();
    for (const item of oldDesign.validation_cases) if (item.method === "workspace-check") delete item.storage_precondition;
    expect(ProductDesignSchema.parse(oldDesign)).toEqual(oldDesign);
  });

  it("requires a configured seed capability without silently authorizing other scopes", () => {
    const input = { research: research(), policy, capabilities: capabilities(), digest: () => digest };
    expect(evaluateDeclaredMeasurementPlanV2(input).mapped_criterion_count).toBe(1);
    expect(() => evaluateDeclaredMeasurementPlanV2({ ...input, capabilities: capabilities(false) })).toThrow("opted-in");
    for (const change of [{ version: 2 }, { page_scope: "multiple-pages" }, { phase: "after-load" },
      { input: "javascript" }, { preservation: "continuous" }]) expect(MeasurementNeedV2Schema.safeParse({ ...need(), ...change }).success).toBe(false);
    const extended = storagePreconditionCapabilitiesV1(digest);
    expect(extended.cases.main_document_changes).toBe("explicit-v3-actions-only");
    expect(extended.cases).not.toHaveProperty("document_changes");
    for (const change of [{ initializer_digest: "claimed" }, { input: { ...extended.input, max_keys: 2 } },
      { installation: { ...extended.installation, seed_count: 2 } }, { preservation: { ...extended.preservation, max_checkpoints: 5 } },
      { cases: { ...extended.cases, document_changes: "explicit-v3-actions-only" } }]) {
      expect(StoragePreconditionCapabilitiesV1Schema.safeParse({ ...extended, ...change }).success).toBe(false);
    }
  });

  it("rejects undeclared, missing and partial preservation realization against accepted research", () => {
    expect(validateProductDevelopmentHandoff(research(), design())).toEqual([]);
    const unseeded = design(); for (const item of unseeded.validation_cases) if (item.method === "workspace-check") delete item.storage_precondition;
    expect(validateProductDevelopmentHandoff(research(), unseeded).join(" ")).toContain("lacks");
    const noCheckpoints = design(); for (const item of noCheckpoints.validation_cases) if (item.method === "workspace-check") delete item.storage_precondition!.preservation_checks;
    expect(validateProductDevelopmentHandoff(research(), noCheckpoints).join(" ")).toContain("checkpoint");
    const undeclared = research(); if (undeclared.measurement_plan?.version === 2) for (const entry of undeclared.measurement_plan.entries) {
      if (entry.method === "workspace-check") entry.needs = [];
    }
    expect(validateProductDevelopmentHandoff(undeclared, design()).join(" ")).toContain("no exact accepted");
    const wrongRef = design(), item = wrongRef.validation_cases[0]!;
    if (item.method === "workspace-check") item.storage_precondition!.requirement_criteria = [{ ...ref, criterion_index: 1 }];
    expect(ProductDesignSchema.safeParse(wrongRef).success).toBe(false);
    const legacy = { ...design(), version: 1 };
    expect(ProductDesignSchema.safeParse(legacy).success).toBe(false);
    const releaseCase = { id: "release", method: "configured-static-release", requirement_ids: ["storage"], requirement_criteria: [ref],
      procedure: ["Publish product"], expected_result: "Configured endpoint responds", claim_id: CONFIGURED_STATIC_PUBLICATION_CLAIM,
      statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST, release_binding: { version: 1, release_profile_id: "release",
        release_profile_digest: digest, contract_digest: digest, project_id: "project", workspace_root: "C:/product",
        verification_profile_id: "verify", verification_profile_digest: digest } };
    const releaseDesign = { ...design(), validation_cases: [releaseCase] };
    expect(ProductDesignSchema.safeParse(releaseDesign).success).toBe(true);
    expect(ProductDesignSchema.safeParse({ ...releaseDesign, validation_cases: [{ ...releaseCase, storage_precondition: precondition() }] }).success).toBe(false);
  });

  it("advertises raw input and review limits only with protected policy-v2 opt-in", () => {
    const configured = VerificationCapabilitiesContextSchema.parse({ ...capabilities(), profile_id: "profile" });
    const disabled = VerificationCapabilitiesContextSchema.parse({ ...capabilities(false), profile_id: "profile" });
    for (const stage of ["research", "design", "implementation", "validation"] as const) {
      expect(productDevelopmentContext(stage, disabled).instructions.join(" ")).not.toContain("storage_precondition");
      const actual = productDevelopmentContext(stage, configured);
      expect(actual.instructions.length).toBeLessThanOrEqual(20);
      expect(actual.instructions.join(" ")).toContain("never replays");
      expect(actual.instructions.join(" ")).toContain("real parser");
      expect(actual.instructions.join(" ")).toContain("Empty needs do not declare");
    }
  });
});
