import { describe, expect, it } from "vitest";
import { ContextPackSchema } from "./context-pack.js";
import { TaskSpecSchema } from "./goal.js";
import {
  AcceptedProductInputsSchema, DevelopmentStageSchema, ProductDesignSchema, ProductResearchReportSchema, ProductValidationReportSchema,
  ProductDesignV1Schema, ProductDesignV2Schema, ProductValidationReportV1Schema,
  productDevelopmentContext, validateProductDevelopmentHandoff, validateProductDevelopmentPlan,
} from "./product-development.js";

const research = () => ProductResearchReportSchema.parse({
  version: 1, objective: "Make a local journal", assumptions: ["Single user"],
  requirements: [{ id: "save", description: "Entries survive reload", priority: "must", acceptance_criteria: ["Reload preserves the text"] }],
  sources: [{ id: "storage", url: "https://example.com/storage", title: "Storage specification", retrieved_at: "2026-11-04T00:00:00Z", content_digest: `sha256:${"a".repeat(64)}` }],
  findings: [{ summary: "Storage persists across navigation", source_ids: ["storage"] }], decisions: [],
});
const design = () => ProductDesignV1Schema.parse({
  version: 1, requirement_ids: ["save"], information_architecture: ["Entries and editor"],
  user_flows: [{ id: "write", name: "Write an entry", requirement_ids: ["save"], steps: ["Open editor", "Save text", "Reload"] }],
  screens: [{ id: "editor", name: "Editor", purpose: "Compose entries", states: ["Empty", "Saved", "Storage error"], accessibility: ["Labeled input"], responsive: ["Single column on mobile"] }],
  prototype: { entrypoint: "prototype/index.html", description: "Interactive editor prototype" },
  data_model: [{ name: "Entry", fields: ["id", "body"], relationships: [] }], api_contracts: [],
  decisions: [{ decision: "Use browser storage", rationale: "No account needed" }],
  validation_cases: [{ id: "reload", requirement_ids: ["save"], procedure: ["Save an entry", "Reload the page"], expected_result: "Entry remains visible" }],
});
const validation = () => ProductValidationReportV1Schema.parse({
  version: 1, cases: [{ case_id: "reload", requirement_ids: ["save"], outcome: "passed", observations: "Entry remains after reload", evidence_paths: ["evidence/reload.png"] }], known_limitations: [],
});
const plan = () => DevelopmentStageSchema.options.map((stage, index) => ({
  development_stage: stage, dependencies: index ? [{ ref: String(index - 1), type: "blocks" }] : [],
}));

