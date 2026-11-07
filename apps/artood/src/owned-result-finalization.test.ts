import { describe, expect, it, vi } from "vitest";
import type { AgentInstanceHandle } from "@artoo/protocol";
import { authenticateOwnedResultFinalization, finalizeOwnedResultRun, materializeOwnedResultRun, prepareOwnedResultRun,
  type OwnedResultRunAdmissionV1, type PreparedOwnedResultRun, type PreparedOwnedWorktreeVerificationTemplate } from "./owned-worktree-verification.js";
import { bindOwnedResultExecutionStore, type OwnedResultProjectionStoreBinding } from "./owned/worktree-results.js";
import { createOwnedRunAdmission, getOwnedWorkspaceAuthorOutcome } from "./process-adapter.js";
import type { MaterializedWorktree } from "./owned/worktree-reservation.js";

describe("owned result finalization boundaries (synthetic metadata, no process or Git)", () => {
  it("rejects a copied template before inspecting an untrusted request", async () => {
    const read = vi.fn(() => { throw new Error("must not read the untrusted request"); });
    const request = Object.defineProperty({}, "run_start", { get: read }) as OwnedResultRunAdmissionV1;
    const template: PreparedOwnedWorktreeVerificationTemplate = { version: 1, id: "local", digest: `sha256:${"a".repeat(64)}` };
    await expect(prepareOwnedResultRun({}, template, request)).rejects.toThrow("genuine locally prepared template");
    expect(read).not.toHaveBeenCalled();
  });

  it("cannot bind a store wrapper to execution through replaced public methods", () => {
    const replaced = vi.fn(() => { throw new Error("must not invoke public execution methods"); });
    const store = { capture: replaced, materialize: replaced, materializeForVerification: replaced, lookupVerification: replaced };
    expect(() => bindOwnedResultExecutionStore(store, {} as OwnedResultProjectionStoreBinding)).toThrow("original locally opened result store");
    expect(replaced).not.toHaveBeenCalled();
  });

  it("copied run metadata cannot materialize or finalize a writer", async () => {
    const fake = Object.freeze({ version: 1, admission_digest: `sha256:${"b".repeat(64)}` }) as PreparedOwnedResultRun;
    await expect(materializeOwnedResultRun(fake, new AbortController().signal)).rejects.toThrow("original prepared owned result run");
    await expect(finalizeOwnedResultRun(fake, {} as Parameters<typeof finalizeOwnedResultRun>[1]))
      .rejects.toThrow("original prepared owned result run");
  });

  it("a supplied terminal bundle and matching-looking digest cannot grant settlement authority", () => {
    const bundle = { version: 1, kind: "owned-result-finalization.v1", admission_digest: `sha256:${"c".repeat(64)}`,
      terminal: { type: "run.lifecycle", payload: { phase: "completed" } }, retentionOutcome: "completed" };
    for (const value of [bundle, Object.freeze({ ...bundle }), JSON.parse(JSON.stringify(bundle))]) {
      expect(() => authenticateOwnedResultFinalization(value, {} as OwnedResultRunAdmissionV1, { stopRequested: false }))
        .toThrow("original owned result finalization");
    }
  });

  it("physical-looking facts or caller terminal events do not prove author success", () => {
    const admission = createOwnedRunAdmission({ launchKey: "supplied", runId: "run_1", taskId: "task_1", agentInstanceId: "agent_1",
      runtime: "fixture", workspaceRoot: "/workspace/run_1", workspaceBranch: "fixture/run-1" });
    const fakeClosure = { kind: "confirmed_closed", terminalPhase: "completed", facts: { childSpawned: true,
      childExitObserved: true, childStdioClosed: true, groupAbsent: true } };
    expect(getOwnedWorkspaceAuthorOutcome(fakeClosure, admission, {} as AgentInstanceHandle, {} as MaterializedWorktree)).toBeUndefined();
  });
});
