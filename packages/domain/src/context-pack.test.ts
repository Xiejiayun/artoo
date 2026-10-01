import { describe, expect, it } from "vitest";

import { ContextPackSchema } from "./context-pack.js";

const validPack = {
  task: { id: "task_1", title: "Build inbox", description: "d", acceptance_criteria: ["a1"] },
  project: { id: "proj_1", name: "artoo", default_workspace: null },
  workspace: { root: "C:/workspace/artoo", file_scope: ["packages/domain/**"] },
  policy: { filesystem_write_scope: ["C:/workspace/artoo"], requires_approval: ["git.push"] },
  memory: { task_summary: null, project_notes: [] },
  artifacts: { expected: ["*.patch"] },
};

describe("ContextPack", () => {
  it("accepts a static core pack", () => {
    expect(ContextPackSchema.parse(validPack)).toEqual(validPack);
  });

  it("rejects a pack missing a required section", () => {
    const result = ContextPackSchema.safeParse({ ...validPack, policy: undefined });
    expect(result.success).toBe(false);
  });

  const reviewFeedback = {
    version: 1,
    entries: [{
      event_id: "evt_review", position: 42, task_id: "task_1",
      actor: { type: "user", id: "user_reviewer" },
      occurred_at: "2026-10-01T00:00:00.000Z", comment: "  Fix 修正\n\twithout trimming  ",
    }],
  };

  it("preserves versioned review feedback with exact text and event provenance", () => {
    const pack = { ...validPack, review_feedback: reviewFeedback };
    expect(ContextPackSchema.parse(pack)).toEqual(pack);
  });

  it.each([{ artifact_ids: null }, { artifact_ids: [] }, { artifact_ids: ["artifact_first"] }])("preserves known or legacy artifact attribution: %j", ({ artifact_ids }) => {
    const pack = { ...validPack, review_feedback: { ...reviewFeedback,
      entries: [{ ...reviewFeedback.entries[0], artifact_ids }] } };
    expect(ContextPackSchema.parse(pack)).toEqual(pack);
  });

  it.each([
    { event_id: "" }, { position: 0 }, { task_id: "" }, { actor: { type: "user", id: "" } },
    { occurred_at: "" }, { comment: " \n\t" },
  ])("rejects review feedback with invalid provenance or empty content: %j", (override) => {
    expect(ContextPackSchema.safeParse({
      ...validPack,
      review_feedback: { ...reviewFeedback, entries: [{ ...reviewFeedback.entries[0], ...override }] },
    }).success).toBe(false);
  });
});
