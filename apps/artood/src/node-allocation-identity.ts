import { createHash } from "node:crypto";
import { RunStartPayloadSchema, RunWorkspaceRetainedPayloadSchema, type RunStartPayload } from "@artoo/domain";
import { allocateWorkspaceRoot } from "@artoo/protocol";

/** Small identity retained after completion; contains no historical task content. */
export interface AllocationReplayIdentity {
  readonly key: string;
}

/** In-memory launch identity, not a physical-workspace approval or recovery journal. */
export interface AllocationStartBinding extends AllocationReplayIdentity {
  /** Detached and recursively frozen; use this snapshot across asynchronous launch work. */
  readonly payload: RunStartPayload;
}

function freezeSnapshot(value: object): void {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") freezeSnapshot(child);
  }
  Object.freeze(value);
}

/**
 * Cheap new-mode contract, before run-ID deduplication or filesystem operations.
 * Absence preserves legacy behavior. The caller must supply the actual local OS,
 * never a remote OS claim. No path is normalized, read, reserved, or authorized.
 */
export function allocationStartBinding(
  input: RunStartPayload,
  localOs: string,
  committedReceipts: boolean | undefined,
): AllocationStartBinding | undefined {
  if (input.workspace_allocation === undefined) return undefined;
  const result = RunStartPayloadSchema.safeParse(input);
  if (!result.success) throw new Error("invalid per-run run.start payload");
  const payload = result.data;
  const allocation = payload.workspace_allocation!;
  if (payload.workspace_retention_reporting !== "typed-v1") {
    throw new Error("per-run allocation requires typed-v1 workspace retention");
  }
  if (committedReceipts !== true) {
    throw new Error("per-run allocation requires committed run-event receipts");
  }
  for (const [name, value] of [["task_id", payload.task_id], ["runtime", payload.runtime], ["ContextPack id", payload.context_pack.id]]) {
    if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`per-run ${name} must be a nonempty identity without surrounding whitespace or control characters`);
    }
  }
  RunWorkspaceRetainedPayloadSchema.parse({ version: 1, workspace_root: payload.workspace.root,
    workspace_branch: payload.workspace.branch, outcome: "unconfirmed" });
  const root = allocateWorkspaceRoot({
    workspaceRoot: payload.workspace.root, branchBacked: true, targetComputerOs: localOs,
    agentInstanceId: payload.agent_instance_id, runId: payload.run_id,
    worktreeBase: { version: allocation.version, strategy: allocation.strategy, basePath: allocation.base_path },
  });
  if (payload.workspace.root !== root) {
    throw new Error("per-run workspace root must equal the exact allocated root");
  }
  const scope = payload.policy_snapshot.filesystem_write_scope;
  if (scope.length !== 1 || scope[0] !== root) {
    throw new Error("per-run transport write scope must be exactly [workspace.root]");
  }
  // The current adapter renders a URI as text; it cannot verify URI-only content.
  const context = payload.context_pack.payload;
  if (!context) throw new Error("per-run allocation requires an inline ContextPack");
  if (context.task.id !== payload.task_id || context.workspace.root !== root) {
    throw new Error("per-run ContextPack task and workspace root must match the command");
  }
  // Schema parsing fixes known object-field order; strings/arrays retain their
  // exact spelling/order. Include all accepted launch fields, not envelope IDs.
  // Keep relative ContextPack policy paths as supplied; transport scope is separate.
  const key = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  freezeSnapshot(payload);
  return Object.freeze({ key, payload });
}

/** Both mode introduction and removal change a remembered launch binding. */
export function assertMatchingAllocationReplay(
  accepted: AllocationReplayIdentity | undefined,
  incoming: AllocationReplayIdentity | undefined,
): void {
  if (accepted?.key !== incoming?.key) throw new Error("run.start allocation launch binding changed");
}
