import { describe, expect, it } from "vitest";
import { RunStartPayloadSchema } from "./node-payloads.js";
import { RunWorkspaceRetainedPayloadSchema, StoredWorkspaceRetainedPayloadSchema, WorkspaceRetentionProjectionSchema } from "./workspace-retention.js";

const report = { version: 1, workspace_root: "C:\\Work\\项目", workspace_branch: "artoo/Run-1", outcome: "completed" };
describe("historical workspace retention contracts", () => {
  it("preserves exact filesystem identity and keeps server provenance out of the wire payload", () => {
    expect(RunWorkspaceRetainedPayloadSchema.parse(report)).toEqual(report);
    expect(RunWorkspaceRetainedPayloadSchema.safeParse({ ...report, reporter_computer_id: "forged" }).success).toBe(false);
    expect(RunWorkspaceRetainedPayloadSchema.safeParse({ ...report, exists: true }).success).toBe(false);
    expect(StoredWorkspaceRetainedPayloadSchema.safeParse({ ...report, reporter_computer_id: "computer_1" }).success).toBe(true);
  });
  it.each([
    { workspace_root: "" }, { workspace_root: "x".repeat(4097) }, { workspace_root: "a\0b" },
    { workspace_branch: " branch" }, { workspace_branch: "branch " }, { workspace_branch: "x".repeat(1025) },
    { workspace_branch: "a\0b" }, { workspace_branch: null }, { version: 2 }, { outcome: "process_start_failed" },
  ])("rejects an unsupported report: %j", (invalid) => {
    expect(RunWorkspaceRetainedPayloadSchema.safeParse({ ...report, ...invalid }).success).toBe(false);
  });
  it("requires bounded accepted event metadata rather than a current-existence flag", () => {
    const projection = { ...report, reporter_computer_id: "computer_1", event_id: "evt_1", position: 9, sequence: 3, reported_at: "2026-10-01T00:00:00.000Z" };
    expect(WorkspaceRetentionProjectionSchema.parse(projection)).toEqual(projection);
    expect(WorkspaceRetentionProjectionSchema.safeParse({ ...projection, sequence: null }).success).toBe(false);
    expect(WorkspaceRetentionProjectionSchema.safeParse({ ...projection, position: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });
  it("accepts missing and unknown server advertisements without changing the base command", () => {
    const start = { run_id: "run", task_id: "task", agent_instance_id: "instance", runtime: "mock",
      workspace: { root: "/work" }, context_pack: { id: "pack", uri: "inline" },
      policy_snapshot: { filesystem_write_scope: ["/work"], requires_approval: [] }, artifact_rules: { paths: [] } };
    expect(RunStartPayloadSchema.parse(start)).not.toHaveProperty("workspace_retention_reporting");
    for (const value of ["typed-v1", "future-version"]) {
      expect(RunStartPayloadSchema.parse({ ...start, workspace_retention_reporting: value }).workspace_retention_reporting).toBe(value);
    }
  });
});
