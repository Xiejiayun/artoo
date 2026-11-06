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

  it("retains source-plan and dependency evidence without changing legacy packs", () => {
    const handoff = { ...validPack, goal_context: { version: 1, goal_id: "goal_1", objective: "Build a journal", acceptance_criteria: ["Persists"], plan: { id: "plan_1", version: 2, rationale: "Use local storage", spec_ref: "1" } },
      dependency_context: { version: 1, truncated: false, entries: [{ task_id: "task_design", title: "Design", dependency_type: "blocks", status: "done", acceptance_criteria: ["Schema defined"], run_id: "run_design", workspace_root: null, artifacts_truncated: false,
        artifacts: [{ id: "artifact_1", type: "contract", run_id: "run_design", checksum: null, content_path: "/api/v1/artifacts/artifact_1/content" }] }] } };
    expect(ContextPackSchema.parse(handoff)).toEqual(handoff);
    expect(ContextPackSchema.safeParse({ ...handoff, dependency_context: { ...handoff.dependency_context, version: 2 } }).success).toBe(false);
    expect(ContextPackSchema.parse(validPack)).toEqual(validPack);
  });

  it("keeps legacy review subjects valid while binding optional measured scope to the reviewed stage", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const subject = { version: 1, task_id: "source_task", run_id: "source_run", evidence_id: "source_evidence",
      subject_digest: digest, development_stage: "design" };
    expect(ContextPackSchema.parse({ ...validPack, review_subject: subject }).review_subject).toEqual(subject);
    const verification = { version: 1, request_id: "source_request", profile_id: "browser", profile_digest: digest,
      checks: [{ id: "browser", output_digest: digest, observation: { version: 1, format: "static-web-acceptance.v1",
        scope: "final", stage: "design", cases: [] } }] };
    const pack = { ...validPack, review_subject: { ...subject, verification } };
    expect(ContextPackSchema.parse(pack)).toEqual(pack);
    expect(ContextPackSchema.safeParse({ ...pack, review_subject: { ...pack.review_subject, development_stage: "validation" } }).success).toBe(false);
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
