/**
 * Memory contract (design.md §6 Memory) — v0.1-complete Phase A.
 *
 * Pure domain: lifecycle state machine, retrieval eligibility, and a
 * deterministic ContextPack selection helper. Storage tables, propose/accept/
 * reject/supersede APIs + idempotency, run-start ContextPack persistence, and
 * the memory web page are Phase B and intentionally NOT here.
 *
 * Keys are snake_case (record/wire shape). Known optional fields are declared
 * explicitly (not left to passthrough); `.passthrough()` only preserves unknown
 * forward-compat fields.
 */
import { z } from "zod";

import { CreatedByTypeSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const MemoryStatusSchema = z.enum(["proposed", "accepted", "rejected", "superseded"]);
export const MEMORY_STATUSES = MemoryStatusSchema.options;
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemoryScopeSchema = z.enum(["task", "project", "organization", "code"]);
export const MEMORY_SCOPES = MemoryScopeSchema.options;
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

export const MEMORY_TRIGGERS = ["accept", "reject", "supersede"] as const;
export type MemoryTrigger = (typeof MEMORY_TRIGGERS)[number];

export interface MemoryTransition {
  from: MemoryStatus;
  to: MemoryStatus;
  trigger: MemoryTrigger;
}

/**
 * Closed lifecycle. `accepted -> superseded` is the normal replacement path for
 * a live memory; `proposed -> superseded` covers a proposal replaced before
 * curation. `rejected` and `superseded` are terminal.
 */
export const MEMORY_TRANSITIONS: readonly MemoryTransition[] = [
  { from: "proposed", to: "accepted", trigger: "accept" },
  { from: "proposed", to: "rejected", trigger: "reject" },
  { from: "proposed", to: "superseded", trigger: "supersede" },
  { from: "accepted", to: "superseded", trigger: "supersede" },
];

const MEMORY_TERMINAL: readonly MemoryStatus[] = ["rejected", "superseded"];

export class MemoryTransitionError extends Error {
  constructor(
    public readonly from: MemoryStatus,
    public readonly trigger: MemoryTrigger,
  ) {
    super(`Invalid memory transition: '${trigger}' from '${from}'`);
    this.name = "MemoryTransitionError";
  }
}

export function isMemoryTerminal(status: MemoryStatus): boolean {
  return MEMORY_TERMINAL.includes(status);
}

export function canTransitionMemory(from: MemoryStatus, trigger: MemoryTrigger): boolean {
  return MEMORY_TRANSITIONS.some((t) => t.from === from && t.trigger === trigger);
}

export function applyMemoryTransition(from: MemoryStatus, trigger: MemoryTrigger): MemoryStatus {
  const transition = MEMORY_TRANSITIONS.find((t) => t.from === from && t.trigger === trigger);
  if (!transition) {
    throw new MemoryTransitionError(from, trigger);
  }
  return transition.to;
}

// ---------------------------------------------------------------------------
// Memory record
// ---------------------------------------------------------------------------

export const MemorySchema = z
  .object({
    id: z.string().min(1),
    status: MemoryStatusSchema,
    scope: MemoryScopeSchema,
    // Scope refs (optional; eligibility uses the ref relevant to `scope`).
    organization_id: z.string().nullish(),
    project_id: z.string().nullish(),
    task_id: z.string().nullish(),
    // Provenance refs.
    source_task_id: z.string().nullish(),
    source_run_id: z.string().nullish(),
    source_message_id: z.string().nullish(),
    source_artifact_id: z.string().nullish(),
    // Authorship.
    author_type: CreatedByTypeSchema,
    author_id: z.string().min(1),
    confidence: z.number().min(0).max(1).default(1),
    // Injectable content: at least one of text / payload (see refine).
    text: z.string().nullish(),
    payload: z.record(z.unknown()).nullish(),
    tags: z.array(z.string()).default([]),
    // Supersession links.
    supersedes_id: z.string().nullish(),
    superseded_by_id: z.string().nullish(),
    created_at: z.string(),
    updated_at: z.string().nullish(),
  })
  .passthrough()
  .superRefine((memory, ctx) => {
    const hasText =
      memory.text !== undefined && memory.text !== null && memory.text.trim().length > 0;
    const hasPayload =
      memory.payload !== undefined &&
      memory.payload !== null &&
      Object.keys(memory.payload).length > 0;
    if (!hasText && !hasPayload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "memory requires text or payload",
      });
    }
  });
