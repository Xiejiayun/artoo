import { runs } from "@artoo/db";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { mapRun } from "./mappers.js";

const row: typeof runs.$inferSelect = {
  id: "run_A", organizationId: "org_A", taskId: "task_A", computerId: "computer_A",
  agentInstanceId: "ai_A", runtimeId: "mock", schedulerDecisionId: null, modelProfileId: null,
  effortProfileId: null, status: "queued", contextPackId: null, startedAt: null, endedAt: null,
  failureReason: null, sequence: 0, workspaceRoot: "/Legacy//Cafe\u0301/\u8349\u7a3f /",
  workspaceBranch: "Feature/Keep-\u00c9", workspaceAllocation: null, createdAt: "2026-10-03T00:00:00.000Z",
};
const allocation = { version: 1, strategy: "per-run", base_path: "/Approved//Cafe\u0301/\u8349\u7a3f /" };

describe("Run allocation persistence mapping", () => {
  it.each([null, undefined])("omits a nullish allocation record rather than changing legacy API shape: %s", (value) => {
    const mapped = mapRun({ ...row, workspaceAllocation: value });
    expect(mapped).not.toHaveProperty("workspace_allocation");
    expect(mapped.workspace_root).toBe(row.workspaceRoot);
    expect(mapped.workspace_branch).toBe(row.workspaceBranch);
  });

  it("preserves legacy null roots and branches", () => {
    const mapped = mapRun({ ...row, workspaceRoot: null, workspaceBranch: null });
    expect(mapped.workspace_root).toBeNull();
    expect(mapped.workspace_branch).toBeNull();
    expect(mapped).not.toHaveProperty("workspace_allocation");
  });

  it("maps a valid persisted record exactly without recomputing root or branch", () => {
    const mapped = mapRun({ ...row, workspaceAllocation: allocation });
    expect(mapped.workspace_allocation).toEqual(allocation);
    expect(mapped.workspace_root).toBe(row.workspaceRoot);
    expect(mapped.workspace_branch).toBe(row.workspaceBranch);
    expect(JSON.parse(JSON.stringify(mapped)).workspace_allocation).toEqual(allocation);
    expect(mapped).not.toHaveProperty("workspace_retention");
  });

  it.each([
    { ...allocation, version: 2 },
    { ...allocation, approved: true },
  ])("rejects invalid persisted metadata at the shared RunSchema boundary: %j", (value) => {
    expect(() => mapRun({ ...row, workspaceAllocation: value })).toThrow(ZodError);
  });
});
