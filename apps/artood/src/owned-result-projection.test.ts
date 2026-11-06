import { describe, expect, it, vi } from "vitest";
import type { AgentInstanceHandle } from "@artoo/protocol";
import { authenticateProjectedOwnedResultVerification, describeOwnedResultProfile, projectOwnedResultVerification,
  type PreparedOwnedWorktreeVerificationTemplate, type ProjectOwnedResultVerificationInput } from "./owned-worktree-verification.js";
import { describeOwnedResultStore, readOwnedResultProjectionFacts, type OwnedResultProjectionStoreBinding } from "./owned/worktree-results.js";
import { createOwnedRunAdmission, getOwnedWorkspaceLaunchProof } from "./process-adapter.js";
import type { MaterializedWorktree } from "./owned/worktree-reservation.js";

const fakeTemplate: PreparedOwnedWorktreeVerificationTemplate = Object.freeze({ version: 1, id: "local_verifier",
  digest: `sha256:${"a".repeat(64)}` });

describe("owned result projection authority boundaries (no process or filesystem execution)", () => {
  it("rejects structurally valid template metadata before accessing untrusted inputs", async () => {
    const readInput = vi.fn(() => { throw new Error("must not inspect untrusted input"); });
    const input = Object.defineProperty({}, "run_start", { get: readInput }) as ProjectOwnedResultVerificationInput;
    await expect(describeOwnedResultProfile({}, fakeTemplate)).rejects.toThrow("genuine locally prepared template");
    await expect(projectOwnedResultVerification(fakeTemplate, input)).rejects.toThrow("genuine locally prepared template");
    expect(readInput).not.toHaveBeenCalled();
  });

  it("a copied store or replacement public read method cannot supply projection facts", () => {
    const called = vi.fn(() => { throw new Error("must not invoke public method"); });
    const store = { read: called, readVerification: called, lookupVerification: called };
    const accessor = Object.defineProperty({}, "readVerification", { get: called });
    for (const candidate of [store, { ...store }, accessor, {}, null]) {
      expect(() => describeOwnedResultStore(candidate, {} as OwnedResultProjectionStoreBinding))
        .toThrow("original locally opened result store");
      expect(() => readOwnedResultProjectionFacts(candidate, {} as OwnedResultProjectionStoreBinding, {}))
        .toThrow("original locally opened result store");
    }
    expect(called).not.toHaveBeenCalled();
  });

  it("an admission and copied physical facts cannot manufacture actual start provenance", () => {
    const admission = createOwnedRunAdmission({ launchKey: "invented", runId: "run_1", taskId: "task_1",
      agentInstanceId: "agent_1", runtime: "fixture", workspaceRoot: "/workspace/run_1", workspaceBranch: "fixture/run-1" });
    const closure = { kind: "confirmed_closed", facts: { childSpawned: true, childExitObserved: true,
      childStdioClosed: true, groupAbsent: true } };
    expect(getOwnedWorkspaceLaunchProof(closure, admission, {} as AgentInstanceHandle, {} as MaterializedWorktree)).toBeUndefined();
  });

  it("neither freezing nor serializing evidence can issue the original local projection authority", () => {
    const metadata = { version: 1, kind: "authored-result-verification", requirement_digest: `sha256:${"b".repeat(64)}` };
    for (const value of [metadata, Object.freeze({ ...metadata }), JSON.parse(JSON.stringify(metadata)), null, undefined]) {
      expect(() => authenticateProjectedOwnedResultVerification(value)).toThrow("original locally projected result verification");
    }
  });
});
