import { describe, expect, it } from "vitest";
import { ProductBrowserProgramV2Schema, ProductBrowserStepV2Schema } from "./browser-program.js";
import { BrowserPageIdV3Schema, ProductBrowserProgramV3Schema, ProductBrowserStepV3Schema, deriveBrowserPageLifecycleV3 } from "./browser-program-v3.js";
import { BrowserOperationTraceV2Schema } from "./browser-operation-trace.js";
import { BrowserOperationTraceV3Schema, BrowserOperationV3Schema } from "./browser-operation-trace-v3.js";
import { ProductDesignSchema, productDevelopmentContext } from "./product-development.js";
import { StaticWebCapabilitiesSchema, VerificationCapabilitiesSchema } from "./verification-capabilities.js";
import { StaticWebAcceptanceReportSchema, VerificationObservationSchema } from "./verification-observation.js";

const digest = `sha256:${"a".repeat(64)}`;
const viewport = { id: "compact", width: 390, height: 844 };
const binding = { version: 1, command_id: "browser", profile_digest: digest, config_digest: digest, contract_digest: digest };
const initial = { action: "navigate", page: "main", path: "/" } as const;
const program = { version: 3, contract_digest: digest, steps: [initial,
  { action: "open_page", page: "peer", path: "/" },
  { action: "fill", page: "main", selector: "#entry", value: "Saved" },
  { action: "assert_text", page: "peer", selector: "#saved", text: "Saved" },
  { action: "close_page", page: "peer" },
  { action: "open_page", page: "third", path: "/history" },
  { action: "assert_count", page: "third", selector: ".saved", count: 1 },
] };
const operations = [
  { action: "navigate", page_id: "main", observation: { kind: "navigation", status_code: 200 } },
  { action: "open_page", page_id: "peer", observation: { kind: "page-opened", status_code: 200 } },
  { action: "fill", page_id: "main", observation: { kind: "action-completed" } },
  { action: "assert_text", page_id: "peer", observation: { kind: "assertion", passed: true } },
  { action: "close_page", page_id: "peer", observation: { kind: "page-closed", closed: true } },
  { action: "open_page", page_id: "third", observation: { kind: "page-opened", status_code: 200 } },
  { action: "assert_count", page_id: "third", observation: { kind: "assertion", passed: true } },
].map((operation, index) => ({ index, ...operation, planned_step_digest: digest }));
const captures = [
  { page_id: "main", timing: { kind: "case-end" }, screenshot_digest: digest },
  { page_id: "peer", timing: { kind: "before-close", step_index: 4 }, screenshot_digest: digest },
  { page_id: "third", timing: { kind: "case-end" }, screenshot_digest: digest },
];
const trace = { version: 3, format: "static-web-trace.v3", case_id: "shared", viewport,
  device_scale_factor: 1, program_digest: digest, operations, captures };
const browserCase = { case_id: "shared", viewport, program_digest: digest, assertions: 2, operation_count: operations.length,
  trace_digest: digest, trace_size: JSON.stringify(trace).length, captures };
const report = { version: 3, format: "static-web-acceptance.v3", stage: "design", passed: true, requirements: 1,
  device_scale_factor: 1, capability_binding: binding, cases: [browserCase] };
const contract = { version: 3, kind: "static-web", claim: "configured", browser_steps_version: 3, legacy_browser_steps: "rejected",
  actions: ["navigate", "open_page", "close_page", "press", "assert_focused"], viewports: [viewport],
  stage_policy: { research: "no-browser", design: "declared-cases", implementation: "declared-cases", validation: "declared-cases" },
  screenshots: "each-created-page-visible-viewport", pages: { max_pages: 3, counting: "cumulative-created", same_origin: true,
    same_browser_context: true, name_reuse: "rejected", main_close: "rejected" }, device_scale_factor: 1,
  limits: { max_cases: 50, max_steps_per_case: 100, action_timeout_ms: 5000 }, checks: ["horizontal-overflow"],
  unavailable: ["storage-exception-injection", "native-screen-reader", "browser-zoom"],
  keyboard: { allowed_keys: ["Tab", "Shift+Tab", "Escape"], typing_max_length: 1000, focus_setup: "programmatic", focus_scope: "main-frame-dom" } };

