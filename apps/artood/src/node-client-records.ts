import { createHash } from "node:crypto";
import { RunStartPayloadSchema, type OwnedResultRunAdmissionV1, type RunStartPayload } from "@artoo/domain";
import type { AgentInstanceHandle, NodeErrorCode, RuntimeAdapter } from "@artoo/protocol";
import type { FreshLaunchPermit, JournalRun, TerminalSettlement } from "./managed/journal-types.js";
import type { ManagedDelivery, ManagedSession } from "./managed/managed-delivery.js";
import type { AllocationReplayIdentity } from "./node-allocation-identity.js";
import { OwnedGitError } from "./owned/owned-git.js";
import { readWindowsNativeFailure } from "./owned/windows-process-diagnostic.js";
import type { MaterializedWorktree } from "./owned/worktree-reservation.js";
import type { OwnedResultFinalizationV1, PreparedOwnedResultRun, selectOwnedResultProfile } from "./owned-worktree-verification.js";
import type { OwnedRunAdmission, OwnedRunRuntimeAdapter } from "./process-adapter.js";

export type PhysicalStartupOutcome = Readonly<
  | { kind: "started" }
  | { kind: "rejected" | "cancelled" | "uncertain"; code: NodeErrorCode; message: string }
>;

export interface PhysicalExecution {
  readonly adapter: OwnedRunRuntimeAdapter;
  readonly handle: AgentInstanceHandle;
  readonly admission: OwnedRunAdmission;
  readonly stopOwnedRun: OwnedRunRuntimeAdapter["stopOwnedRun"];
  readonly inspectOwnedRun: OwnedRunRuntimeAdapter["inspectOwnedRun"];
  readonly streamEvents: RuntimeAdapter["streamEvents"];
  /** The real stream/receipt task is still owned, even after its writer closes. */
  deliveryPending: boolean;
  stopPending?: Promise<void>;
}

export interface PhysicalStartRecord {
  readonly identity: AllocationReplayIdentity;
  /** Retained after compaction so a legacy duplicate cannot downgrade this mode. */
  readonly ownedResultDigest?: string;
  ownedResult?: {
    request: OwnedResultRunAdmissionV1;
    selection: ReturnType<typeof selectOwnedResultProfile>;
    prepared?: PreparedOwnedResultRun;
    worktree?: MaterializedWorktree;
    finalizing?: Promise<OwnedResultFinalizationV1>;
    unsafe?: boolean;
  };
  readonly ready: Promise<PhysicalStartupOutcome>;
  resolveReady?: (outcome: PhysicalStartupOutcome) => void;
  outcome?: PhysicalStartupOutcome;
  controller?: AbortController;
  startupSession?: ManagedSession;
  execution?: PhysicalExecution;
  /** Set only after authenticated closure of this exclusively claimed attempt. */
  confirmedClosed: boolean;
  closureReceipt?: unknown;
  userStopRequested?: boolean;
  managed?: {
    permit: FreshLaunchPermit;
    delivery: ManagedDelivery;
    settled: boolean;
    deliveryPending: boolean;
    run?: JournalRun;
    observedTerminal?: TerminalSettlement["terminal"];
    failure?: string;
  };
  readonly recovery: { runId: string; taskId: string; root: string; branch: string; phase: string };
}

/** A legacy journal admission is an identity fence, never physical authority. */
export interface MixedLegacyStartRecord {
  readonly key: string;
  readonly ready: Promise<PhysicalStartupOutcome>;
  resolveReady?: (outcome: PhysicalStartupOutcome) => void;
  outcome?: PhysicalStartupOutcome;
  controller?: AbortController;
  startupSession?: ManagedSession;
  admitted: boolean;
  adapterInvoked: boolean;
  stopPending?: Promise<void>;
  stopCompleted?: boolean;
  stopFailure?: string;
}

export interface RunDelivery {
  readonly commandId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly workspaceRoot: string;
}

export function errorMessage(err: unknown): string {
  const message = err instanceof Error && err.message.length > 0 ? err.message : "process start failed";
  const native = readWindowsNativeFailure(err);
  if (!native) return message;
  // The local tag already projects a bounded allowlist. Preserve its exact
  // code/detail pair, never the raw cause, and keep the suffix inside replay's bound.
  const suffix = `\n[windows_native_failure.v1 ${JSON.stringify({ version: 1, ...native })}]`;
  const available = 8192 - suffix.length, truncated = "\n[Startup diagnostic truncated]";
  return (message.length <= available ? message : message.slice(0, available - truncated.length) + truncated) + suffix;
}

/** Same canonical legacy payload identity as journal.admitStart, detached before I/O. */
export function snapshotMixedLegacyStart(input: RunStartPayload): { readonly key: string; readonly payload: RunStartPayload } {
  const payload = RunStartPayloadSchema.parse(input);
  const freeze = (value: object): void => {
    for (const child of Object.values(value)) if (child !== null && typeof child === "object") freeze(child);
    Object.freeze(value);
  };
  freeze(payload);
  return Object.freeze({ key: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), payload });
}

/** Recognize only the real shared runner's typed cleanup facts, never error text. */
export function confirmedOwnedGitCleanup(error: unknown): boolean {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  let receipts = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (item instanceof OwnedGitError) {
      receipts += 1;
      if (!item.receipt.cleanupConfirmed || !item.receipt.observersDisposed) return false;
    }
    const nested = item as { cause?: unknown; errors?: unknown[] };
    pending.push(nested.cause, ...(Array.isArray(nested.errors) ? nested.errors : []));
  }
  return receipts > 0;
}
