import { describe, expect, it } from "vitest";
import { DiscussionPlanPreviewSchema, TaskSpecSchema } from "@artoo/domain";
import { parseDiscussionPlan } from "./discussion-plan.js";
import { validatePlanTaskSpecs } from "./plan-service.js";
import { AppError } from "../errors.js";

const spec = { title: "Implement", acceptance_criteria: ["Works"] };
const metadata = (task_specs: unknown[]) => ({ version: 1, discussion_id: "discussion", goal_id: "goal", rationale: "Why", task_specs: task_specs.map((spec) => TaskSpecSchema.parse(spec)) });

function invalid(body: string): AppError {
  try { parseDiscussionPlan(body); }
  catch (error) { expect(error).toBeInstanceOf(AppError); return error as AppError; }
  throw new Error("Expected invalid task plan");
}

describe("bounded discussion plan diagnostics", () => {
  it("reports nested field paths and expected types without echoing received values", () => {
    const error = invalid(JSON.stringify({ rationale: "private-token-in-rationale", task_specs: [{ ...spec,
      title: { secret: "private-token-in-title" }, dependencies: [{ ref: 0, type: "blocks" }] }] }));
    expect(error).toMatchObject({ code: "validation_error", httpStatus: 400, details: { diagnostic_version: 1, omitted_issues: 0,
      diagnostics: [{ code: "invalid_type", path: "$.task_specs[0].title", expected: "string" },
        { code: "invalid_type", path: "$.task_specs[0].dependencies[0].ref", expected: "string" }] } });
    expect(error.message).toContain("$.task_specs[0].dependencies[0].ref: invalid_type; expected string");
    expect(JSON.stringify(error.toEnvelope())).not.toContain("private-token");
    expect(error.message).not.toContain("manually");
  });
  it("keeps missing fields, wrong root shapes and invalid enum values invalid", () => {
    expect(invalid("{}").details.diagnostics).toEqual([{ code: "invalid_type", path: "$.task_specs", expected: "array" }]);
    expect(invalid('"private-root-value"').details.diagnostics).toEqual([{ code: "invalid_type", path: "$", expected: "object" }]);
    const error = invalid(JSON.stringify({ task_specs: [{ ...spec, development_stage: "private-token-as-stage" }] }));
    expect(error.message).toContain('$.task_specs[0].development_stage: invalid_enum_value; expected one of "research", "design", "implementation", "validation"');
    expect(JSON.stringify(error.toEnvelope())).not.toContain("private-token-as-stage");
  });
  it("reports the real JSON syntax location without copying parser excerpts", () => {
    const body = '{\n  "rationale": "private-provider-credential",\n  "task_specs": [],\n}';
    const error = invalid(body);
    expect(error.details.diagnostics).toEqual([{ code: "invalid_json", path: "$", expected: "a double-quoted property name",
      position: body.length - 1, line: 4, column: 1 }]);
    expect(error.message).toContain("line 4, column 1");
    expect(JSON.stringify(error.toEnvelope())).not.toContain("private-provider-credential");
  });
  it.each([{ body: "", expected: "a complete JSON value" },
    { body: '{"rationale":"private-provider-credential",', expected: "a double-quoted property name" }])
    ("identifies incomplete JSON without repairing or exposing its content", ({ body, expected }) => {
      expect(invalid(body).details.diagnostics).toEqual([{ code: "invalid_json", path: "$", expected,
        position: body.length, line: 1, column: body.length + 1 }]);
    });
  it("does not leak invalid JSON tokens or accept prose and trailing content", () => {
    for (const body of ["private-provider-credential", `${JSON.stringify({ task_specs: [spec] })} private-provider-credential`]) {
      const error = invalid(body);
      expect(error.details.diagnostics).toEqual([expect.objectContaining({ code: "invalid_json", path: "$" })]);
      expect(JSON.stringify(error.toEnvelope())).not.toContain("private-provider-credential");
    }
  });
  it("bounds schema feedback while preserving required fields and collection limits", () => {
    const error = invalid(JSON.stringify({ rationale: "private-secret".repeat(2000), task_specs: Array.from({ length: 60 }, () => ({ title: "", acceptance_criteria: [] })) }));
    expect(error.details.diagnostics).toHaveLength(6);
    expect(error.details.omitted_issues).toBeGreaterThan(0);
    expect(error.message).toContain("$.rationale: too_big; expected string with at most 20000 characters");
    expect(error.message).toContain("$.task_specs: too_big; expected array with at most 50 items");
    expect(error.message).toContain("expected array with at least 1 item");
    expect(error.message.length).toBeLessThan(2000);
    expect(JSON.stringify(error.toEnvelope()).length).toBeLessThan(4000);
    expect(JSON.stringify(error.toEnvelope())).not.toContain("private-secret");
  });
});

describe("discussion plan presentation contract", () => {
  it("uses the proposal content rules while keeping defaults and raw output separate", () => {
    const body = JSON.stringify({ rationale: "Reason", task_specs: [spec, { ...spec, title: "Review", dependencies: [{ ref: "0", type: "blocks" }] }] });
    const parsed = parseDiscussionPlan(`\`\`\`json\n${body}\n\`\`\``);
    expect(validatePlanTaskSpecs(parsed.task_specs)).toEqual(parsed.task_specs);
    expect(DiscussionPlanPreviewSchema.parse({ ...metadata(parsed.task_specs), rationale: parsed.rationale }).task_specs[1]?.dependencies[0]?.ref).toBe("0");
  });
  it.each([
    ["unknown", [{ ...spec, dependencies: [{ ref: "2", type: "blocks" }] }]],
    ["self", [{ ...spec, dependencies: [{ ref: "0", type: "blocks" }] }]],
    ["cycle", [{ ...spec, dependencies: [{ ref: "1", type: "blocks" }] }, { ...spec, dependencies: [{ ref: "0", type: "blocks" }] }]],
    ["approval", [{ ...spec, approval_gates: ["review"] }]],
    ["scope", [{ ...spec, write_scopes: ["/"] }]],
  ])("rejects %s rather than hiding unsupported content behind a card", (_name, specs) => {
    expect(DiscussionPlanPreviewSchema.safeParse(metadata(specs as unknown[])).success).toBe(false);
    expect(() => validatePlanTaskSpecs(specs as Parameters<typeof validatePlanTaskSpecs>[0])).toThrow();
  });
  it("requires a bounded normalized versioned preview", () => {
    expect(DiscussionPlanPreviewSchema.safeParse({ ...metadata([spec]), task_specs: [spec] }).success).toBe(false);
    expect(DiscussionPlanPreviewSchema.safeParse({ ...metadata([spec]), version: 2 }).success).toBe(false);
    expect(DiscussionPlanPreviewSchema.safeParse(metadata(Array.from({ length: 51 }, () => spec))).success).toBe(false);
    expect(DiscussionPlanPreviewSchema.safeParse(metadata([spec, { ...spec, dependencies: [{ ref: "0x0", type: "blocks" }] }])).success).toBe(false);
    expect(DiscussionPlanPreviewSchema.safeParse(metadata([spec, { ...spec, dependencies: [{ ref: "0", type: "soft_context" }] }])).success).toBe(true);
  });
});
