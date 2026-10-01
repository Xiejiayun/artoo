import { describe, expect, it } from "vitest";

import { TaskReviewSchema } from "./task-review.js";

const review = {
  event_id: "evt_review", position: 7, task_id: "task_review", outcome: "changes_requested",
  comment: "  保留原文\n\tCorrection  ", actor: { type: "user", id: "user_reviewer" },
  actor_name: "Reviewer", occurred_at: "2026-10-01T00:00:00.000Z", artifact_ids: ["artifact_first"],
};

describe("TaskReview", () => {
  it("preserves exact comment and event-level provenance", () => {
    expect(TaskReviewSchema.parse(review)).toEqual(review);
  });

  it("distinguishes unknown legacy attribution from a recorded empty inventory", () => {
    expect(TaskReviewSchema.parse({ ...review, actor_name: null, artifact_ids: null }).artifact_ids).toBeNull();
    expect(TaskReviewSchema.parse({ ...review, artifact_ids: [] }).artifact_ids).toEqual([]);
  });

  it.each([null, "", " \t\n "])("preserves accepted review comment %j in history", (comment) => {
    expect(TaskReviewSchema.parse({ ...review, outcome: "accepted", comment }).comment).toBe(comment);
  });
});
