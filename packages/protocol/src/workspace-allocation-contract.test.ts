import { describe, expect, it } from "vitest";
import {
  RunStartPayloadSchema, WorktreeBaseConfigurationSchema, WorkspaceAllocationRecordSchema,
  type WorktreeBaseConfiguration as DomainConfiguration,
} from "@artoo/domain";
import { allocateWorkspaceRoot, type WorktreeBaseConfiguration as AllocatorConfiguration } from "./index.js";
import { runStartCommandSchema } from "./node-messages.js";

const allocation = { version: 1, strategy: "per-run", base_path: "/Approved/Runs" };
const start = {
  run_id: "run_A", task_id: "task_A", agent_instance_id: "ai_A", runtime: "mock",
  workspace: { root: "/legacy", branch: "Branch-With-Case" },
  context_pack: { id: "ctx_A", uri: "artoo://contextpack/ctx_A" },
  policy_snapshot: { filesystem_write_scope: ["/legacy"], requires_approval: [] },
  artifact_rules: { paths: ["*.patch"] },
};

describe("allocation payload compatibility", () => {
  it("retains legacy start payload without introducing allocation", () => {
    const parsed = RunStartPayloadSchema.parse(start);
    expect(parsed).toEqual(start);
    expect(parsed).not.toHaveProperty("workspace_allocation");
  });

  it("round-trips top-level allocation alongside existing typed retention reporting", () => {
    const command = {
      kind: "command", id: "cmd_A", idempotency_key: "run_A:start", type: "run.start",
      payload: { ...start, workspace_allocation: allocation, workspace_retention_reporting: "typed-v1" },
    };
    const parsed = runStartCommandSchema.parse(JSON.parse(JSON.stringify(command)));
    expect(parsed).toEqual(command);
    expect(parsed.payload.workspace_allocation).toEqual(allocation);
    expect(parsed.payload.workspace_retention_reporting).toBe("typed-v1");
    expect(parsed.payload.workspace.branch).toBe("Branch-With-Case");
    expect(parsed.payload.workspace).not.toHaveProperty("allocation");
  });

  it.each([null, {}, { ...allocation, version: 2 }, { ...allocation, strategy: "other" }, { ...allocation, approved: true }])(
    "rejects null, unknown or extra allocation metadata on run.start %#", (value) => {
      expect(RunStartPayloadSchema.safeParse({ ...start, workspace_allocation: value }).success).toBe(false);
    });

  it("does not change existing retention-reporting unknown-version compatibility", () => {
    expect(RunStartPayloadSchema.parse({ ...start, workspace_allocation: allocation,
      workspace_retention_reporting: "future-version" }).workspace_retention_reporting).toBe("future-version");
  });

  it("leaves deterministic root/branch coherence and authority to later execution integration", () => {
    const parsed = RunStartPayloadSchema.parse({ ...start, workspace: { root: "/different" }, workspace_allocation: allocation });
    expect(parsed.workspace_allocation).toEqual(allocation);
    expect(parsed.workspace).toEqual({ root: "/different" });
    expect(RunStartPayloadSchema.safeParse({ ...start, workspace: { root: null }, workspace_allocation: allocation }).success).toBe(false);
  });

  it("exports compatible DTO types while keeping all target-OS validation in the exact allocator", () => {
    const domainConfig: DomainConfiguration = WorktreeBaseConfigurationSchema.parse({ version: 1, strategy: "per-run", basePath: "/Approved/Runs" });
    const allocatorConfig: AllocatorConfiguration = domainConfig;
    const roundTripType: DomainConfiguration = allocatorConfig;
    expect(roundTripType).toEqual(domainConfig);
    expect(WorkspaceAllocationRecordSchema.parse(allocation)).toEqual(allocation);
    expect(allocateWorkspaceRoot({ workspaceRoot: null, branchBacked: true, targetComputerOs: "darwin",
      agentInstanceId: "ai_A", runId: "run_A", worktreeBase: domainConfig })).toBe("/Approved/Runs/artoo-runs/i-61695f41/r-72756e5f41");
    const relative = WorktreeBaseConfigurationSchema.parse({ ...domainConfig, basePath: "relative" });
    expect(() => allocateWorkspaceRoot({ workspaceRoot: "/legacy", branchBacked: true, targetComputerOs: "darwin",
      agentInstanceId: "ai_A", runId: "run_A", worktreeBase: relative })).toThrow(/fully qualified POSIX/);
    expect(allocateWorkspaceRoot({ workspaceRoot: null, branchBacked: false, targetComputerOs: "unsupported",
      agentInstanceId: "bad", runId: "bad", worktreeBase: null })).toBeNull();
  });
});