export type Memory = z.infer<typeof MemorySchema>;

// ---------------------------------------------------------------------------
// Retrieval eligibility
// ---------------------------------------------------------------------------

/** The injection context: which org/project/task a ContextPack is being built for. */
export interface MemoryContext {
  organization_id?: string | null;
  project_id?: string | null;
  task_id?: string | null;
}

/** Only `accepted` memories are retrievable — proposed/rejected/superseded are not. */
export function isMemoryRetrievable(memory: Pick<Memory, "status">): boolean {
  return memory.status === "accepted";
}

/**
 * Whether an accepted memory is eligible for the given context. Scope decides
 * which ref must match:
 *  - task         -> memory.task_id === context.task_id
 *  - project      -> memory.project_id === context.project_id
 *  - organization -> memory.organization_id === context.organization_id
 *  - code         -> project/repo-bound: memory.project_id === context.project_id
 * A missing ref on the memory means it is not eligible for a specific context
 * (code is never promoted to organization-global).
 */
export function isMemoryEligible(memory: Memory, context: MemoryContext): boolean {
  if (!isMemoryRetrievable(memory)) return false;
  switch (memory.scope) {
    case "task":
      return memory.task_id != null && memory.task_id === context.task_id;
    case "project":
      return memory.project_id != null && memory.project_id === context.project_id;
    case "organization":
      return memory.organization_id != null && memory.organization_id === context.organization_id;
    case "code":
      return memory.project_id != null && memory.project_id === context.project_id;
    default:
      return false;
  }
}

/** Accepted + eligible candidates for the context (order not guaranteed). */
export function filterRetrievableMemories(
  candidates: readonly Memory[],
  context: MemoryContext,
): Memory[] {
  return candidates.filter((memory) => isMemoryEligible(memory, context));
}

// ---------------------------------------------------------------------------
// ContextPack selection
// ---------------------------------------------------------------------------

export interface MemorySelection {
  /** Injectable memories in deterministic priority order. */
  memories: Memory[];
  /** ids of the selected memories — the audit trail (context_packs.source_memory_ids). */
  source_memory_ids: string[];
}

export interface SelectInjectableOptions {
  /** Bounded injection: keep at most this many (after ordering). */
  limit?: number;
}

const SCOPE_PRIORITY: Record<MemoryScope, number> = {
  task: 0,
  project: 1,
  organization: 2,
  code: 3,
};

/** updated_at when present, else created_at — for recency within a scope. */
function injectionTime(memory: Memory): string {
  return memory.updated_at ?? memory.created_at;
}

/**
 * Select accepted, eligible memories for a ContextPack. Excludes proposed/
 * rejected/superseded by default. Order is deterministic and relevance-first:
 * scope priority (task > project > organization > code), then recency
 * (updated_at, else created_at, newer first), then `id` ascending. Recency
 * never overrides scope relevance. With `limit`, keeps the top N.
 */
export function selectInjectableMemories(
  candidates: readonly Memory[],
  context: MemoryContext,
  options: SelectInjectableOptions = {},
): MemorySelection {
  const eligible = filterRetrievableMemories(candidates, context);
  const ordered = [...eligible].sort((a, b) => {
    const byScope = SCOPE_PRIORITY[a.scope] - SCOPE_PRIORITY[b.scope];
    if (byScope !== 0) return byScope;
    const timeA = injectionTime(a);
    const timeB = injectionTime(b);
    if (timeA !== timeB) return timeA < timeB ? 1 : -1; // newer first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable tie-break
  });
  const selected =
    options.limit !== undefined ? ordered.slice(0, Math.max(0, options.limit)) : ordered;
  return {
    memories: selected,
    source_memory_ids: selected.map((memory) => memory.id),
  };
}
