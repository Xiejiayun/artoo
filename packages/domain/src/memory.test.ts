import { describe, expect, it } from "vitest";

import {
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MemorySchema,
  MemoryTransitionError,
  applyMemoryTransition,
  canTransitionMemory,
  filterRetrievableMemories,
  isMemoryEligible,
  isMemoryRetrievable,
  isMemoryTerminal,
  selectInjectableMemories,
  type Memory,
  type MemoryContext,
} from "./memory.js";

// Deterministic fixture factory (no Date.now — timestamps are explicit).
function mem(overrides: Partial<Memory> & Pick<Memory, "id">): Memory {
  return MemorySchema.parse({
    status: "accepted",
    scope: "project",
    organization_id: "org_1",
    project_id: "proj_1",
    task_id: "task_1",
    author_type: "agent",
    author_id: "agent_claude",
    text: "a memory",
    created_at: "2026-06-15T10:00:00.000Z",
    updated_at: "2026-06-15T10:00:00.000Z",
    ...overrides,
  });
}

const context: MemoryContext = {
  organization_id: "org_1",
  project_id: "proj_1",
  task_id: "task_1",
};

describe("memory lifecycle", () => {
  it("allows the closed proposed transitions", () => {
    expect(canTransitionMemory("proposed", "accept")).toBe(true);
    expect(canTransitionMemory("proposed", "reject")).toBe(true);
    expect(canTransitionMemory("proposed", "supersede")).toBe(true);
  });

  it("allows superseding an accepted memory", () => {
    expect(canTransitionMemory("accepted", "supersede")).toBe(true);
    expect(applyMemoryTransition("accepted", "supersede")).toBe("superseded");
  });

  it("rejects illegal transitions", () => {
    expect(canTransitionMemory("accepted", "accept")).toBe(false);
    expect(canTransitionMemory("rejected", "accept")).toBe(false);
    expect(canTransitionMemory("superseded", "supersede")).toBe(false);
    expect(() => applyMemoryTransition("rejected", "accept")).toThrow(MemoryTransitionError);
  });

  it("marks rejected and superseded as terminal", () => {
    expect(isMemoryTerminal("rejected")).toBe(true);
    expect(isMemoryTerminal("superseded")).toBe(true);
    expect(isMemoryTerminal("proposed")).toBe(false);
    expect(isMemoryTerminal("accepted")).toBe(false);
  });
});

