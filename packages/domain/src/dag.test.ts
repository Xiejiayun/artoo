import { describe, expect, it } from "vitest";

import {
  type DagEdge,
  gatingNeedsEvidence,
  incomingEdges,
  isBlockedByUpstream,
  isGatingDependency,
  isTaskUnlocked,
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

  it("marks artifact/contract/review as needing (not-yet-wired) evidence", () => {
    expect(gatingNeedsEvidence("artifact_required")).toBe(true);
    expect(gatingNeedsEvidence("contract_required")).toBe(true);
    expect(gatingNeedsEvidence("review_required")).toBe(true);
    expect(gatingNeedsEvidence("blocks")).toBe(false);
    expect(gatingNeedsEvidence("soft_context")).toBe(false);
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
