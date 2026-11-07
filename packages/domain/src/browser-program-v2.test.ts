import { describe, expect, it } from "vitest";
import { ProductBrowserProgramV2Schema, ProductBrowserStepSchema, ProductBrowserStepV2Schema } from "./browser-program.js";
import { ProductDesignSchema } from "./product-development.js";
import { BrowserOperationTraceV2Schema, BrowserOperationV2Schema } from "./browser-operation-trace.js";
import { StaticWebCapabilitiesSchema } from "./verification-capabilities.js";
import { StaticWebAcceptanceReportSchema, VerificationObservationSchema } from "./verification-observation.js";

const digest = `sha256:${"a".repeat(64)}`;
const viewport = { id: "compact", width: 390, height: 844 };
const binding = { version: 1, command_id: "browser", profile_digest: digest, config_digest: digest, contract_digest: digest };
const program = { version: 2, contract_digest: digest, steps: [
  { action: "navigate", page: "main", path: "/" }, { action: "press", page: "main", key: "Tab" },
  { action: "assert_focused", page: "main", selector: "#entry" },
] };
const design = { version: 1, requirement_ids: ["keyboard"], information_architecture: ["Editor"],
  user_flows: [{ id: "write", name: "Write", requirement_ids: ["keyboard"], steps: ["Tab to entry"] }],
  screens: [{ id: "editor", name: "Editor", purpose: "Write", states: ["Empty"], accessibility: ["Tab access"], responsive: ["Fit viewport"] }],
  prototype: { entrypoint: "product/index.html", description: "Editor" }, data_model: [], api_contracts: [],
  decisions: [{ decision: "Keyboard navigation", rationale: "Required access" }], validation_cases: [{ id: "tab", requirement_ids: ["keyboard"],
    procedure: ["Tab to entry"], expected_result: "Entry focused", browser_program: program }] };
const operations = [
  { index: 0, page_id: "main", planned_step_digest: digest, action: "navigate", observation: { kind: "navigation", status_code: 200 } },
  { index: 1, page_id: "main", planned_step_digest: digest, action: "press", observation: { kind: "key-press", key: "Tab" } },
  { index: 2, page_id: "main", planned_step_digest: digest, action: "assert_focused", observation: { kind: "focus-assertion", passed: true } },
];
const trace = { version: 2, format: "static-web-trace.v2", case_id: "tab", page_id: "main", viewport,
  device_scale_factor: 1, program_digest: digest, operations };
const browserCase = { case_id: "tab", viewport, program_digest: digest, assertions: 1, operation_count: 3,
  trace_digest: digest, trace_size: JSON.stringify(trace).length, captures: [{ page_id: "main", screenshot_digest: digest }] };
const report = { version: 2, format: "static-web-acceptance.v2", stage: "design", passed: true, requirements: 1,
  device_scale_factor: 1, capability_binding: binding, cases: [browserCase] };

describe("explicit keyboard browser programs", () => {
  it("preserves v1 steps and rejects mixing their interpretation with v2", () => {
    const old = { action: "fill", selector: "#entry", value: "Sample" };
    expect(ProductBrowserStepSchema.parse(old)).toEqual(old);
    expect(ProductBrowserStepSchema.safeParse({ ...old, page: "main" }).success).toBe(false);
    expect(ProductBrowserProgramV2Schema.parse(program)).toEqual(program);
    expect(ProductDesignSchema.parse(design)).toEqual(design);
    const mixed = { ...design, validation_cases: [{ ...design.validation_cases[0], browser_steps: [
      { action: "navigate", path: "/" }, { action: "assert_text", selector: "body", text: "Editor" },
    ] }] };
    expect(ProductDesignSchema.safeParse(mixed).success).toBe(false);
  });

  it("allows only main-page fixed keys and bounded declarative input", () => {
    for (const step of [{ action: "press", page: "main", key: "Shift+Tab" }, { action: "press", page: "main", key: "Escape" },
      { action: "type_text", page: "main", text: "Sample" }, { action: "focus", page: "main", selector: "#entry" },
      { action: "assert_focus_within", page: "main", selector: "dialog" }]) expect(ProductBrowserStepV2Schema.safeParse(step).success).toBe(true);
    for (const step of [{ action: "press", page: "other", key: "Tab" }, { action: "press", page: "main", key: "Control+L" },
      { action: "press", key: "Tab" }, { action: "type_text", page: "main", text: "x".repeat(1001) },
      { action: "navigate", page: "main", path: "//external.invalid" }, { action: "evaluate", page: "main", script: "alert(1)" },
      { action: "focus", page: "main", selector: "#entry", script: "alter()" }]) expect(ProductBrowserStepV2Schema.safeParse(step).success).toBe(false);
    // The protected prototype-only plan has one real navigate; declared-case assertions are enforced by its executor.
    expect(ProductBrowserProgramV2Schema.safeParse({ ...program, steps: [program.steps[0]] }).success).toBe(true);
  });

  it("describes keyboard configuration without claiming native AT, zoom or legacy execution", () => {
    const contract = { version: 2, kind: "static-web", claim: "configured", browser_steps_version: 2, legacy_browser_steps: "rejected",
      actions: ["navigate", "press", "assert_focused"], viewports: [viewport, { ...viewport, id: "tall", height: 1024 }],
      stage_policy: { research: "no-browser", design: "declared-cases", implementation: "declared-cases", validation: "declared-cases" },
      screenshots: "final-visible-viewport", pages: { max_pages: 1, same_browser_context: true }, device_scale_factor: 1,
      limits: { max_cases: 50, max_steps_per_case: 100, action_timeout_ms: 5000 }, checks: ["horizontal-overflow"],
      unavailable: ["multiple-pages", "storage-exception-injection", "native-screen-reader", "browser-zoom"],
      keyboard: { allowed_keys: ["Tab", "Shift+Tab", "Escape"], typing_max_length: 1000, focus_setup: "programmatic", focus_scope: "main-frame-dom" } };
    expect(StaticWebCapabilitiesSchema.parse(contract)).toEqual(contract);
    for (const change of [{ claim: "measured" }, { legacy_browser_steps: "converted" }, { device_scale_factor: 2 },
      { keyboard: { ...contract.keyboard, allowed_keys: ["Control+L"] } }, { viewports: [viewport, viewport] }]) {
      expect(StaticWebCapabilitiesSchema.safeParse({ ...contract, ...change }).success).toBe(false);
    }
  });
});

