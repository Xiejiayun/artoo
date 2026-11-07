import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ContextPackSchema, ProductBrowserStepSchema, productDevelopmentContext } from "@artoo/domain";
import { normalizeWebAcceptanceOptions } from "./web-acceptance-config.js";
import { prepareStaticWebCapabilities, runWebAcceptance, validateStaticWebCapabilitySnapshot } from "./web-acceptance.js";

const digest = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("protected static web configured capabilities", () => {
  it("derives exact non-default viewport and stage policy without disclosing private paths or claiming execution", () => {
    const prepared = prepareStaticWebCapabilities({ viewports: [320, 1440], action_timeout_ms: 1500, design_capture_cases: true,
      browser_executable: join(tmpdir(), "private-browser"), evidence_root: join(tmpdir(), "private-evidence") });
    expect(prepared.contract).toMatchObject({ claim: "configured", viewports: [
      { id: "width-320", width: 320, height: 900 }, { id: "width-1440", width: 1440, height: 900 },
    ], stage_policy: { research: "no-browser", design: "declared-cases" }, limits: { action_timeout_ms: 1500 } });
    expect(prepared.contract.actions).toEqual(ProductBrowserStepSchema.options.map((option) => option.shape.action.value));
    expect(prepared.contract.unavailable).toContain("native-screen-reader");
    expect(prepared.contract.unavailable).toContain("browser-zoom");
    expect(JSON.stringify(prepared.contract)).not.toContain("private-");
    expect("viewports" in prepared.options && Object.isFrozen(prepared.options.viewports)).toBe(true);
    expect(Object.isFrozen(prepared.contract.stage_policy)).toBe(true);
    const defaults = prepareStaticWebCapabilities({});
    expect(defaults.contract.stage_policy.design).toBe("prototype-only");
    expect(defaults.contract.viewports.map((viewport) => viewport.width)).toEqual([1280, 390]);
    expect(defaults.contract_digest).not.toBe(prepared.contract_digest);
  });

  it("uses one strict normalized option contract and stable digests without injecting metadata into legacy input", () => {
    expect(prepareStaticWebCapabilities({})).toEqual(prepareStaticWebCapabilities({ action_timeout_ms: 5000,
      viewports: [1280, 390], design_capture_cases: false, browser_executable: undefined }));
    for (const input of [{ argv: ["node"] }, { viewports: [390, 390] }, { viewports: [] }, { viewports: [239] },
      { action_timeout_ms: 499 }, { action_timeout_ms: 10001 }, { design_capture_cases: "true" }, { evidence_root: "product/evidence" }]) {
      expect(() => normalizeWebAcceptanceOptions(input)).toThrow();
    }
    const options = { viewports: [390] };
    prepareStaticWebCapabilities(options);
    expect(options).toEqual({ viewports: [390] });
  });

  it("rejects a changed private configuration or public digest before any product work", () => {
    const prepared = prepareStaticWebCapabilities({ viewports: [390] });
    const binding = { version: 1 as const, command_id: "browser", profile_digest: digest,
      config_digest: prepared.config_digest, contract_digest: prepared.contract_digest };
    const snapshot = { version: 1, binding, options: prepared.options };
    expect(validateStaticWebCapabilitySnapshot(snapshot)).toEqual(snapshot);
    for (const changed of [{ ...snapshot, options: { ...prepared.options, viewports: [1280] } },
      { ...snapshot, binding: { ...binding, contract_digest: digest } },
      { ...snapshot, binding: { ...binding, config_digest: digest } },
      { ...snapshot, options: { ...prepared.options, evaluate: "alert(1)" } },
      { ...snapshot, options: { viewports: [390] } }]) expect(() => validateStaticWebCapabilitySnapshot(changed)).toThrow();
  });

  it("executes research with an explicitly bound empty browser report and preserves legacy report bytes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "artoo-capability-research-")); roots.push(workspace);
    mkdirSync(join(workspace, ".artoo/product"), { recursive: true });
    writeFileSync(join(workspace, ".artoo/product/research.json"), JSON.stringify({ version: 1, objective: "Journal", assumptions: [],
      requirements: [{ id: "save", description: "Persist entries", priority: "must", acceptance_criteria: ["Save and reload"] }],
      sources: [{ id: "fixture", url: "https://example.com", title: "Declared fixture", retrieved_at: "2026-11-04T00:00:00Z", content_digest: digest }],
      findings: [{ summary: "File format fixture only", source_ids: ["fixture"] }], decisions: [] }));
    const context = ContextPackSchema.parse({ task: { id: "task", title: "Research", description: "", acceptance_criteria: [] },
      project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
      policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
      product_development: productDevelopmentContext("research") });
    const prepared = prepareStaticWebCapabilities({ viewports: [320] });
    const capability_binding = { version: 1 as const, command_id: "browser", profile_digest: digest,
      config_digest: prepared.config_digest, contract_digest: prepared.contract_digest };
    const old = { version: 1, format: "static-web-acceptance.v1", stage: "research", passed: true, requirements: 1, cases: [] };
    expect(await runWebAcceptance(workspace, context)).toEqual(old);
    expect(await runWebAcceptance(workspace, context, prepared.options, "bound", capability_binding)).toEqual({ ...old, capability_binding });
    await expect(runWebAcceptance(workspace, context, { viewports: [390] }, "changed", capability_binding)).rejects.toThrow("configured binding");
  });
});
