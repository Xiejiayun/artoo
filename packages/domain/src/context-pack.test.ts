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
});
