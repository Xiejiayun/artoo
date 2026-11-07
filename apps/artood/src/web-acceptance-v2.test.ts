import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { ContextPackSchema, ProductDesignSchema, ProductBrowserStepV2Schema, productDevelopmentContext,
  type BrowserOperationV2, type ProductBrowserProgramV2 } from "@artoo/domain";
import { deriveExpectedWebAcceptanceV2, prepareStaticWebCapabilities, runWebAcceptance } from "./web-acceptance.js";
import { executeBrowserProgramV2 } from "./web-acceptance-executor.js";
import { canonicalWebAcceptance as canonical, webAcceptanceDigest as sha } from "./web-acceptance-identity.js";

const roots: string[] = [], digest = `sha256:${"a".repeat(64)}`;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(designCaptureCases = true) {
  const root = mkdtempSync(join(tmpdir(), "artoo-browser-v2-")); roots.push(root);
  const workspace = join(root, "workspace"), evidence = join(root, "evidence");
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
  const prepared = prepareStaticWebCapabilities({ browser_program: { version: 2, viewports: [
    { id: "compact", width: 390, height: 600 }, { id: "tall", width: 390, height: 1000 },
  ] }, evidence_root: evidence, design_capture_cases: designCaptureCases });
  const binding = { version: 1 as const, command_id: "browser", profile_digest: digest,
    config_digest: prepared.config_digest, contract_digest: prepared.contract_digest };
  const context = ContextPackSchema.parse({ task: { id: "task", title: "Design", description: "", acceptance_criteria: [] },
    project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    product_development: productDevelopmentContext("design") });
  const write = (path: string, value: unknown) => writeFileSync(join(workspace, path), typeof value === "string" ? value : JSON.stringify(value));
  write(".artoo/product/research.json", { version: 1, objective: "Journal", assumptions: [],
    requirements: [{ id: "entry", description: "Store an entry", priority: "must", acceptance_criteria: ["Entry persists"] }],
    sources: [{ id: "fixture", url: "https://example.com", title: "Declared fixture", retrieved_at: "2026-11-04T00:00:00Z", content_digest: digest }],
    findings: [{ summary: "Storage", source_ids: ["fixture"] }], decisions: [] });
  const design = ProductDesignSchema.parse({ version: 1, requirement_ids: ["entry"], information_architecture: ["Entries"],
    user_flows: [{ id: "save", name: "Save", requirement_ids: ["entry"], steps: ["Save an entry"] }],
    screens: [{ id: "journal", name: "Journal", purpose: "Write", states: ["Empty"], accessibility: ["Labels"], responsive: ["Phone"] }],
    prototype: { entrypoint: "product/index.html", description: "Clickable mock" }, data_model: [], api_contracts: [], decisions: [{ decision: "Local storage", rationale: "Offline" }],
    validation_cases: [{ id: "keyboard", requirement_ids: ["entry"], procedure: ["Tab to Save"], expected_result: "Save is focused",
      browser_program: { version: 2, contract_digest: prepared.contract_digest, steps: [
        { action: "navigate", page: "main", path: "/" }, { action: "press", page: "main", key: "Tab" },
        { action: "assert_focused", page: "main", selector: "#save" },
      ] } }] });
  write(".artoo/product/design.json", design); write("product/index.html", "<title>Journal</title><button id=save>Save</button>");
  return { workspace, evidence, prepared, binding, context, design, write };
}

