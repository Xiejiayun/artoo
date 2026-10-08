import type { AgentInstanceConfig, AgentInstanceHandle, RuntimeAdapter, StopReason } from "@artoo/protocol";
import type { MaterializedWorktree } from "./owned/worktree-reservation.js";

declare const admissionBrand: unique symbol;
/** In-memory authority only; a serialized or copied object has no authority. */
export interface OwnedRunAdmission { readonly [admissionBrand]: true }

export interface OwnedAdmissionIdentity {
  readonly launchKey: string;
  readonly runId: string;
  readonly taskId: string;
  readonly agentInstanceId: string;
  readonly runtime: string;
  readonly workspaceRoot: string;
  readonly workspaceBranch: string;
}

/** Small immutable observations; never includes a ContextPack or live process object. */
export interface OwnedPhysicalFacts {
  readonly childPid: number | null;
  readonly childSpawned: boolean;
  readonly childExitObserved: boolean;
  readonly childStdioClosed: boolean;
  readonly groupAbsent: boolean;
  readonly guardianPid: number | null;
  readonly guardianAttempted: boolean;
  readonly guardianSpawned: boolean;
  readonly guardianExitObserved: boolean;
  readonly guardianStdioClosed: boolean;
  readonly guardianGroupAbsent: boolean;
}

export interface OwnedStartupReceipt {
  readonly kind: "not_spawned" | "confirmed_closed" | "uncertain";
  readonly cancellationRequested: boolean;
  readonly observedAt: string;
  readonly facts?: OwnedPhysicalFacts;
}
export interface OwnedStopReceipt {
  readonly kind: "confirmed_closed" | "uncertain";
  readonly observedAt: string;
  readonly facts?: OwnedPhysicalFacts;
}
export interface OwnedRunStatusReceipt {
  readonly kind: "running" | "confirmed_closed" | "uncertain";
  readonly observedAt: string;
  readonly facts?: OwnedPhysicalFacts;
}

export interface OwnedRunRuntimeAdapter extends RuntimeAdapter {
  startOwnedRun(config: AgentInstanceConfig, worktree: MaterializedWorktree,
    admission: OwnedRunAdmission, signal: AbortSignal): Promise<AgentInstanceHandle>;
  stopOwnedRun(handle: AgentInstanceHandle, admission: OwnedRunAdmission,
    reason: StopReason): Promise<OwnedStopReceipt>;
  /** Physical state only. Buffered delivery is tracked separately by NodeClient. */
  inspectOwnedRun(handle: AgentInstanceHandle, admission: OwnedRunAdmission): Promise<OwnedRunStatusReceipt>;
}
