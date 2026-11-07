import { describe, expect, it } from "vitest";
import { ProductDesignV2Schema, ProductResearchReportV2Schema, WorkspaceValidationCaseV2Schema } from "./product-development.js";
import { CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT,
  CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST } from "./release-capabilities.js";
import { AdditiveDesignRevisionRequestV1Schema, validateAdditiveDesignRevision } from "./product-design-revision.js";

const hash = `sha256:${"a".repeat(64)}`;
const ref = (criterion_index = 0) => ({ requirement_id: "search", criterion_index });
const release = { release_binding: { version: 1, release_profile_id: "release", release_profile_digest: hash,
  contract_digest: hash, project_id: "project", workspace_root: "C:\\product", verification_profile_id: "checks",
  verification_profile_digest: hash }, claim_id: CONFIGURED_STATIC_PUBLICATION_CLAIM,
  statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST };
const workspaceCase = (id: string, criterion_index = 0) => WorkspaceValidationCaseV2Schema.parse({
  id, method: "workspace-check", requirement_ids: ["search"], requirement_criteria: [ref(criterion_index)],
  procedure: ["Create an entry", "Search its title and body"], expected_result: "Only matching entries appear",
  browser_program: { version: 3, contract_digest: hash, steps: [
    { action: "navigate", page: "main", path: "/" }, { action: "fill", page: "main", selector: "#search", value: "n" },
    { action: "assert_count", page: "main", selector: ".entry", count: 0 },
  ] },
});
function fixture() {
  const research = ProductResearchReportV2Schema.parse({ version: 1, objective: "Search a journal", assumptions: [],
    requirements: [{ id: "search", description: "Search entries", priority: "must", acceptance_criteria: ["Search title and body", "Literal search"] },
      { id: "publish", description: "Configured publication", priority: "must", acceptance_criteria: [CONFIGURED_STATIC_PUBLICATION_STATEMENT] }],
    sources: [{ id: "source", url: "https://example.com/spec", title: "Controlled fixture", retrieved_at: "2026-11-06T00:00:00Z", content_digest: hash }],
    findings: [{ summary: "Search contract", source_ids: ["source"] }], decisions: [],
    measurement_plan: { version: 2, profile_digest: hash, entries: [...[0, 1].map(criterion_index => ({ method: "workspace-check",
      ...ref(criterion_index), command_id: "browser", config_digest: hash, contract_digest: hash,
      actions: ["navigate", "fill", "assert_count"], keys: [], viewports: [{ id: "compact", width: 390, height: 844 }], needs: [],
    })), { method: "configured-static-release", requirement_id: "publish", criterion_index: 0, ...release }] },
  });
  const baseline = ProductDesignV2Schema.parse({ version: 2, requirement_ids: ["search", "publish"], information_architecture: ["Journal"],
    user_flows: [{ id: "find", name: "Find entries", requirement_ids: ["search"], steps: ["Type query", "Read results"] }],
    screens: [{ id: "journal", name: "Journal", purpose: "Read entries", states: ["Empty", "Results"], accessibility: ["Labeled input"], responsive: ["Single column"] }],
    prototype: { entrypoint: "product/index.html", description: "Searchable journal" }, data_model: [], api_contracts: [],
    decisions: [{ decision: "Literal search", rationale: "Predictable" }], validation_cases: [workspaceCase("original"), workspaceCase("literal", 1),
      { id: "publication", method: "configured-static-release", requirement_ids: ["publish"],
        requirement_criteria: [{ requirement_id: "publish", criterion_index: 0 }], procedure: ["Run configured publisher"], expected_result: CONFIGURED_STATIC_PUBLICATION_STATEMENT, ...release }],
  });
  const candidate = structuredClone(baseline); candidate.validation_cases.push(workspaceCase("regression"));
  const request = AdditiveDesignRevisionRequestV1Schema.parse({ version: 1, kind: "add-validation-cases",
    reason: "Cover the literal separator regression", requirement_criteria: [ref()] });
  return { baseline, candidate, research, request };
}
type Fixture = ReturnType<typeof fixture>;
const inspect = (f: Fixture) => validateAdditiveDesignRevision(f.baseline, f.candidate, f.research, f.request);