describe("protected browser program v2 planning", () => {
  it("advertises only the implemented actions and actual named width/height policy", () => {
    const f = fixture();
    expect(f.prepared.contract).toMatchObject({ version: 2, browser_steps_version: 2, legacy_browser_steps: "rejected",
      device_scale_factor: 1, viewports: [{ id: "compact", width: 390, height: 600 }, { id: "tall", width: 390, height: 1000 }],
      keyboard: { focus_setup: "programmatic", focus_scope: "main-frame-dom" } });
    expect(f.prepared.contract.actions).toEqual(ProductBrowserStepV2Schema.options.map((option) => option.shape.action.value));
    expect(f.prepared.contract.unavailable).toEqual(["multiple-pages", "storage-exception-injection", "native-screen-reader", "browser-zoom"]);
  });
  it("derives expected ordered operations from source and binds both same-width viewports", () => {
    const f = fixture(), plan = deriveExpectedWebAcceptanceV2(f.workspace, f.context, f.prepared.options, f.binding);
    expect(plan.programs).toHaveLength(2);
    expect(plan.programs.map((program) => program.viewport.height)).toEqual([600, 1000]);
    expect(plan.programs[0]).toMatchObject({ program_digest: sha(canonical(f.design.validation_cases[0]!.browser_program)),
      steps: [{ index: 0, action: "navigate", expected_observation: { kind: "navigation" } },
        { index: 1, action: "press", expected_observation: { kind: "key-press", key: "Tab" } },
        { index: 2, action: "assert_focused", expected_observation: { kind: "focus-assertion", passed: true } }], captures: [{ page_id: "main" }] });
    const old = plan.programs[0]!.program_digest;
    f.design.validation_cases[0]!.browser_program!.steps[1] = { action: "press", page: "main", key: "Shift+Tab" };
    f.write(".artoo/product/design.json", f.design);
    expect(deriveExpectedWebAcceptanceV2(f.workspace, f.context, f.prepared.options, f.binding).programs[0]!.program_digest).not.toBe(old);
  });
  it("derives prototype-only as one actual navigate with no invented assertion", () => {
    const f = fixture(false), plan = deriveExpectedWebAcceptanceV2(f.workspace, f.context, f.prepared.options, f.binding);
    expect(plan.casePrograms).toEqual([{ case_id: "prototype", program: { version: 2, contract_digest: f.binding.contract_digest,
      steps: [{ action: "navigate", page: "main", path: "/index.html" }] } }]);
    expect(plan.programs.every((program) => program.steps.length === 1 && program.steps[0]!.action === "navigate")).toBe(true);
  });
  it("rejects legacy cases, mismatched contract/config and setup-only declarations", () => {
    const f = fixture(), test = f.design.validation_cases[0]!;
    test.browser_program!.contract_digest = digest; f.write(".artoo/product/design.json", f.design);
    expect(() => deriveExpectedWebAcceptanceV2(f.workspace, f.context, f.prepared.options, f.binding)).toThrow("contract digest");
    test.browser_program!.contract_digest = f.binding.contract_digest;
    test.browser_program!.steps = [{ action: "navigate", page: "main", path: "/" }, { action: "focus", page: "main", selector: "#save" }];
    f.write(".artoo/product/design.json", f.design);
    expect(() => deriveExpectedWebAcceptanceV2(f.workspace, f.context, f.prepared.options, f.binding)).toThrow("focus assertion");
    test.browser_program = undefined; test.browser_steps = [{ action: "navigate", path: "/" }, { action: "assert_text", selector: "body", text: "Save" }];
    f.write(".artoo/product/design.json", f.design);
    expect(() => deriveExpectedWebAcceptanceV2(f.workspace, f.context, f.prepared.options, f.binding)).toThrow("legacy browser_steps");
    expect(() => deriveExpectedWebAcceptanceV2(f.workspace, f.context, f.prepared.options, { ...f.binding, config_digest: digest })).toThrow("configured binding");
  });
  it("requires a binding and produces explicitly empty v2 research without claiming browser execution", async () => {
    const f = fixture(); f.context.product_development = productDevelopmentContext("research");
    await expect(runWebAcceptance(f.workspace, f.context, f.prepared.options)).rejects.toThrow("protected capability binding");
    expect(deriveExpectedWebAcceptanceV2(f.workspace, f.context, f.prepared.options, f.binding).programs).toEqual([]);
    const report = await runWebAcceptance(f.workspace, f.context, f.prepared.options, "research", f.binding);
    expect(report).toEqual({ version: 2, format: "static-web-acceptance.v2", stage: "research", passed: true,
      requirements: 1, device_scale_factor: 1, capability_binding: f.binding, cases: [] });
    const directory = join(f.evidence, readdirSync(f.evidence)[0]!);
    expect(readdirSync(directory)).toEqual(["result.json"]);
    expect(JSON.parse(readFileSync(join(directory, "result.json"), "utf8"))).toEqual(report);
  });
});

