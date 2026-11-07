import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ContextPackSchema, ProductDesignSchema, ProductBrowserStepV3Schema, productDevelopmentContext, type ProductStorageChecksV1 } from "@artoo/domain";
import { deriveExpectedWebAcceptanceV2, deriveExpectedWebAcceptanceV3, prepareStaticWebCapabilities, runWebAcceptance } from "./web-acceptance.js";
import { canonicalWebAcceptance as canonical, webAcceptanceDigest as sha } from "./web-acceptance-identity.js";
import { STORAGE_FAULT_INITIALIZER_DIGEST } from "./web-acceptance-storage-source.js";

const roots: string[] = [], digest = `sha256:${"a".repeat(64)}`;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(designCaptureCases = true, storageFault = false) {
  const root = mkdtempSync(join(tmpdir(), "artoo-browser-v3-")); roots.push(root);
  const workspace = join(root, "workspace"), evidence = join(root, "evidence");
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
  const prepared = prepareStaticWebCapabilities({ browser_program: { version: 3, viewports: [
    { id: "compact", width: 390, height: 600 }, { id: "tall", width: 390, height: 1000 },
  ] }, evidence_root: evidence, design_capture_cases: designCaptureCases, ...(storageFault ? { storage_fault: { version: 1 } } : {}) });
  const binding = { version: 1 as const, command_id: "browser", profile_digest: digest,
    config_digest: prepared.config_digest, contract_digest: prepared.contract_digest };
  const context = ContextPackSchema.parse({ task: { id: "task", title: "Design", description: "", acceptance_criteria: [] },
    project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    product_development: productDevelopmentContext("design") });
  const write = (path: string, value: unknown) => writeFileSync(join(workspace, path), typeof value === "string" ? value : JSON.stringify(value));
  write(".artoo/product/research.json", { version: 1, objective: "Journal", assumptions: [],
    requirements: [{ id: "entry", description: "Store an entry", priority: "must", acceptance_criteria: ["Entry synchronizes"] }],
    sources: [{ id: "fixture", url: "https://example.com", title: "Declared fixture", retrieved_at: "2026-11-04T00:00:00Z", content_digest: digest }],
    findings: [{ summary: "Storage", source_ids: ["fixture"] }], decisions: [] });
  const design = ProductDesignSchema.parse({ version: 1, requirement_ids: ["entry"], information_architecture: ["Entries"],
    user_flows: [{ id: "save", name: "Save", requirement_ids: ["entry"], steps: ["Save an entry"] }],
    screens: [{ id: "journal", name: "Journal", purpose: "Write", states: ["Empty"], accessibility: ["Labels"], responsive: ["Phone"] }],
    prototype: { entrypoint: "product/index.html", description: "Clickable mock" }, data_model: [], api_contracts: [], decisions: [{ decision: "Local storage", rationale: "Offline" }],
    validation_cases: [{ id: "synchronization", requirement_ids: ["entry"], procedure: ["Use two pages"], expected_result: "Shared entry appears",
      browser_program: { version: 3, contract_digest: prepared.contract_digest, steps: [
        { action: "navigate", page: "main", path: "/" }, { action: "open_page", page: "peer", path: "/" },
        { action: "assert_text", page: "peer", selector: "#entry", text: "Saved" }, { action: "close_page", page: "peer" },
      ] } }] });
  write(".artoo/product/design.json", design); write("product/index.html", "<title>Journal</title><p id=entry>Saved</p>");
  return { workspace, evidence, prepared, binding, context, design, write };
}

