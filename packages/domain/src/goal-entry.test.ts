import { describe, expect, it } from "vitest";
import { PreparedGoalEntryV1Schema } from "./goal-entry.js";

describe("optional prepared goal entry v1", () => {
  const common = { version: 1, session_id: "session-one", project_id: "project-one", goal_id: null };
  it("keeps console request identity and body out of its public monitoring snapshot", () => {
    expect(PreparedGoalEntryV1Schema.parse({ ...common, submission_owner: "console" })).toEqual({ ...common, submission_owner: "console" });
    expect(PreparedGoalEntryV1Schema.safeParse({ ...common, submission_owner: "console", request_key: "private-console-request" }).success).toBe(false);
  });
  it("requires explicit configured publication and handoff for browser entry", () => {
    const request = { execution_mode: "agent_team", verification_profile_id: "native-web", release_profile_id: "native-publish",
      max_retries: 3, source_handoff: { version: 1, mode: "automatic" } };
    const browser = { ...common, submission_owner: "browser", request_key: "request-one", request };
    expect(PreparedGoalEntryV1Schema.parse(browser)).toEqual(browser);
    for (const change of [{ version: 2 }, { request: { ...request, release_profile_id: "" } }, { request_key: undefined }, { request: { ...request, source_handoff: undefined } }]) {
      expect(PreparedGoalEntryV1Schema.safeParse({ ...browser, ...change }).success).toBe(false);
    }
  });
});
