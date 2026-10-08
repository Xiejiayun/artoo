import { describe, expect, it } from "vitest";

import { WorktreeBaseConfigurationSchema, WorkspaceAllocationRecordSchema } from "./workspace-allocation.js";
import { RunSchema } from "./schemas.js";

const config = { version: 1, strategy: "per-run", basePath: "/Approved/Runs" };
const allocation = { version: 1, strategy: "per-run", base_path: "/Approved/Runs" };
const run = {
  id: "run_A", organization_id: "org_A", task_id: "task_A", computer_id: "computer_A",
  agent_instance_id: "ai_A", runtime_id: "mock", status: "queued", created_at: "2026-10-03T00:00:00Z",
};
const retained = {
  version: 1, workspace_root: "/Approved/Runs/artoo-runs/i-61695f41/r-72756e5f41",
  workspace_branch: "artoo/run-run_A", outcome: "completed", reporter_computer_id: "computer_A",
  event_id: "evt_A", position: 1, sequence: 2, reported_at: "2026-10-03T00:01:00Z",
};

describe("workspace allocation structural contracts", () => {
  it("uses distinct exact config and persisted-record keys without defaults or coercion", () => {
    expect(WorktreeBaseConfigurationSchema.parse(config)).toEqual(config);
    expect(WorkspaceAllocationRecordSchema.parse(allocation)).toEqual(allocation);
    expect(WorktreeBaseConfigurationSchema.safeParse(allocation).success).toBe(false);
    expect(WorkspaceAllocationRecordSchema.safeParse(config).success).toBe(false);
    expect(WorktreeBaseConfigurationSchema.safeParse({ ...config, version: "1" }).success).toBe(false);
  });

  it.each([
    undefined, null, [], {}, { strategy: "per-run", basePath: "/Runs" },
    { version: 2, strategy: "per-run", basePath: "/Runs" },
    { version: 1, strategy: "legacy", basePath: "/Runs" },
    { ...config, approved: true }, { ...config, basePath: 42 },
  ])("rejects malformed or extensible configuration %#", (value) => {
    expect(WorktreeBaseConfigurationSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    undefined, null, [], {}, { version: 1, strategy: "per-run" },
    { ...allocation, version: 2 }, { ...allocation, strategy: "legacy" },
    { ...allocation, root: "/other" }, { ...allocation, base_path: false },
  ])("rejects malformed or extensible allocation record %#", (value) => {
    expect(WorkspaceAllocationRecordSchema.safeParse(value).success).toBe(false);
  });

  it.each(["", "a\0b", "a".repeat(4097)])("uses the existing bounded no-NUL path envelope %#", (base) => {
    expect(WorktreeBaseConfigurationSchema.safeParse({ ...config, basePath: base }).success).toBe(false);
    expect(WorkspaceAllocationRecordSchema.safeParse({ ...allocation, base_path: base }).success).toBe(false);
  });

  it.each([
    "/Approved//Café/", "/Approved/Cafe\u0301/", "C:\\Mixed\\Runs/", "//Server/Share/Runs/", "/Runs/ a /",
  ])("preserves base spelling through JSON serialization: %s", (base) => {
    expect(WorktreeBaseConfigurationSchema.parse(JSON.parse(JSON.stringify({ ...config, basePath: base }))).basePath).toBe(base);
    expect(WorkspaceAllocationRecordSchema.parse(JSON.parse(JSON.stringify({ ...allocation, base_path: base }))).base_path).toBe(base);
  });

  it("does not claim target-OS validation or normalization from a structural parse", () => {
    expect(WorktreeBaseConfigurationSchema.parse({ ...config, basePath: " relative " }).basePath).toBe(" relative ");
    expect(WorkspaceAllocationRecordSchema.parse({ ...allocation, base_path: "relative" }).base_path).toBe("relative");
  });

  it("keeps ordinary parsed DTO behavior; persistence enforces immutability later", () => {
    const parsed = WorkspaceAllocationRecordSchema.parse(allocation);
    expect(Object.isFrozen(parsed)).toBe(false);
    expect(parsed).toEqual(allocation);
  });

  it("keeps legacy omitted and null allocation/root shapes unchanged", () => {
    const omitted = RunSchema.parse({ ...run, workspace_root: null, workspace_branch: null });
    expect(omitted.workspace_root).toBeNull();
    expect(omitted).not.toHaveProperty("workspace_allocation");
    expect(RunSchema.parse({ ...run, workspace_allocation: null }).workspace_allocation).toBeNull();
  });

  it("round-trips allocation and independent retention projection together", () => {
    const row = RunSchema.parse(JSON.parse(JSON.stringify({
      ...run, workspace_root: retained.workspace_root, workspace_branch: retained.workspace_branch,
      workspace_allocation: allocation, workspace_retention: retained,
    })));
    expect(row.workspace_allocation).toEqual(allocation);
    expect(row.workspace_retention).toEqual(retained);
    expect(row.workspace_root).toBe(retained.workspace_root);
  });

  it("rejects malformed present allocation without loosening retention validation", () => {
    expect(RunSchema.safeParse({ ...run, workspace_allocation: { ...allocation, version: 2 } }).success).toBe(false);
    expect(RunSchema.safeParse({ ...run, workspace_allocation: allocation,
      workspace_retention: { ...retained, injected: true } }).success).toBe(false);
  });
});