describe("protected browser program v3 independent plans", () => {
  it("advertises the real executable actions and precise page restrictions", () => {
    const f = fixture();
    expect(f.prepared.contract).toMatchObject({ version: 3, browser_steps_version: 3, legacy_browser_steps: "rejected",
      device_scale_factor: 1, screenshots: "each-created-page-visible-viewport", pages: { max_pages: 3,
        counting: "cumulative-created", same_origin: true, same_browser_context: true, name_reuse: "rejected", main_close: "rejected" } });
    expect(f.prepared.contract.actions).toEqual(ProductBrowserStepV3Schema.options.map((option) => option.shape.action.value));
    expect(f.prepared.contract.unavailable).toEqual(["storage-exception-injection", "native-screen-reader", "browser-zoom"]);
  });
  it("derives all expected page lifetimes and operation digests from the fixed source", () => {
    const f = fixture(), plan = deriveExpectedWebAcceptanceV3(f.workspace, f.context, f.prepared.options, f.binding);
    expect(plan.programs).toHaveLength(2); expect(plan.programs.map((program) => program.viewport.height)).toEqual([600, 1000]);
    expect(plan.programs[0]).toMatchObject({ program_digest: sha(canonical(f.design.validation_cases[0]!.browser_program)),
      steps: [{ index: 0, page_id: "main", action: "navigate" },
        { index: 1, page_id: "peer", action: "open_page", expected_observation: { kind: "page-opened" } },
        { index: 2, page_id: "peer", action: "assert_text" },
        { index: 3, page_id: "peer", action: "close_page", expected_observation: { kind: "page-closed", closed: true } }],
      captures: [{ page_id: "main", timing: { kind: "case-end" } }, { page_id: "peer", timing: { kind: "before-close", step_index: 3 } }] });
    const old = plan.programs[0]!.program_digest;
    f.design.validation_cases[0]!.browser_program!.steps.pop(); f.write(".artoo/product/design.json", f.design);
    const next = deriveExpectedWebAcceptanceV3(f.workspace, f.context, f.prepared.options, f.binding);
    expect(next.programs[0]!.program_digest).not.toBe(old);
    expect(next.programs[0]!.captures[1]).toEqual({ page_id: "peer", timing: { kind: "case-end" } });
  });
  it("preserves prototype-only as one main navigation and one case-end capture", () => {
    const f = fixture(false), plan = deriveExpectedWebAcceptanceV3(f.workspace, f.context, f.prepared.options, f.binding);
    expect(plan.casePrograms).toEqual([{ case_id: "prototype", program: { version: 3, contract_digest: f.binding.contract_digest,
      steps: [{ action: "navigate", page: "main", path: "/index.html" }] } }]);
    expect(plan.programs.every((program) => program.steps.length === 1)).toBe(true);
    expect(plan.programs[0]!.captures).toEqual([{ page_id: "main", timing: { kind: "case-end" } }]);
  });
  it("rejects v2 programs in v3, v3 programs in v2, and mismatched contract/config bindings", () => {
    const f = fixture(), test = f.design.validation_cases[0]!;
    test.browser_program!.contract_digest = digest; f.write(".artoo/product/design.json", f.design);
    expect(() => deriveExpectedWebAcceptanceV3(f.workspace, f.context, f.prepared.options, f.binding)).toThrow("contract digest");
    test.browser_program = { version: 2, contract_digest: f.binding.contract_digest, steps: [
      { action: "navigate", page: "main", path: "/" }, { action: "assert_text", page: "main", selector: "body", text: "Saved" },
    ] }; f.write(".artoo/product/design.json", f.design);
    expect(() => deriveExpectedWebAcceptanceV3(f.workspace, f.context, f.prepared.options, f.binding)).toThrow("explicit browser_program v3");
    const legacy = prepareStaticWebCapabilities({ browser_program: { version: 2, viewports: [{ id: "compact", width: 390, height: 600 }] } });
    const legacyBinding = { ...f.binding, config_digest: legacy.config_digest, contract_digest: legacy.contract_digest };
    test.browser_program = { version: 3, contract_digest: legacyBinding.contract_digest, steps: [
      { action: "navigate", page: "main", path: "/" }, { action: "assert_text", page: "main", selector: "body", text: "Saved" },
    ] }; f.write(".artoo/product/design.json", f.design);
    expect(() => deriveExpectedWebAcceptanceV2(f.workspace, f.context, legacy.options, legacyBinding)).toThrow("explicit browser_program v2");
    expect(() => deriveExpectedWebAcceptanceV3(f.workspace, f.context, f.prepared.options, { ...f.binding, config_digest: digest })).toThrow("configured binding");
  });
  it("requires a binding and leaves research browser coverage explicitly empty", async () => {
    const f = fixture(); f.context.product_development = productDevelopmentContext("research");
    await expect(runWebAcceptance(f.workspace, f.context, f.prepared.options)).rejects.toThrow("protected capability binding");
    expect(deriveExpectedWebAcceptanceV3(f.workspace, f.context, f.prepared.options, f.binding).programs).toEqual([]);
    const report = await runWebAcceptance(f.workspace, f.context, f.prepared.options, "research", f.binding);
    expect(report).toEqual({ version: 3, format: "static-web-acceptance.v3", stage: "research", passed: true,
      requirements: 1, device_scale_factor: 1, capability_binding: f.binding, cases: [] });
    const directory = join(f.evidence, readdirSync(f.evidence)[0]!);
    expect(readdirSync(directory)).toEqual(["result.json"]); expect(JSON.parse(readFileSync(join(directory, "result.json"), "utf8"))).toEqual(report);
  });
});

const storageChecks = (start = 0): ProductStorageChecksV1 => ({ version: 1, windows: [{ id: "save-failure", page: "main", mode: "write-quota",
  arm_before_step: start, settle_after_step: start + 1, requirement_criteria: [{ requirement_id: "entry", criterion_index: 0 }],
  ui_assertion_steps: [start + 1], min_hits: 1, native_storage: { scope: "all", comparison: "sampled-equal" } }] });
