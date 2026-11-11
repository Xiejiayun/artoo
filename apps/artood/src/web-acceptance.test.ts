import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextPackSchema, ProductBrowserStepSchema, productDevelopmentContext, type ProductDesign } from "@artoo/domain";
import { runWebAcceptance, serveAcceptanceProduct, validateBrowserCases } from "./web-acceptance.js";
import { launchOwnedBrowser } from "./owned-browser.js";

vi.mock("./owned-browser.js", () => ({ launchOwnedBrowser: vi.fn() }));

const roots: string[] = [];
afterEach(() => { vi.resetAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("protected static web acceptance", () => {
  it("routes a legacy blocked author draft to browser measurement only in preview", async () => {
    const root = mkdtempSync(join(tmpdir(), "artoo-validation-preview-")); roots.push(root);
    mkdirSync(join(root, ".artoo/product"), { recursive: true }); mkdirSync(join(root, "product"));
    const write = (path: string, value: unknown) => writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
    write(".artoo/product/research.json", { version: 1, objective: "Journal", assumptions: [],
      requirements: [{ id: "save", description: "Show journal", priority: "must", acceptance_criteria: ["Journal is visible"] }],
      sources: [{ id: "fixture", url: "https://example.com", title: "Declared fixture", retrieved_at: "2026-11-04T00:00:00Z", content_digest: `sha256:${"a".repeat(64)}` }],
      findings: [{ summary: "Static page fixture", source_ids: ["fixture"] }], decisions: [] });
    write(".artoo/product/design.json", { version: 1, requirement_ids: ["save"], information_architecture: ["Journal"],
      user_flows: [{ id: "read", name: "Read", requirement_ids: ["save"], steps: ["Open"] }],
      screens: [{ id: "journal", name: "Journal", purpose: "Read", states: ["Empty"], accessibility: ["Named heading"], responsive: ["Single column"] }],
      prototype: { entrypoint: "product/index.html", description: "Journal" }, data_model: [], api_contracts: [],
      decisions: [{ decision: "Static page", rationale: "Exercise the validation preview boundary" }],
      validation_cases: [{ id: "visible", requirement_ids: ["save"], procedure: ["Open"], expected_result: "Journal visible",
        browser_steps: [{ action: "navigate", path: "/" }, { action: "assert_text", selector: "h1", text: "Journal" }] }] });
    write(".artoo/product/validation.json", { version: 1, cases: [{ case_id: "visible", requirement_ids: ["save"], outcome: "blocked",
      observations: "Waiting for protected measurements", evidence_paths: ["product/evidence.txt"] }], known_limitations: [] });
    write("product/index.html", "<title>Journal</title><h1>Journal</h1>"); write("product/evidence.txt", "Not yet measured.");
    const context = ContextPackSchema.parse({ task: { id: "task", title: "Validate", description: "", acceptance_criteria: [] },
      project: { id: "project", name: "Fixture", default_workspace: root }, workspace: { root, file_scope: [] },
      policy: { filesystem_write_scope: [root], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
      product_development: productDevelopmentContext("validation") });
    vi.mocked(launchOwnedBrowser).mockRejectedValue(new Error("controlled browser measurement boundary"));
    for (const verificationScope of [undefined, "final"] as const) {
      await expect(runWebAcceptance(root, context, {}, "final", undefined, { verificationScope })).rejects.toThrow("visible is blocked");
    }
    expect(launchOwnedBrowser).not.toHaveBeenCalled();
    await expect(runWebAcceptance(root, context, {}, "preview", undefined, { verificationScope: "preview" })).rejects.toThrow("controlled browser measurement boundary");
    expect(launchOwnedBrowser).toHaveBeenCalledOnce();
    context.review_subject = { version: 1, task_id: "author", run_id: "author_run", evidence_id: "author_evidence",
      subject_digest: `sha256:${"a".repeat(64)}`, development_stage: "validation" };
    await expect(runWebAcceptance(root, context, {}, "review", undefined, { verificationScope: "preview" })).rejects.toThrow("visible is blocked");
    expect(launchOwnedBrowser).toHaveBeenCalledOnce();
  });
  it("writes a research report with explicitly empty browser coverage for evidence sealing", async () => {
    const root = mkdtempSync(join(tmpdir(), "artoo-research-observation-")); roots.push(root);
    const workspace = join(root, "workspace"), evidence = join(root, "evidence");
    mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(evidence);
    writeFileSync(join(workspace, ".artoo/product/research.json"), JSON.stringify({ version: 1, objective: "Journal", assumptions: [],
      requirements: [{ id: "save", description: "Persist entries", priority: "must", acceptance_criteria: ["Save and reload"] }],
      sources: [{ id: "fixture", url: "https://example.com", title: "Declared fixture", retrieved_at: "2026-11-04T00:00:00Z", content_digest: `sha256:${"a".repeat(64)}` }],
      findings: [{ summary: "File format fixture only", source_ids: ["fixture"] }], decisions: [] }));
    const context = ContextPackSchema.parse({ task: { id: "task", title: "Research", description: "", acceptance_criteria: [] },
      project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
      policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
      product_development: productDevelopmentContext("research") });
    const result = await runWebAcceptance(workspace, context, { evidence_root: evidence }, "research_fixture");
    expect(result).toEqual({ version: 1, format: "static-web-acceptance.v1", stage: "research", passed: true, requirements: 1, cases: [] });
    const directory = join(evidence, readdirSync(evidence)[0]!);
    expect(readdirSync(directory)).toEqual(["result.json"]);
    expect(JSON.parse(readFileSync(join(directory, "result.json"), "utf8"))).toEqual(result);
  });
  it("rejects external targets, executable steps and assertion-free tests", () => {
    for (const path of ["https://example.com", "//example.com", "/\\example.com"]) expect(ProductBrowserStepSchema.safeParse({ action: "navigate", path }).success).toBe(false);
    expect(ProductBrowserStepSchema.safeParse({ action: "evaluate", script: "process.exit(0)" }).success).toBe(false);
    const design = { version: 1, validation_cases: [{ id: "save", browser_steps: [{ action: "navigate", path: "/" }, { action: "assert_visible", selector: "body" }] }] } as ProductDesign;
    expect(() => validateBrowserCases(design)).toThrow("content, value or count assertion");
    design.validation_cases[0]!.browser_steps!.push({ action: "assert_text", selector: "#entry", text: "Saved" });
    expect(() => validateBrowserCases(design)).not.toThrow();
  });
  it("serves actual product bytes without exposing other workspace paths or executing writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "artoo-web-acceptance-")); roots.push(root);
    mkdirSync(join(root, "product")); writeFileSync(join(root, "product", "index.html"), "<h1>Actual product</h1>");
    writeFileSync(join(root, "private.json"), "not public"); writeFileSync(join(root, "product", ".env"), "not public either");
    const site = await serveAcceptanceProduct(root);
    try {
      expect(await (await fetch(site.origin)).text()).toBe("<h1>Actual product</h1>");
      for (const path of ["/.env", "/private.json", "/%2e%2e%2fprivate.json"]) expect((await fetch(`${site.origin}${path}`)).status).toBe(404);
      expect((await fetch(site.origin, { method: "POST", body: "overwrite" })).status).toBe(405);
      expect((await fetch(site.origin, { method: "HEAD" })).status).toBe(200);
    } finally { await site.close(); }
  });
});
