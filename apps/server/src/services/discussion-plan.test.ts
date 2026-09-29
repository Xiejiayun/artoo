import { describe, expect, it } from "vitest";
import { DiscussionPlanPreviewSchema, TaskSpecSchema } from "@artoo/domain";
import { parseDiscussionPlan } from "./discussion-plan.js";
import { validatePlanTaskSpecs } from "./plan-service.js";

const spec = { title: "Implement", acceptance_criteria: ["Works"] };
const metadata = (task_specs: unknown[]) => ({ version: 1, discussion_id: "discussion", goal_id: "goal", rationale: "Why", task_specs: task_specs.map((spec) => TaskSpecSchema.parse(spec)) });

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