function addStorageCase(f: ReturnType<typeof fixture>, start = 0) {
  const test = f.design.validation_cases[0]!;
  test.browser_program = { version: 3, contract_digest: f.binding.contract_digest, steps: [
    { action: "navigate", page: "main", path: "/" }, { action: "assert_text", page: "main", selector: "#entry", text: "Saved" },
    { action: "reload", page: "main" }, { action: "assert_value", page: "main", selector: "#draft", value: "Unsaved draft" },
  ] };
  test.storage_checks = storageChecks(start); f.write(".artoo/product/design.json", f.design); return test;
}
describe("protected storage-fault sidecar planning", () => {
  it("only advertises the limited extension on an opted-in v3 profile, including the protected initializer digest", () => {
    const ordinary = fixture(), opted = fixture(true, true);
    expect(ordinary.prepared.options).not.toHaveProperty("storage_fault"); expect(ordinary.prepared.contract).not.toHaveProperty("storage_fault");
    expect(opted.prepared.contract).toMatchObject({ storage_fault: { version: 1, initializer_digest: STORAGE_FAULT_INITIALIZER_DIGEST,
      cases: { document_changes: "explicit-navigate-or-reload-only" }, events: { coverage: "observed-only", max_observed_events_per_case: 512 } } });
    expect(opted.prepared.contract.unavailable).not.toContain("storage-exception-injection");
    expect(deriveExpectedWebAcceptanceV3(opted.workspace, opted.context, opted.prepared.options, opted.binding).programs.every(program => program.storage_fault === undefined)).toBe(true);
  });
  it.each([0, 2])("independently binds sidecar, source steps, criterion and document epoch at arm step %s", start => {
    const f = fixture(true, true), test = addStorageCase(f, start);
    const plan = deriveExpectedWebAcceptanceV3(f.workspace, f.context, f.prepared.options, f.binding);
    const { page: _page, ...expectedWindow } = test.storage_checks!.windows[0]!;
    expect(plan.casePrograms[0]!.storage_checks).toEqual(test.storage_checks);
    expect(plan.programs[0]!.storage_fault).toEqual({ version: 1, checks_digest: sha(canonical(test.storage_checks)),
      installation_script_digest: STORAGE_FAULT_INITIALIZER_DIGEST, windows: [{ ...expectedWindow,
        page_id: "main", start_step_digest: sha(canonical(test.browser_program!.steps[start])),
        end_step_digest: sha(canonical(test.browser_program!.steps[start + 1])), baseline_phase: start === 0 ? "first-document-paused" : "before-step",
        document_epoch: start === 0 ? 1 : 2 }] });
  });
  it("changes the sidecar identity independently of the unchanged browser program", () => {
    const f = fixture(true, true), test = addStorageCase(f), first = deriveExpectedWebAcceptanceV3(f.workspace, f.context, f.prepared.options, f.binding).programs[0]!;
    test.storage_checks!.windows[0]!.mode = "read-security"; f.write(".artoo/product/design.json", f.design);
    const second = deriveExpectedWebAcceptanceV3(f.workspace, f.context, f.prepared.options, f.binding).programs[0]!;
    expect(second.program_digest).toBe(first.program_digest); expect(second.storage_fault!.checks_digest).not.toBe(first.storage_fault!.checks_digest);
  });
  it("rejects an unopted sidecar and a criterion absent from the accepted research", () => {
    const ordinary = fixture(); addStorageCase(ordinary);
    expect(() => deriveExpectedWebAcceptanceV3(ordinary.workspace, ordinary.context, ordinary.prepared.options, ordinary.binding)).toThrow("opt-in");
    const f = fixture(true, true), test = addStorageCase(f);
    test.storage_checks!.windows[0]!.requirement_criteria[0]!.criterion_index = 1; f.write(".artoo/product/design.json", f.design);
    expect(() => deriveExpectedWebAcceptanceV3(f.workspace, f.context, f.prepared.options, f.binding)).toThrow("accepted requirement criterion");
  });
  it("does not fabricate fault execution in the prototype-only design path", () => {
    const f = fixture(false, true); addStorageCase(f);
    const plan = deriveExpectedWebAcceptanceV3(f.workspace, f.context, f.prepared.options, f.binding);
    expect(plan.casePrograms[0]!.case_id).toBe("prototype"); expect(plan.casePrograms[0]).not.toHaveProperty("storage_checks");
    expect(plan.programs.every(program => program.storage_fault === undefined)).toBe(true);
  });
});