describe("explicit multiple-page programs", () => {
  it("allows three cumulatively created pages and derives creation-ordered capture timing", () => {
    const parsed = ProductBrowserProgramV3Schema.parse(program);
    expect(parsed).toEqual(program);
    expect(deriveBrowserPageLifecycleV3(parsed.steps)).toEqual({ captures: captures.map(({ page_id, timing }) => ({ page_id, timing })) });
    // Prototype-only design still needs one protected navigation, not invented assertions.
    expect(ProductBrowserProgramV3Schema.safeParse({ ...program, steps: [initial] }).success).toBe(true);
    const secondClosed = [...program.steps, { action: "close_page", page: "third" }];
    expect(ProductBrowserProgramV3Schema.safeParse({ ...program, steps: secondClosed }).success).toBe(true);
    expect(ProductBrowserProgramV2Schema.safeParse(program).success).toBe(false);
    expect(ProductBrowserStepV2Schema.safeParse(program.steps[1]).success).toBe(false);
  });

  it("rejects lifecycle reuse, budget restoration, unknown pages and main closure", () => {
    const invalid = [[], [program.steps[1], initial], [{ ...initial, page: "peer" }],
      [initial, { action: "close_page", page: "main" }],
      [initial, { action: "reload", page: "unknown" }],
      [initial, { action: "close_page", page: "unknown" }],
      [initial, { action: "open_page", page: "main", path: "/" }],
      [...program.steps, { action: "reload", page: "peer" }],
      [...program.steps, { action: "close_page", page: "peer" }],
      [...program.steps, { action: "open_page", page: "peer", path: "/" }],
      [...program.steps, { action: "close_page", page: "third" }, { action: "open_page", page: "fourth", path: "/" }],
      [...Array.from({ length: 101 }, () => initial)],
    ];
    for (const steps of invalid) expect(ProductBrowserProgramV3Schema.safeParse({ ...program, steps }).success).toBe(false);
  });

  it("keeps paths, names, keys, input bounds and action fields closed", () => {
    for (const page of ["", "a b", "中文", "../page", "a".repeat(129)]) expect(BrowserPageIdV3Schema.safeParse(page).success).toBe(false);
    for (const page of ["main", "peer_2", "Page-3.1", "a".repeat(128)]) expect(BrowserPageIdV3Schema.safeParse(page).success).toBe(true);
    for (const step of [{ action: "press", page: "peer", key: "Shift+Tab" }, { action: "type_text", page: "peer", text: "x".repeat(1000) },
      { action: "focus", page: "peer", selector: "#entry" }, { action: "assert_focus_within", page: "peer", selector: "dialog" }]) {
      expect(ProductBrowserStepV3Schema.safeParse(step).success).toBe(true);
    }
    for (const step of [{ action: "open_page", page: "peer", path: "//external.invalid" }, { action: "open_page", page: "peer", path: "/\\bad" },
      { action: "open_page", page: "peer", path: "/", script: "setup()" }, { action: "open_page", path: "/" },
      { action: "close_page", page: "peer", path: "/" }, { action: "press", page: "peer", key: "Control+L" },
      { action: "type_text", page: "peer", text: "x".repeat(1001) }, { action: "evaluate", page: "peer", script: "storage()" }]) {
      expect(ProductBrowserStepV3Schema.safeParse(step).success).toBe(false);
    }
  });

  it("accepts v3 design handoffs without mixing legacy steps and provides conditional stage guidance", () => {
    const design = { version: 1, requirement_ids: ["shared"], information_architecture: ["Editor"],
      user_flows: [{ id: "write", name: "Write", requirement_ids: ["shared"], steps: ["Save in main and observe peer"] }],
      screens: [{ id: "editor", name: "Editor", purpose: "Write", states: ["Empty"], accessibility: ["Tab access"], responsive: ["Fit viewport"] }],
      prototype: { entrypoint: "product/index.html", description: "Editor" }, data_model: [], api_contracts: [],
      decisions: [{ decision: "Shared storage", rationale: "Required synchronization" }], validation_cases: [{ id: "shared", requirement_ids: ["shared"],
        procedure: ["Save in main"], expected_result: "Peer updates", browser_program: program }] };
    expect(ProductDesignSchema.parse(design)).toEqual(design);
    expect(ProductDesignSchema.safeParse({ ...design, validation_cases: [{ ...design.validation_cases[0],
      browser_steps: [{ action: "navigate", path: "/" }, { action: "assert_text", selector: "body", text: "Editor" }] }] }).success).toBe(false);
    const instructions = productDevelopmentContext("design").instructions.join("\n");
    expect(instructions).toContain("v1 steps and v2 programs are rejected by that profile");
    expect(instructions).toContain("closing does not restore the budget");
    expect(instructions).toContain("synthetic StorageEvents are unavailable");
  });

  it("advertises bounded configured multiple pages within the unchanged v1 aggregate envelope", () => {
    expect(StaticWebCapabilitiesSchema.parse(contract)).toEqual(contract);
    const envelope = { version: 1, profile_digest: digest, checks: [{ command_id: "browser", config_digest: digest,
      contract_digest: digest, contract }] };
    expect(VerificationCapabilitiesSchema.parse(envelope)).toEqual(envelope);
    for (const change of [{ version: 2 }, { browser_steps_version: 2 }, { claim: "measured" },
      { pages: { ...contract.pages, counting: "simultaneous" } }, { pages: { ...contract.pages, max_pages: 4 } },
      { pages: { ...contract.pages, same_origin: false } }, { pages: { ...contract.pages, name_reuse: "allowed" } },
      { pages: { ...contract.pages, main_close: "allowed" } }, { unavailable: ["multiple-pages"] },
      { screenshots: "final-visible-viewport" }, { actions: ["evaluate"] }]) {
      expect(StaticWebCapabilitiesSchema.safeParse({ ...contract, ...change }).success).toBe(false);
    }
  });
});

