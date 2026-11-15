import { describe, expect, it } from "vitest";
import {
  SchedulerAgentPolicyV1Schema,
  SchedulerComputerPolicyV1Schema,
  SchedulerProjectPolicyV1Schema,
} from "./scheduler-policy.js";

describe("scheduler metadata v1", () => {
  const project = { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 4 };
  it("accepts explicit metadata and rejects unknown execution or tenant fields", () => {
    expect(SchedulerProjectPolicyV1Schema.parse(project)).toEqual(project);
    expect(
      SchedulerAgentPolicyV1Schema.parse({
        version: 1,
        max_concurrent_runs: 2,
        pinned_computer_id: null,
        required_runtimes: ["codex"],
        required_labels: ["trusted"],
      }).pinned_computer_id,
    ).toBeNull();
    for (const extra of [{ command: "execute" }, { organization_id: "other" }, { version: 2 }]) {
      expect(SchedulerProjectPolicyV1Schema.safeParse({ ...project, ...extra }).success).toBe(false);
    }
    expect(
      SchedulerComputerPolicyV1Schema.safeParse({ version: 1, labels: ["a", " a "], max_concurrent_runs: 2 }).success,
    ).toBe(false);
  });
  it("rejects malformed baseline refs and unbounded capacities", () => {
    for (const branch of [
      "",
      "@",
      "-main",
      "/main",
      ".main",
      "a..b",
      "a b",
      "a\\b",
      "a@{b",
      "a.lock",
      "a//b",
      "a/",
      "a.",
      "a/.b",
      "a~1",
      "a\0b",
    ]) {
      expect(SchedulerProjectPolicyV1Schema.safeParse({ ...project, default_branch: branch }).success, branch).toBe(
        false,
      );
    }
    for (const branch of ["main", "release/v1", "feature/hello-world"]) {
      expect(SchedulerProjectPolicyV1Schema.safeParse({ ...project, default_branch: branch }).success).toBe(true);
    }
    for (const capacity of [0, 1.5, 65, "4"])
      expect(SchedulerProjectPolicyV1Schema.safeParse({ ...project, max_concurrent_runs: capacity }).success).toBe(
        false,
      );
  });
});