describe("additive accepted-design revisions", () => {
  it("appends a regression without mutating research, old cases or publication", () => {
    const f = fixture(), before = JSON.stringify(f);
    expect(inspect(f)).toEqual([]); expect(JSON.stringify(f)).toBe(before);
  });
  it("compares object fields independently of their serialized key order", () => {
    const f = fixture(); f.candidate = Object.fromEntries(Object.entries(f.candidate).reverse()) as typeof f.candidate;
    expect(inspect(f)).toEqual([]);
  });
  it.each(["no-addition", "drop", "reorder", "assertion", "procedure", "trim", "publication-binding"])("preserves exact accepted cases: %s", change => {
    const f = fixture();
    if (change === "no-addition") f.candidate.validation_cases.pop();
    if (change === "drop") f.candidate.validation_cases.splice(0, 1);
    if (change === "reorder") [f.candidate.validation_cases[0], f.candidate.validation_cases[1]] = [f.candidate.validation_cases[1]!, f.candidate.validation_cases[0]!];
    if (change === "assertion") f.candidate.validation_cases[0] = workspaceCase("original", 1);
    if (change === "procedure") f.candidate.validation_cases[0]!.procedure = ["Skip the search"];
    if (change === "trim") f.candidate.validation_cases[0]!.expected_result += " ";
    if (change === "publication-binding") {
      const item = f.candidate.validation_cases[2]!;
      if (item.method === "configured-static-release") item.release_binding.release_profile_id = "other";
    }
    expect(inspect(f).some(error => /preserve|append/.test(error))).toBe(true);
  });
  it.each(["requirements", "prototype", "screen", "decision", "unknown-nested"])("preserves accepted design fields: %s", change => {
    const f = fixture();
    if (change === "requirements") f.candidate.requirement_ids.reverse();
    if (change === "prototype") f.candidate.prototype.description = "Another design";
    if (change === "screen") f.candidate.screens[0]!.states.push("Other");
    if (change === "decision") f.candidate.decisions[0]!.rationale += " ";
    if (change === "unknown-nested") {
      Object.assign(f.baseline.screens[0]!, { retained_extension: { value: 1 } });
      Object.assign(f.candidate.screens[0]!, { retained_extension: { value: 2 } });
    }
    expect(inspect(f)).toContain("A design revision must preserve every accepted non-case field.");
  });
  it("rejects a new case ID that duplicates an accepted one", () => {
    const f = fixture(); f.candidate.validation_cases.at(-1)!.id = "original"; expect(inspect(f).length).toBeGreaterThan(0);
  });
  it("requires a new case for each requested criterion", () => {
    const f = fixture(); f.request.requirement_criteria.push(ref(1));
    expect(inspect(f)).toContain("Every requested criterion needs an appended validation case.");
    f.candidate.validation_cases.push(workspaceCase("second_regression", 1)); expect(inspect(f)).toEqual([]);
  });
  it("rejects appended cases outside the requested criteria", () => {
    const f = fixture(); f.candidate.validation_cases.push(workspaceCase("unrequested", 1));
    expect(inspect(f).some(error => error.includes("outside the revision request"))).toBe(true);
  });
  it.each(["release", "unknown", "out-of-range"])("rejects non-workspace requests: %s", change => {
    const f = fixture(); f.request.requirement_criteria = [{ requirement_id: change === "release" ? "publish" : change === "unknown" ? "missing" : "search",
      criterion_index: change === "out-of-range" ? 2 : 0 }];
    expect(inspect(f)).toContain("A design revision may target only existing accepted workspace criteria.");
  });
  it("does not append or settle another publication case", () => {
    const f = fixture(); f.candidate.validation_cases.push({ ...structuredClone(f.baseline.validation_cases[2]!), id: "extra_publication" });
    expect(inspect(f)).toContain("A design revision may append only workspace validation cases.");
  });
  it("rejects a baseline that no longer covers the pinned research", () => {
    const f = fixture(); f.research.requirements[0]!.acceptance_criteria.push("New requirement");
    expect(inspect(f)).toContain("The accepted design baseline does not match its pinned research.");
  });
  it.each(["version", "empty", "duplicate", "authority"])("rejects malformed or authority-bearing request data: %s", change => {
    const f = fixture(), request: Record<string, unknown> = { ...f.request };
    if (change === "version") request.version = 2;
    if (change === "empty") request.requirement_criteria = [];
    if (change === "duplicate") request.requirement_criteria = [ref(), ref()];
    if (change === "authority") request.accepted = true;
    expect(AdditiveDesignRevisionRequestV1Schema.safeParse(request).success).toBe(false);
  });
  it("keeps legacy designs outside this explicitly versioned path", () => {
    const f = fixture(); expect(validateAdditiveDesignRevision({ ...f.baseline, version: 1 }, f.candidate, f.research, f.request).length).toBeGreaterThan(0);
  });
});