describe("actual browser operation recording (controlled handlers)", () => {
  const program = (steps: ProductBrowserProgramV2["steps"]): ProductBrowserProgramV2 => ({ version: 2, contract_digest: digest, steps });
  function focusContext(passed = true, failure?: string) {
    const send = vi.fn(async (method: string) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.callFunctionOn") {
        if (failure) return { result: {}, exceptionDetails: { text: failure } };
        return { result: { type: "object", objectId: "observation" } };
      }
      if (method === "Runtime.getProperties") return { result: [{ name: "passed", value: { type: "boolean", value: passed } },
        { name: "active", value: { type: "object", subtype: "node", objectId: "active" } }] };
      if (method === "DOM.describeNode") return { node: { shadowRoots: [] } };
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`Unexpected CDP method ${method}`);
    });
    const detach = vi.fn(async () => undefined);
    return { context: () => ({ newCDPSession: async () => ({ send, detach }) }) };
  }
  it("appends only after awaited operations and omits failed and unexecuted steps", async () => {
    let release!: () => void;
    const press = vi.fn(() => new Promise<void>((resolve) => { release = resolve; })), type = vi.fn(async () => { throw new Error("type failed"); });
    const page = { ...focusContext(), keyboard: { press, type } } as unknown as Page;
    const operations: BrowserOperationV2[] = [];
    const pending = executeBrowserProgramV2(page, "http://local.invalid", program([
      { action: "press", page: "main", key: "Tab" }, { action: "type_text", page: "main", text: "secret" },
      { action: "press", page: "main", key: "Enter" },
    ]), 1000, operations);
    await vi.waitFor(() => expect(press).toHaveBeenCalledOnce()); expect(operations).toEqual([]);
    release(); await expect(pending).rejects.toThrow("type failed");
    expect(operations).toEqual([{ index: 0, action: "press", page_id: "main",
      planned_step_digest: sha(canonical({ action: "press", page: "main", key: "Tab" })), observation: { kind: "key-press", key: "Tab" } }]);
    expect(press).toHaveBeenCalledTimes(1); expect(type).toHaveBeenCalledWith("secret");
  });
  it("reports only non-sensitive observations for typing and programmatic focus", async () => {
    const page = { ...focusContext(), keyboard: { type: vi.fn(async () => undefined) } } as unknown as Page;
    const operations = await executeBrowserProgramV2(page, "http://local.invalid", program([
      { action: "focus", page: "main", selector: "#entry" }, { action: "type_text", page: "main", text: "private-value" },
      { action: "assert_focused", page: "main", selector: "#entry" },
    ]), 1000);
    expect(operations.map((operation) => operation.observation)).toEqual([{ kind: "programmatic-focus", focused: true },
      { kind: "keyboard-input", text_length: 13 }, { kind: "focus-assertion", passed: true }]);
    expect(JSON.stringify(operations)).not.toContain("private-value"); expect(JSON.stringify(operations)).not.toContain("#entry");
  });
  it("records an actual response status and rejects failed navigation", async () => {
    const goto = vi.fn().mockResolvedValueOnce({ ok: () => true, status: () => 204 }).mockResolvedValueOnce({ ok: () => false, status: () => 404 });
    const page = { goto } as unknown as Page, input = program([{ action: "navigate", page: "main", path: "/" }]);
    expect((await executeBrowserProgramV2(page, "http://local.invalid", input, 1000))[0]!.observation).toEqual({ kind: "navigation", status_code: 204 });
    const operations: BrowserOperationV2[] = [];
    await expect(executeBrowserProgramV2(page, "http://local.invalid", input, 1000, operations)).rejects.toThrow("HTTP 2xx");
    expect(operations).toEqual([]);
  });
  it("does not record a timed-out keyboard operation even if it later resolves", async () => {
    let release!: () => void;
    const page = { ...focusContext(), keyboard: { press: () => new Promise<void>((resolve) => { release = resolve; }) } } as unknown as Page;
    const operations: BrowserOperationV2[] = [];
    await expect(executeBrowserProgramV2(page, "http://local.invalid", program([{ action: "press", page: "main", key: "Tab" }]), 20, operations)).rejects.toThrow("protected timeout");
    release(); await Promise.resolve(); expect(operations).toEqual([]);
  });
  it("fails a missing focus assertion and never reports setup as a passed assertion", async () => {
    const page = { ...focusContext(false) } as unknown as Page, operations: BrowserOperationV2[] = [];
    await expect(executeBrowserProgramV2(page, "http://local.invalid", program([{ action: "assert_focused", page: "main", selector: "#absent" }]), 30, operations)).rejects.toThrow();
    expect(operations).toEqual([]);
  });
  it("rejects unsupported keyboard focus before sending input", async () => {
    const press = vi.fn(async () => undefined), page = { ...focusContext(false, "iframe/shadow unsupported"), keyboard: { press } } as unknown as Page;
    await expect(executeBrowserProgramV2(page, "http://local.invalid", program([{ action: "press", page: "main", key: "Tab" }]), 1000)).rejects.toThrow("unsupported");
    expect(press).not.toHaveBeenCalled();
  });
});