describe("memory schema", () => {
  it("parses a text memory with defaults", () => {
    const m = mem({ id: "m1" });
    expect(m.confidence).toBe(1);
    expect(m.tags).toEqual([]);
  });

  it("parses a structured payload memory without text", () => {
    const result = MemorySchema.safeParse({
      id: "m2",
      status: "proposed",
      scope: "code",
      project_id: "proj_1",
      author_type: "system",
      author_id: "indexer",
      payload: { symbol: "ApiClient", file: "client.ts" },
      created_at: "2026-06-15T10:00:00.000Z",
      updated_at: "2026-06-15T10:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a memory with neither text nor payload", () => {
    const result = MemorySchema.safeParse({
      id: "m3",
      status: "proposed",
      scope: "task",
      task_id: "task_1",
      author_type: "agent",
      author_id: "agent_claude",
      created_at: "2026-06-15T10:00:00.000Z",
      updated_at: "2026-06-15T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("does not treat blank text as injectable content", () => {
    const result = MemorySchema.safeParse({
      id: "m_blank",
      status: "proposed",
      scope: "project",
      project_id: "proj_1",
      author_type: "agent",
      author_id: "agent_claude",
      text: "   ",
      created_at: "2026-06-15T10:00:00.000Z",
      updated_at: "2026-06-15T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("does not treat an empty payload as injectable content", () => {
    const result = MemorySchema.safeParse({
      id: "m_empty_payload",
      status: "proposed",
      scope: "project",
      project_id: "proj_1",
      author_type: "agent",
      author_id: "agent_claude",
      payload: {},
      created_at: "2026-06-15T10:00:00.000Z",
      updated_at: "2026-06-15T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("exposes the status and scope vocabularies", () => {
    expect(MEMORY_STATUSES).toEqual(["proposed", "accepted", "rejected", "superseded"]);
    expect(MEMORY_SCOPES).toEqual(["task", "project", "organization", "code"]);
  });
});

describe("retrieval eligibility", () => {
  it("only accepted memories are retrievable", () => {
    expect(isMemoryRetrievable(mem({ id: "a", status: "accepted" }))).toBe(true);
    expect(isMemoryRetrievable(mem({ id: "p", status: "proposed" }))).toBe(false);
    expect(isMemoryRetrievable(mem({ id: "r", status: "rejected" }))).toBe(false);
    expect(isMemoryRetrievable(mem({ id: "s", status: "superseded" }))).toBe(false);
  });

  it("matches scope refs against the context", () => {
    expect(isMemoryEligible(mem({ id: "t", scope: "task", task_id: "task_1" }), context)).toBe(true);
    expect(isMemoryEligible(mem({ id: "t2", scope: "task", task_id: "other" }), context)).toBe(false);
    expect(isMemoryEligible(mem({ id: "pr", scope: "project", project_id: "proj_1" }), context)).toBe(
      true,
    );
    expect(
      isMemoryEligible(mem({ id: "o", scope: "organization", organization_id: "org_1" }), context),
    ).toBe(true);
    expect(isMemoryEligible(mem({ id: "c", scope: "code", project_id: "proj_1" }), context)).toBe(true);
    expect(isMemoryEligible(mem({ id: "c2", scope: "code", project_id: "other" }), context)).toBe(false);
    expect(isMemoryEligible(mem({ id: "c3", scope: "code", project_id: null }), context)).toBe(false);
  });

  it("excludes non-accepted memories from eligibility", () => {
    expect(
      isMemoryEligible(mem({ id: "px", status: "proposed", scope: "task", task_id: "task_1" }), context),
    ).toBe(false);
  });

  it("filterRetrievableMemories drops non-accepted and non-matching", () => {
    const filtered = filterRetrievableMemories(
      [
        mem({ id: "keep", scope: "task", task_id: "task_1" }),
        mem({ id: "rej", status: "rejected", scope: "task", task_id: "task_1" }),
        mem({ id: "wrong", scope: "task", task_id: "task_2" }),
      ],
      context,
    );
    expect(filtered.map((m) => m.id)).toEqual(["keep"]);
  });
});

describe("selectInjectableMemories", () => {
  const memories = [
    mem({ id: "m_task_old", scope: "task", task_id: "task_1", updated_at: "2026-06-15T09:00:00.000Z" }),
    mem({ id: "m_task_new", scope: "task", task_id: "task_1", updated_at: "2026-06-15T11:00:00.000Z" }),
    mem({ id: "m_proj", scope: "project", project_id: "proj_1", updated_at: "2026-06-15T12:00:00.000Z" }),
    mem({ id: "m_org", scope: "organization", organization_id: "org_1", updated_at: "2026-06-15T08:00:00.000Z" }),
    mem({ id: "m_code", scope: "code", project_id: "proj_1", updated_at: "2026-06-15T13:00:00.000Z" }),
    mem({ id: "m_rejected", status: "rejected", scope: "task", task_id: "task_1" }),
    mem({ id: "m_other", scope: "task", task_id: "task_2" }),
  ];

  it("returns accepted, eligible memories ordered by scope then recency", () => {
    const result = selectInjectableMemories(memories, context);
    expect(result.memories.map((m) => m.id)).toEqual([
      "m_task_new",
      "m_task_old",
      "m_proj",
      "m_org",
      "m_code",
    ]);
    expect(result.source_memory_ids).toEqual(["m_task_new", "m_task_old", "m_proj", "m_org", "m_code"]);
  });

  it("scope priority outranks recency (newest code memory still last)", () => {
    const result = selectInjectableMemories(memories, context);
    // m_code is the most recently updated but ranks last by scope priority.
    expect(result.memories.at(-1)?.id).toBe("m_code");
  });

  it("excludes proposed/rejected/superseded by default", () => {
    const ids = selectInjectableMemories(memories, context).memories.map((m) => m.id);
    expect(ids).not.toContain("m_rejected");
    expect(ids).not.toContain("m_other");
  });

  it("respects the bounded injection limit", () => {
    const result = selectInjectableMemories(memories, context, { limit: 2 });
    expect(result.memories.map((m) => m.id)).toEqual(["m_task_new", "m_task_old"]);
    expect(result.source_memory_ids).toEqual(["m_task_new", "m_task_old"]);
  });

  it("is deterministic across calls", () => {
    const a = selectInjectableMemories(memories, context);
    const b = selectInjectableMemories(memories, context);
    expect(a.source_memory_ids).toEqual(b.source_memory_ids);
  });
});