describe("multiple-page actual-operation evidence", () => {
  it("binds capture timing and creation order to complete actual lifecycles", () => {
    expect(BrowserOperationTraceV3Schema.parse(trace)).toEqual(trace);
    expect(BrowserOperationTraceV2Schema.safeParse(trace).success).toBe(false);
    for (const change of [{ page_id: "main" }, { operations: [...operations].reverse() }, { operations: operations.slice(1) },
      { operations: [...operations, { ...operations[2], index: 7, page_id: "peer" }] },
      { operations: operations.map((item, index) => index === 4 ? { ...item, page_id: "main" } : item) },
      { captures: captures.slice(0, 2) }, { captures: [...captures].reverse() },
      { captures: [captures[0], { ...captures[1], timing: { kind: "before-close", step_index: 3 } }, captures[2]] },
      { captures: [captures[0], { ...captures[1], timing: { kind: "case-end" } }, captures[2]] },
      { captures: [captures[0], captures[1], { ...captures[2], page_id: "unknown" }] },
      { captures: [captures[0], captures[1], { ...captures[2], timing: { kind: "before-close", step_index: 4 } }] }]) {
      expect(BrowserOperationTraceV3Schema.safeParse({ ...trace, ...change }).success).toBe(false);
    }
  });

  it("requires actual open/close observations and forbids false success or page values", () => {
    for (const operation of [{ ...operations[1], observation: { kind: "navigation", status_code: 200 } },
      { ...operations[1], observation: { kind: "page-opened", status_code: 404 } },
      { ...operations[4], observation: { kind: "page-closed", closed: false } },
      { ...operations[4], observation: { kind: "action-completed" } },
      { ...operations[4], observation: { kind: "page-closed", closed: true, screenshot_digest: digest } },
      { ...operations[3], observation: { kind: "assertion", passed: true, text: "secret" } }]) {
      expect(BrowserOperationV3Schema.safeParse(operation).success).toBe(false);
    }
  });

  it("requires bounded unique report captures while preserving empty research reports", () => {
    expect(StaticWebAcceptanceReportSchema.parse(report)).toEqual(report);
    expect(StaticWebAcceptanceReportSchema.safeParse({ ...report, stage: "research", cases: [] }).success).toBe(true);
    for (const change of [{ version: 2 }, { capability_binding: undefined }, { cases: [browserCase, browserCase] },
      { cases: [{ ...browserCase, operation_count: 2 }] }, { cases: [{ ...browserCase, assertions: 8 }] },
      { cases: [{ ...browserCase, captures: [] }] }, { cases: [{ ...browserCase, captures: captures.slice(1) }] },
      { cases: [{ ...browserCase, captures: [captures[0], captures[1], captures[1]] }] },
      { cases: [{ ...browserCase, captures: [captures[0], { ...captures[1], timing: { kind: "before-close", step_index: 7 } }] }] },
      { cases: [{ ...browserCase, captures: [captures[0], captures[1], { ...captures[2], timing: { kind: "before-close", step_index: 4 } }] }] },
      { cases: [{ ...browserCase, captures: [{ ...captures[0], timing: { kind: "before-close", step_index: 1 } }] }] },
      { cases: [{ ...browserCase, captures: [{ ...captures[0], timing: { kind: "case-end", step_index: 1 } }] }] }]) {
      expect(StaticWebAcceptanceReportSchema.safeParse({ ...report, ...change }).success).toBe(false);
    }
  });

  it("requires globally unique trace/image grants and a bundle even for empty research evidence", () => {
    const measuredCase = { ...browserCase, trace_ref: "trace_1", captures: captures.map((capture, index) => ({ ...capture, screenshot_ref: `image_${index}` })) };
    const observation = { version: 3, format: "static-web-acceptance.v3", scope: "final", stage: "design", device_scale_factor: 1,
      capability_binding: binding, cases: [measuredCase], evidence_bundle: { bundle_id: "bundle_1", manifest_digest: digest } };
    expect(VerificationObservationSchema.parse(observation)).toEqual(observation);
    expect(VerificationObservationSchema.safeParse({ ...observation, stage: "research", cases: [] }).success).toBe(true);
    for (const change of [{ version: 2 }, { evidence_bundle: undefined }, { cases: [{ ...measuredCase, trace_ref: "image_1" }] },
      { cases: [{ ...measuredCase, trace_ref: "bundle_1" }] }, { cases: [{ ...measuredCase, captures }] },
      { cases: [{ ...measuredCase, captures: measuredCase.captures.map((capture) => ({ ...capture, screenshot_ref: "same" })) }] },
      { cases: [measuredCase, { ...measuredCase, case_id: "another", trace_ref: "trace_2" }] }]) {
      expect(VerificationObservationSchema.safeParse({ ...observation, ...change }).success).toBe(false);
    }
  });
});
