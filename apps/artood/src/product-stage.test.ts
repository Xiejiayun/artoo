import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { productDevelopmentContext, type ContextPack } from "@artoo/domain";
import { prepareResearchOptions } from "./research.js";
import { readProductFile, validateProductStage } from "./product-stage.js";
import { initializeEmptyProductRepository } from "./product-bootstrap.js";
import { resolveCliCommand } from "./cli-resolver.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "artoo-product-stage-")); roots.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const options = prepareResearchOptions({ receiptDirectory: join(root, "receipts") }, [workspace]);
  const write = (path: string, value: unknown) => writeFileSync(join(workspace, path), typeof value === "string" ? value : JSON.stringify(value));
  const context: ContextPack = { task: { id: "task_1", title: "Design", description: "Design", acceptance_criteria: [] }, project: { id: "project_1", name: "Product", default_workspace: workspace },
    workspace: { root: workspace, file_scope: [] }, policy: { requires_approval: [], filesystem_write_scope: [workspace] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    goal_context: { version: 1, goal_id: "goal_1", objective: "Journal", acceptance_criteria: [], plan: null }, product_development: productDevelopmentContext("design") };
  const source = { id: `source_${"a".repeat(32)}`, url: "https://example.com/", title: "Reference", retrieved_at: "2026-11-04T00:00:00.000Z", content_digest: `sha256:${createHash("sha256").update("source").digest("hex")}` };
  writeFileSync(join(options.receiptDirectory, `${source.id}.json`), JSON.stringify({ ...source, version: 1, binding: { runId: "research_run", taskId: "research_task", projectId: "project_1", goalId: "goal_1", workspaceRoot: workspace }, content_base64: Buffer.from("source").toString("base64") }));
  mkdirSync(join(workspace, ".artoo", "product"), { recursive: true }); mkdirSync(join(workspace, "product"));
  write(".artoo/product/research.json", { version: 1, objective: "Journal", assumptions: [], requirements: [{ id: "entry", description: "Store an entry", priority: "must", acceptance_criteria: ["Entry persists"] }], sources: [source], findings: [{ summary: "Storage", source_ids: [source.id] }], decisions: [] });
  const design = { version: 1, requirement_ids: ["entry"], information_architecture: ["Entries"], user_flows: [{ id: "save", name: "Save", requirement_ids: ["entry"], steps: ["Save an entry"] }],
    screens: [{ id: "journal", name: "Journal", purpose: "Write", states: ["Empty", "Saved", "Error"], accessibility: ["Labels"], responsive: ["Phone"] }],
    prototype: { entrypoint: "product/prototype.html", description: "Clickable mock" }, data_model: [], api_contracts: [], decisions: [{ decision: "Local storage", rationale: "Offline" }],
    validation_cases: [{ id: "save_reload", requirement_ids: ["entry"], procedure: ["Save", "Reload"], expected_result: "Entry remains" }] };
  write(".artoo/product/design.json", design);
  return { root, workspace, options, context, write, design };
}
describe("product handoff observations", () => {
  it("requires a real prototype within the measured product tree", () => {
    const f = fixture();
    expect(() => validateProductStage(f.workspace, f.context, f.options)).toThrow();
    f.write("product/prototype.html", "<button>Save</button>");
    expect(validateProductStage(f.workspace, f.context, f.options)[0]?.payload.type).toBe("report");
    f.write("outside.html", "not measured"); f.design.prototype.entrypoint = "outside.html"; f.write(".artoo/product/design.json", f.design);
    expect(() => validateProductStage(f.workspace, f.context, f.options)).toThrow(/measured/);
  });
  it("rejects failed or missing validation results and missing evidence instead of trusting a report", () => {
    const f = fixture(); f.context.product_development = productDevelopmentContext("validation"); f.write("product/prototype.html", "<button>Save</button>"); f.write(".artoo/product/implementation.md", "Implemented storage.");
    const report = { version: 1, cases: [{ case_id: "save_reload", requirement_ids: ["entry"], outcome: "failed", observations: "Entry disappears", evidence_paths: ["product/evidence.txt"] }], known_limitations: [] };
    f.write(".artoo/product/validation.json", report);
    expect(() => validateProductStage(f.workspace, f.context, f.options)).toThrow(/failed/);
    report.cases[0]!.outcome = "passed"; f.write(".artoo/product/validation.json", report);
    expect(() => validateProductStage(f.workspace, f.context, f.options)).toThrow();
    f.write("product/evidence.txt", "Observed saved entry after reload"); expect(validateProductStage(f.workspace, f.context, f.options)).toHaveLength(1);
  });
  it("refuses hard-linked or traversing handoff files", () => {
    const f = fixture(); f.write("product/prototype.html", "prototype");
    linkSync(join(f.workspace, "product/prototype.html"), join(f.workspace, "linked.html"));
    expect(() => readProductFile(f.workspace, "product/prototype.html")).toThrow(/regular file/);
    expect(() => readProductFile(f.workspace, "../outside")).toThrow(/Invalid/);
  });
  it("never initializes or overwrites a nonempty directory", async () => {
    const f = fixture();
    await expect(initializeEmptyProductRepository(f.workspace, resolveCliCommand("git")?.[0] ?? "/usr/bin/git")).rejects.toThrow(/nonempty/);
  });
  it.runIf(process.platform !== "win32")("initializes a real empty repository once, keeping future source unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "artoo-product-init-")); roots.push(root);
    const git = resolveCliCommand("git")?.[0]; expect(git).toBeDefined();
    expect(await initializeEmptyProductRepository(root, git!)).toBe("created");
    writeFileSync(join(root, "product", "index.html"), "hello");
    expect(await initializeEmptyProductRepository(root, git!)).toBe("existing");
    expect(readProductFile(root, "product/index.html").toString()).toBe("hello");
  });
});
