/**
 * Task DAG semantics (design.md §6.9). PURE — no IO. The server (#11 Phase B)
 * computes auto-unlock / blocked-propagation with these; #12 concurrency
 * schedules only unlocked nodes.
 *
 * Edge direction is fixed everywhere: `from_task_id` is the PREREQUISITE and
 * `to_task_id` is the DEPENDENT (the dependent waits on the prerequisite).
 */
import type { DependencyType } from "./schemas.js";
import type { TaskStatus } from "./state.js";

export interface DagEdge {
  /** Prerequisite task (must be satisfied first). */
  from_task_id: string;
  /** Dependent task (waits on the prerequisite). */
  to_task_id: string;
  type: DependencyType;
}

/**
 * Whether a dependency type GATES readiness/blocking. `soft_context` never gates
 * — it only feeds ContextPack/memory later (#14); every other type requires the
 * prerequisite to be done.
 */
export function isGatingDependency(type: DependencyType): boolean {
  return type !== "soft_context";
}

/** Concrete evidence a gating edge demands BEYOND the prerequisite being done. */
export type EvidenceKind = "artifact" | "contract";

/**
 * The evidence a gating edge requires beyond `done`, or `null` when `done` alone
 * satisfies it (design.md §6.9):
 * - `artifact_required` → the prerequisite produced at least one artifact.
 * - `contract_required` → the prerequisite produced a `contract` artifact.
 * - `review_required` → `null`: `done` is already gated by review-accept, so the
 *   review IS the evidence; no extra check.
 * - `blocks` / `soft_context` → `null`.
 */
export function requiredEvidenceKind(type: DependencyType): EvidenceKind | null {
  if (type === "artifact_required") {
    return "artifact";
  }
  if (type === "contract_required") {
    return "contract";
  }
  return null;
}

/**
 * Whether a gating edge needs evidence beyond `done`. True only for
 * `artifact_required` / `contract_required`; `review_required` is satisfied by
 * `done` (review-accept is the evidence). Pairs with {@link requiredEvidenceKind}.
 */
export function gatingNeedsEvidence(type: DependencyType): boolean {
  return requiredEvidenceKind(type) !== null;
}

/**
 * Whether every evidence-bearing incoming gating edge has its evidence available.
 * `evidenceByPrereq[prereqId]` is the set of evidence kinds that prerequisite has
 * produced. Edges without an evidence requirement (blocks / review_required) and
 * soft edges pass here — combine with {@link isTaskUnlocked} for the full gate.
 */
export function hasRequiredEvidence(
  incoming: readonly DagEdge[],
  evidenceByPrereq: Readonly<Record<string, ReadonlySet<EvidenceKind> | undefined>>,
): boolean {
  return incoming
    .filter((edge) => isGatingDependency(edge.type))
    .every((edge) => {
      const need = requiredEvidenceKind(edge.type);
      if (need === null) {
        return true;
      }
      return evidenceByPrereq[edge.from_task_id]?.has(need) ?? false;
    });
}

/** Incoming edges of a dependent task (those whose `to_task_id === taskId`). */
export function incomingEdges(edges: readonly DagEdge[], taskId: string): DagEdge[] {
  return edges.filter((edge) => edge.to_task_id === taskId);
}

/**
 * A dependent task is UNLOCKED when every gating prerequisite is `done`. Soft
 * edges are ignored. (Phase A gates on prerequisite-done only — see
 * {@link gatingNeedsEvidence} for the artifact/contract/review TODO.)
 */
export function isTaskUnlocked(
  incoming: readonly DagEdge[],
  upstreamStatusById: Readonly<Record<string, TaskStatus | undefined>>,
): boolean {
  return incoming
    .filter((edge) => isGatingDependency(edge.type))
    .every((edge) => upstreamStatusById[edge.from_task_id] === "done");
}

/**
 * A dependent task is BLOCKED-BY-UPSTREAM when any gating prerequisite is
 * `blocked` or `cancelled` (propagate downstream). Soft edges never propagate.
 */
export function isBlockedByUpstream(
  incoming: readonly DagEdge[],
  upstreamStatusById: Readonly<Record<string, TaskStatus | undefined>>,
): boolean {
  return incoming
    .filter((edge) => isGatingDependency(edge.type))
    .some((edge) => {
      const status = upstreamStatusById[edge.from_task_id];
      return status === "blocked" || status === "cancelled";
    });
}

/**
 * Whether adding edge (from -> to) would create a cycle: true when `from === to`
 * (self-dependency) or `to` can already reach `from` through existing edges (so
 * the new edge would close a loop). Covers multi-edge and cross-child paths.
 */
export function wouldCreateCycle(
  edges: readonly DagEdge[],
  fromTaskId: string,
  toTaskId: string,
): boolean {
  if (fromTaskId === toTaskId) {
    return true;
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from_task_id) ?? [];
    list.push(edge.to_task_id);
    adjacency.set(edge.from_task_id, list);
  }
  const seen = new Set<string>();
  const stack: string[] = [toTaskId];
  while (stack.length > 0) {
    const node = stack.pop() as string;
    if (node === fromTaskId) {
      return true;
    }
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);
    for (const next of adjacency.get(node) ?? []) {
      stack.push(next);
    }
  }
  return false;
}

/** Task ids that are unlocked given current statuses (batch auto-unlock helper). */
export function unlockedTaskIds(
  nodeIds: readonly string[],
  edges: readonly DagEdge[],
  statusById: Readonly<Record<string, TaskStatus | undefined>>,
): string[] {
  return nodeIds.filter((id) => isTaskUnlocked(incomingEdges(edges, id), statusById));
}