describe("product development stage contracts", () => {
  it("preserves legacy task specs and optional context extension compatibility", () => {
    expect(TaskSpecSchema.parse({ title: "Manual work", acceptance_criteria: ["Done"] })).not.toHaveProperty("development_stage");
    expect(ContextPackSchema.shape.product_development.safeParse(undefined).success).toBe(true);
    for (const stage of DevelopmentStageSchema.options) {
      expect(ContextPackSchema.shape.product_development.parse(productDevelopmentContext(stage))!.stage).toBe(stage);
      expect(productDevelopmentContext(stage).deliverables[0]?.path).toMatch(/^\.artoo\/product\//);
    }
  });

  it("keeps returned context independent from the shared stage definitions", () => {
    const first = productDevelopmentContext("research");
    first.instructions[0] = "Changed by a consumer";
    first.deliverables[0]!.path = "other.json";
    const second = productDevelopmentContext("research");
    expect(second.instructions.join(" ")).toContain("actual URL");
    expect(second.deliverables[0]!.path).toBe(".artoo/product/research.json");
  });

  it("limits accepted inputs to unique fixed specification files and measured source bindings", () => {
    const file = { path: ".artoo/product/research.json", checksum: `sha256:${"a".repeat(64)}`, size: 12,
      source_task_id: "task_research", source_run_id: "run_research", evidence_id: "evidence_research" };
    expect(AcceptedProductInputsSchema.safeParse({ version: 1, files: [file] }).success).toBe(true);
    for (const files of [[file, file], [{ ...file, path: "product/test.js" }], [{ ...file, size: 0 }], [{ ...file, source_run_id: "" }]]) {
      expect(AcceptedProductInputsSchema.safeParse({ version: 1, files }).success).toBe(false);
    }
  });

  it("requires fetched source provenance and valid references", () => {
    const value = research();
    expect(ProductResearchReportSchema.safeParse({ ...value, sources: [] }).success).toBe(false);
    expect(ProductResearchReportSchema.safeParse({ ...value, findings: [{ summary: "Unsupported", source_ids: ["invented"] }] }).success).toBe(false);
    expect(ProductResearchReportSchema.safeParse({ ...value, sources: [{ ...value.sources[0], content_digest: "claimed-success" }] }).success).toBe(false);
    expect(ProductResearchReportSchema.safeParse({ ...value, sources: [{ ...value.sources[0], url: "https://user:password@example.com" }] }).success).toBe(false);
    expect(ProductResearchReportSchema.safeParse({ ...value, requirements: [...value.requirements, ...value.requirements] }).success).toBe(false);
  });

  it("requires a local prototype and explicit design coverage", () => {
    const value = design();
    expect(ProductDesignSchema.safeParse({ ...value, prototype: { entrypoint: "../outside.html", description: "Outside" } }).success).toBe(false);
    expect(ProductDesignSchema.safeParse({ ...value, requirement_ids: ["save", "delete"] }).success).toBe(false);
    expect(ProductDesignSchema.safeParse({ ...value, validation_cases: [{ ...value.validation_cases[0], requirement_ids: ["invented"] }] }).success).toBe(false);
    expect(ProductDesignSchema.safeParse({ ...value, screens: [] }).success).toBe(false);
  });

  it("keeps V1 parsing and V2 strict coverage checks independent after sharing the design shape", () => {
    const legacy = design(), baseCase = legacy.validation_cases[0]!;
    expect(ProductDesignV1Schema.parse({ ...legacy, extension: true })).not.toHaveProperty("extension");
    const program = { version: 3, contract_digest: "sha256:" + "a".repeat(64), steps: [
      { action: "navigate", page: "main", path: "/" },
      { action: "assert_text", page: "main", selector: "#saved", text: "Saved" },
    ] };
    expect(ProductDesignV1Schema.safeParse({ ...legacy, validation_cases: [{
      ...baseCase, browser_program: program,
      browser_steps: [{ action: "navigate", path: "/" }, { action: "assert_text", selector: "#saved", text: "Saved" }],
    }] }).success).toBe(false);

    const next = { ...legacy, version: 2, validation_cases: [{
      ...baseCase, method: "workspace-check", requirement_criteria: [{ requirement_id: "save", criterion_index: 0 }],
      browser_program: program,
    }] };
    expect(ProductDesignV2Schema.parse(next)).toEqual(next);
    expect(ProductDesignV2Schema.safeParse({ ...next, extension: true }).success).toBe(false);
    expect(ProductDesignV2Schema.safeParse({ ...next, validation_cases: [{
      ...next.validation_cases[0]!, requirement_criteria: [{ requirement_id: "unrelated", criterion_index: 0 }],
    }] }).success).toBe(false);
  });

  it("rejects requirement loss between independently authored stage handoffs", () => {
    const requirements = research();
    requirements.requirements.push({ id: "delete", description: "Delete an entry", priority: "must", acceptance_criteria: ["Deleted entries stay deleted"] });
    expect(validateProductDevelopmentHandoff(requirements, design())).toEqual(["Design omits required outcome delete."]);
    expect(validateProductDevelopmentHandoff(research(), { ...design(), requirement_ids: ["save", "invented"] })).toContain("Design references unknown requirement invented.");
  });

  it("rejects missing, failed, blocked, or unrelated validation evidence", () => {
    expect(validateProductDevelopmentHandoff(research(), design(), validation())).toEqual([]);
    for (const outcome of ["failed", "blocked"] as const) {
      const actual = validation(); actual.cases[0]!.outcome = outcome;
      expect(validateProductDevelopmentHandoff(research(), design(), actual)).toContain(`Validation case reload is ${outcome}.`);
    }
    expect(validateProductDevelopmentHandoff(research(), design(), { ...validation(), cases: [] })).toContain("Missing validation result for reload.");
    const actual = validation(); actual.cases[0]!.requirement_ids = ["invented"];
    expect(validateProductDevelopmentHandoff(research(), design(), actual)).toContain("Validation case reload omits required coverage.");
    expect(ProductValidationReportSchema.safeParse({ ...validation(), cases: [validation().cases[0], validation().cases[0]] }).success).toBe(false);
    const unsafe = validation(); unsafe.cases[0]!.evidence_paths = ["/etc/passwd"];
    expect(ProductValidationReportSchema.safeParse(unsafe).success).toBe(false);
  });

  it.each(["blocked", "failed"] as const)("allows an honest %s draft only for preview without changing its claims", outcome => {
    const actual = validation(); actual.cases[0]!.outcome = outcome;
    const original = structuredClone(actual);
    expect(validateProductDevelopmentHandoff(research(), design(), actual, "preview")).toEqual([]);
    expect(actual).toEqual(original);
    expect(validateProductDevelopmentHandoff(research(), design(), actual)).toEqual([`Validation case reload is ${outcome}.`]);
    expect(validateProductDevelopmentHandoff(research(), design(), actual, "final")).toEqual([`Validation case reload is ${outcome}.`]);
  });

  it("keeps preview case coverage and report schema requirements", () => {
    const actual = validation(); actual.cases[0]!.outcome = "blocked";
    expect(validateProductDevelopmentHandoff(research(), design(), { ...actual, cases: [] }, "preview"))
      .toContain("Missing validation result for reload.");
    const changed = structuredClone(actual); changed.cases[0]!.requirement_ids = ["invented"];
    expect(validateProductDevelopmentHandoff(research(), design(), changed, "preview"))
      .toEqual(["Validation case reload omits required coverage.", "Validation case reload references unknown requirements."]);
    changed.cases[0]!.case_id = "other";
    expect(validateProductDevelopmentHandoff(research(), design(), changed, "preview")).toContain("Unknown validation case other.");
    for (const evidence_paths of [[], ["../outside.txt"], ["/absolute.txt"]]) {
      expect(ProductValidationReportSchema.safeParse({ ...actual, cases: [{ ...actual.cases[0], evidence_paths }] }).success).toBe(false);
    }
    expect(ProductValidationReportSchema.safeParse({ ...actual, cases: [actual.cases[0], actual.cases[0]] }).success).toBe(false);
  });
});

describe("agent team stage graph", () => {
  it("accepts complete blocking stage handoffs", () => { expect(validateProductDevelopmentPlan(plan())).toEqual([]); });
  it("rejects skipped stages and missing stage labels", () => {
    expect(validateProductDevelopmentPlan(plan().slice(1))).toContain("The plan is missing the research stage.");
    expect(validateProductDevelopmentPlan([{ dependencies: [] }, ...plan().slice(1)])).toContain("Task 0 has no development_stage.");
  });
  it("does not mistake soft context for a completion dependency", () => {
    const value = plan(); value[1]!.dependencies[0]!.type = "soft_context";
    expect(validateProductDevelopmentPlan(value)).toContain("Task 1 must wait for research task 0.");
  });
  it("rejects artifact types that the standard team runtime cannot automatically collect", () => {
    expect(validateProductDevelopmentPlan(plan().map((item) => ({ ...item, expected_artifacts: [{ type: "report" }] })))).toEqual([]);
    const value = plan().map((item) => ({ ...item, expected_artifacts: [{ type: "test_result" }] }));
    expect(validateProductDevelopmentPlan(value)[0]).toContain("unsupported automatic artifact type");
  });
  it("requires the final validation to wait for every implementation branch", () => {
    const value = plan(); value.push({ development_stage: "implementation", dependencies: [{ ref: "1", type: "blocks" }] });
    expect(validateProductDevelopmentPlan(value)).toContain("Task 3 must wait for implementation task 4.");
    value[3]!.dependencies.push({ ref: "4", type: "blocks" });
    expect(validateProductDevelopmentPlan(value)).toEqual([]);
  });
  it("rejects cyclic, backwards and out-of-range references without recursion overflow", () => {
    const cycle = plan(); cycle[0]!.dependencies.push({ ref: "3", type: "blocks" });
    expect(validateProductDevelopmentPlan(cycle)).toContain("Task 0 participates in a dependency cycle.");
    expect(validateProductDevelopmentPlan(cycle)).toContain("Task 0 depends on a later development stage.");
    const bad = plan(); bad[1]!.dependencies[0]!.ref = "999";
    expect(validateProductDevelopmentPlan(bad)).toContain("Task 1 has an invalid dependency 999.");
  });
});
