import { describe, expect, it } from "vitest";

import {
  type DagEdge,
  gatingNeedsEvidence,
  hasRequiredEvidence,
  incomingEdges,
  isBlockedByUpstream,
  isGatingDependency,
  isTaskUnlocked,
  requiredEvidenceKind,
  unlockedTaskIds,
  wouldCreateCycle,
} from "./dag.js";
import type { DependencyType } from "./schemas.js";
import type { TaskStatus } from "./state.js";

const edge = (from: string, to: string, type: DependencyType = "blocks"): DagEdge => ({
  from_task_id: from,
  to_task_id: to,
  type,
});

describe("dependency gating", () => {
  it("soft_context never gates; all others gate", () => {
    expect(isGatingDependency("soft_context")).toBe(false);
    for (const t of ["blocks", "artifact_required", "contract_required", "review_required"] as const) {
      expect(isGatingDependency(t)).toBe(true);
    }
  });

  it("artifact/contract need evidence; review_required is satisfied by done", () => {
    expect(gatingNeedsEvidence("artifact_required")).toBe(true);
    expect(gatingNeedsEvidence("contract_required")).toBe(true);
    // review_required == done (done is already gated by review-accept).
    expect(gatingNeedsEvidence("review_required")).toBe(false);
    expect(gatingNeedsEvidence("blocks")).toBe(false);
    expect(gatingNeedsEvidence("soft_context")).toBe(false);
  });

  it("maps each type to its required evidence kind", () => {
    expect(requiredEvidenceKind("artifact_required")).toBe("artifact");
    expect(requiredEvidenceKind("contract_required")).toBe("contract");
    expect(requiredEvidenceKind("review_required")).toBeNull();
    expect(requiredEvidenceKind("blocks")).toBeNull();
    expect(requiredEvidenceKind("soft_context")).toBeNull();
  });
});

describe("hasRequiredEvidence", () => {
  it("requires an artifact for artifact_required edges", () => {
    const incoming = [edge("p", "d", "artifact_required")];
    expect(hasRequiredEvidence(incoming, {})).toBe(false);
    expect(hasRequiredEvidence(incoming, { p: new Set(["artifact"]) })).toBe(true);
  });

  it("requires a contract artifact for contract_required edges", () => {
    const incoming = [edge("p", "d", "contract_required")];
    // a plain artifact is not enough for contract_required
    expect(hasRequiredEvidence(incoming, { p: new Set(["artifact"]) })).toBe(false);
    expect(hasRequiredEvidence(incoming, { p: new Set(["artifact", "contract"]) })).toBe(true);
  });

  it("ignores edges that need no evidence (blocks / review_required / soft_context)", () => {
    const incoming = [
      edge("a", "d", "blocks"),
      edge("b", "d", "review_required"),
      edge("c", "d", "soft_context"),
    ];
    expect(hasRequiredEvidence(incoming, {})).toBe(true);
  });

  it("requires evidence from every evidence-bearing edge", () => {
    const incoming = [edge("p1", "d", "artifact_required"), edge("p2", "d", "contract_required")];
    expect(hasRequiredEvidence(incoming, { p1: new Set(["artifact"]) })).toBe(false);
    expect(
      hasRequiredEvidence(incoming, {
        p1: new Set(["artifact"]),
        p2: new Set(["contract"]),
      }),
    ).toBe(true);
  });
});

describe("isTaskUnlocked (from = prerequisite, to = dependent)", () => {
  it("unlocks the DEPENDENT only when every gating PREREQUISITE is done", () => {
    // prereq P -> dependent D
    const edges = [edge("P1", "D"), edge("P2", "D")];
    const incoming = incomingEdges(edges, "D");
    expect(isTaskUnlocked(incoming, { P1: "done", P2: "done" })).toBe(true);
    expect(isTaskUnlocked(incoming, { P1: "done", P2: "running" as TaskStatus })).toBe(false);
    expect(isTaskUnlocked(incoming, {})).toBe(false);
  });

  it("ignores soft_context prerequisites for unlocking", () => {
    const incoming = incomingEdges([edge("P1", "D", "blocks"), edge("P2", "D", "soft_context")], "D");
    // P2 is soft → only P1 must be done
    expect(isTaskUnlocked(incoming, { P1: "done", P2: "backlog" })).toBe(true);
  });

  it("a task with no incoming edges is trivially unlocked", () => {
    expect(isTaskUnlocked(incomingEdges([edge("P1", "D")], "OTHER"), {})).toBe(true);
  });
});

describe("isBlockedByUpstream", () => {
  it("propagates when a gating prerequisite is blocked or cancelled", () => {
    const incoming = incomingEdges([edge("P1", "D")], "D");
    expect(isBlockedByUpstream(incoming, { P1: "blocked" })).toBe(true);
    expect(isBlockedByUpstream(incoming, { P1: "cancelled" })).toBe(true);
    expect(isBlockedByUpstream(incoming, { P1: "running" as TaskStatus })).toBe(false);
  });

  it("never propagates through soft_context edges", () => {
    const incoming = incomingEdges([edge("P1", "D", "soft_context")], "D");
    expect(isBlockedByUpstream(incoming, { P1: "blocked" })).toBe(false);
  });
});

describe("wouldCreateCycle (multi-edge and cross-child)", () => {
  it("rejects self-dependency", () => {
    expect(wouldCreateCycle([], "A", "A")).toBe(true);
  });

  it("rejects a direct back-edge A->B then B->A", () => {
    expect(wouldCreateCycle([edge("A", "B")], "B", "A")).toBe(true);
  });

  it("rejects a multi-edge cycle A->B->C then C->A", () => {
    expect(wouldCreateCycle([edge("A", "B"), edge("B", "C")], "C", "A")).toBe(true);
  });

  it("allows a cross-child fan-out without a cycle (A->B, A->C, then B->C)", () => {
    expect(wouldCreateCycle([edge("A", "B"), edge("A", "C")], "B", "C")).toBe(false);
  });

  it("allows an unrelated edge", () => {
    expect(wouldCreateCycle([edge("A", "B")], "C", "D")).toBe(false);
  });
});

describe("unlockedTaskIds", () => {
  it("returns dependents whose prerequisites are all done", () => {
    const edges = [edge("P", "D1"), edge("P", "D2"), edge("X", "D2")];
    const ready = unlockedTaskIds(["D1", "D2"], edges, { P: "done", X: "running" as TaskStatus });
    expect(ready).toEqual(["D1"]); // D2 still waits on X
  });
});
