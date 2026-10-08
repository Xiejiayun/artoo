import type { contextPacks, runs } from "@artoo/db";
import { ContextPackSchema, RunWorkspaceRetainedPayloadSchema, WorkspaceAllocationRecordSchema, type ContextPack, type WorkspaceAllocationRecord } from "@artoo/domain";
import { allocateWorkspaceRoot, WorkspaceAllocationError } from "@artoo/protocol";
import { isDeepStrictEqual } from "node:util";

import { AppError } from "./errors.js";

export type AllocatedStartRun = Pick<typeof runs.$inferSelect, "id" | "organizationId" | "taskId" | "computerId"
  | "agentInstanceId" | "contextPackId" | "workspaceRoot" | "workspaceBranch" | "workspaceAllocation">;
export type AllocatedStartContext = Pick<typeof contextPacks.$inferSelect, "id" | "organizationId" | "taskId" | "runId" | "payload">;

export function validatePersistedAllocationStart(
  run: AllocatedStartRun,
  stored: AllocatedStartContext | undefined,
  metadata: { computerOs: string | undefined; projectId: string | undefined },
): { root: string; branch: string; allocation: WorkspaceAllocationRecord; context: { id: string; payload: ContextPack } } {
  const blocked = (reason: string): never => {
    throw AppError.conflict("Persisted allocation dispatch is blocked", { run_id: run.id, dispatch: "blocked", reason });
  };
  const allocation = WorkspaceAllocationRecordSchema.safeParse(run.workspaceAllocation);
  if (!allocation.success) return blocked("invalid_allocation_record");
  const storedRoot = RunWorkspaceRetainedPayloadSchema.shape.workspace_root.safeParse(run.workspaceRoot);
  if (!storedRoot.success) return blocked(typeof run.workspaceRoot !== "string" || run.workspaceRoot.length === 0
    ? "missing_workspace_root" : "invalid_workspace_root");
  const storedBranch = RunWorkspaceRetainedPayloadSchema.shape.workspace_branch.safeParse(run.workspaceBranch);
  if (!storedBranch.success) return blocked("invalid_workspace_branch");
  const root = storedRoot.data, branch = storedBranch.data;
  if (typeof run.contextPackId !== "string" || !run.contextPackId || !stored) return blocked("missing_persisted_context");
  if (stored.id !== run.contextPackId || stored.organizationId !== run.organizationId
    || stored.runId !== run.id || stored.taskId !== run.taskId) return blocked("context_identity_mismatch");
  const context = ContextPackSchema.safeParse(stored.payload);
  if (!context.success || !isDeepStrictEqual(context.data, stored.payload)) return blocked("invalid_persisted_context");
  if (context.data.task.id !== run.taskId || metadata.projectId === undefined
    || context.data.project.id !== metadata.projectId || context.data.workspace.root !== root) return blocked("context_value_mismatch");
  if (metadata.computerOs === undefined) return blocked("missing_execution_computer");
  try {
    // Comparison only: use the persisted record and immutable run identities.
    // Never rewrite a stored root or consult the current instance configuration.
    const expected = allocateWorkspaceRoot({ workspaceRoot: root, branchBacked: true,
      targetComputerOs: metadata.computerOs, agentInstanceId: run.agentInstanceId, runId: run.id,
      worktreeBase: { version: allocation.data.version, strategy: allocation.data.strategy, basePath: allocation.data.base_path } });
    if (expected !== root) return blocked("allocation_root_mismatch");
  } catch (error) {
    if (error instanceof WorkspaceAllocationError) return blocked("invalid_allocation_identity");
    throw error;
  }
  return { root, branch, allocation: allocation.data, context: { id: stored.id, payload: context.data } };
}
