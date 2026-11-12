import { describe, expect, it } from "vitest";
import { readDiscussionGoalDraft } from "./discussionGoalDraft.js";

const scope = { organizationId: "org_1", userId: "user_1", projectId: "project_1" };
const draft = { version: 1, ...scope, roomId: "room_1", messageId: "message_1", objective: "Build a running journal" };
describe("discussion goal drafts", () => {
  it("keeps an editable draft bound to its account and project", () => {
    expect(readDiscussionGoalDraft(draft, scope)).toEqual(draft);
    for (const key of ["organizationId", "userId", "projectId"] as const) {
      expect(readDiscussionGoalDraft({ ...draft, [key]: "other" }, scope)).toBeUndefined();
    }
  });
  it.each([null, {}, { ...draft, version: 2 }, { ...draft, objective: " " }, { ...draft, objective: "x".repeat(10001) }])("rejects malformed or oversized navigation state", (value) => {
    expect(readDiscussionGoalDraft(value, scope)).toBeUndefined();
  });
});