describe("strict actual-operation evidence", () => {
  it("binds each operation to its observation class and rejects raw page values or false assertions", () => {
    expect(BrowserOperationTraceV2Schema.parse(trace)).toEqual(trace);
    for (const operation of [{ ...operations[1], action: "click" }, { ...operations[1], observation: { kind: "key-press", key: "F1" } },
      { ...operations[2], observation: { kind: "focus-assertion", passed: false } },
      { ...operations[1], action: "type_text", observation: { kind: "keyboard-input", text_length: 6, text: "secret" } },
      { ...operations[1], action: "focus", observation: { kind: "key-press", key: "Tab" } }]) {
      expect(BrowserOperationV2Schema.safeParse(operation).success).toBe(false);
    }
    expect(BrowserOperationTraceV2Schema.safeParse({ ...trace, operations: [...operations].reverse() }).success).toBe(false);
    expect(BrowserOperationTraceV2Schema.safeParse({ ...trace, operations: [operations[0], operations[2]] }).success).toBe(false);
    expect(BrowserOperationTraceV2Schema.safeParse({ ...trace, page_id: "second" }).success).toBe(false);
  });

  it("uses viewport identity and both dimensions with required configuration binding", () => {
    expect(StaticWebAcceptanceReportSchema.parse(report)).toEqual(report);
    expect(StaticWebAcceptanceReportSchema.safeParse({ ...report, cases: [browserCase, {
      ...browserCase, viewport: { ...viewport, id: "tall", height: 1024 },
    }] }).success).toBe(true);
    for (const change of [{ capability_binding: undefined }, { version: 1 }, { device_scale_factor: 2 }, { cases: [browserCase, browserCase] },
      { cases: [{ ...browserCase, assertions: 4 }] }, { cases: [{ ...browserCase, viewport: { ...viewport, width: 8192, height: 8192 } }] }]) {
      expect(StaticWebAcceptanceReportSchema.safeParse({ ...report, ...change }).success).toBe(false);
    }
  });

  it("requires sealed unique trace and screenshot grants while retaining empty research coverage", () => {
    const measuredCase = { ...browserCase, trace_ref: "trace_1", captures: [{ ...browserCase.captures[0], screenshot_ref: "image_1" }] };
    const observation = { version: 2, format: "static-web-acceptance.v2", stage: "design", scope: "final", device_scale_factor: 1,
      capability_binding: binding, cases: [measuredCase], evidence_bundle: { bundle_id: "bundle_1", manifest_digest: digest } };
    expect(VerificationObservationSchema.parse(observation)).toEqual(observation);
    expect(VerificationObservationSchema.safeParse({ ...observation, stage: "research", cases: [] }).success).toBe(true);
    for (const change of [{ evidence_bundle: undefined }, { cases: [{ ...measuredCase, trace_ref: undefined }] },
      { cases: [{ ...measuredCase, trace_ref: "image_1" }] }, { cases: [{ ...measuredCase, trace_ref: "bundle_1" }] },
      { cases: [{ ...measuredCase, captures: browserCase.captures }] }]) {
      expect(VerificationObservationSchema.safeParse({ ...observation, ...change }).success).toBe(false);
    }
  });
});
