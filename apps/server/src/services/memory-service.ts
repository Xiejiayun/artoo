import { appendEvent, memories } from "@artoo/db";
import {
  applyMemoryTransition,
  canTransitionMemory,
  ID_PREFIXES,
  selectInjectableMemories,
  type Memory,
  type MemoryContext,
  type MemorySelection,
  type MemoryStatus,
  type MemoryTrigger,
  type MemoryTransitionRequest,
  type ProposeMemoryRequest,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapMemory } from "../mappers.js";

async function loadMemory(tx: DrizzleDb, id: string): Promise<Memory> {
  const row = (await tx.select().from(memories).where(eq(memories.id, id)))[0];
  if (row === undefined) {
    throw new Error(`memory missing after write: ${id}`);
  }
  return mapMemory(row);
}

/**
 * POST /memories — propose a memory. Created in `proposed` status; a curator
 * later accepts/rejects/supersedes it. Content validity (non-blank text or
 * non-empty payload) is enforced at the route via ProposeMemoryRequestSchema.
 */
export async function proposeMemory(ctx: ServerContext, req: ProposeMemoryRequest): Promise<Memory> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const id = ctx.idGen.generate(ID_PREFIXES.memory);
    await tx.insert(memories).values({
      id,
      organizationId: ctx.organizationId,
      projectId: req.project_id ?? null,
      taskId: req.task_id ?? null,
      status: "proposed",
      scope: req.scope,
      sourceTaskId: req.source_task_id ?? null,
      sourceRunId: req.source_run_id ?? null,
      sourceMessageId: req.source_message_id ?? null,
      sourceArtifactId: req.source_artifact_id ?? null,
      authorType: "user",
      authorId: ctx.actorUserId,
      confidence: String(req.confidence),
      text: req.text ?? null,
      payload: req.payload ?? null,
      tags: req.tags,
      supersedesId: null,
      supersededById: null,
      createdAt: now,
      updatedAt: now,
    });
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "memory.proposed",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: id,
        projectId: req.project_id ?? null,
        taskId: req.task_id ?? null,
        payload: { memory_id: id, scope: req.scope, status: "proposed" },
      }),
    );
    return loadMemory(tx, id);
  });
}

export interface ListMemoriesFilters {
  scope?: string;
  status?: string;
  projectId?: string;
  taskId?: string;
  tag?: string;
}

/** GET /memories — list this org's memories, optionally filtered. */
export async function listMemories(
  ctx: ServerContext,
  filters: ListMemoriesFilters,
): Promise<Memory[]> {
  const conditions = [eq(memories.organizationId, ctx.organizationId)];
  if (filters.scope) conditions.push(eq(memories.scope, filters.scope));
  if (filters.status) conditions.push(eq(memories.status, filters.status));
  if (filters.projectId) conditions.push(eq(memories.projectId, filters.projectId));
  if (filters.taskId) conditions.push(eq(memories.taskId, filters.taskId));
  const rows = await ctx.db.db.select().from(memories).where(and(...conditions));
  const mapped = rows.map(mapMemory);
  const tag = filters.tag;
  return tag !== undefined && tag !== "" ? mapped.filter((m) => m.tags.includes(tag)) : mapped;
}

/** GET /memories/:id. */
export async function getMemory(ctx: ServerContext, id: string): Promise<Memory> {
  const row = (
    await ctx.db.db
      .select()
      .from(memories)
      .where(and(eq(memories.id, id), eq(memories.organizationId, ctx.organizationId)))
  )[0];
  if (row === undefined) {
    throw AppError.notFound(`memory not found: ${id}`, { memory_id: id });
  }
  return mapMemory(row);
}

/**
 * POST /memories/:id/accept|reject — route a lifecycle trigger through the
 * Phase A state machine. Illegal transitions (e.g. accepting a terminal memory)
 * are 409 invalid_state. Supersede is a distinct operation (see supersedeMemory).
 */
export async function transitionMemory(
  ctx: ServerContext,
  id: string,
  trigger: MemoryTrigger,
  req: MemoryTransitionRequest,
): Promise<Memory> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(memories)
        .where(and(eq(memories.id, id), eq(memories.organizationId, ctx.organizationId)))
    )[0];
    if (row === undefined) {
      throw AppError.notFound(`memory not found: ${id}`, { memory_id: id });
    }
    const from = row.status as MemoryStatus;
    if (!canTransitionMemory(from, trigger)) {
      throw AppError.invalidState(`cannot '${trigger}' a memory in status '${from}'`, {
        status: from,
        trigger,
      });
    }
    const to = applyMemoryTransition(from, trigger);
    await tx.update(memories).set({ status: to, updatedAt: now }).where(eq(memories.id, id));
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: `memory.${to}`,
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: id,
        projectId: row.projectId,
        taskId: row.taskId,
        payload: { memory_id: id, from_status: from, to_status: to, comment: req.comment ?? null },
      }),
    );
    return loadMemory(tx, id);
  });
}

/**
 * POST /memories/:id/supersede — replace a live (accepted) memory. Atomically:
 * create the replacement as `accepted`, link `new.supersedes_id = old.id`,
 * transition the old accepted memory to `superseded` and link
 * `old.superseded_by_id = new.id`. The old memory becomes non-retrievable.
 * Only an accepted memory can be superseded (else 409). Replacement content
 * validity is enforced at the route, so an invalid body never opens this txn.
 */
export async function supersedeMemory(
  ctx: ServerContext,
  oldId: string,
  req: ProposeMemoryRequest,
): Promise<{ memory: Memory; superseded: Memory }> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const oldRow = (
      await tx
        .select()
        .from(memories)
        .where(and(eq(memories.id, oldId), eq(memories.organizationId, ctx.organizationId)))
    )[0];
    if (oldRow === undefined) {
      throw AppError.notFound(`memory not found: ${oldId}`, { memory_id: oldId });
    }
    if (oldRow.status !== "accepted") {
      throw AppError.invalidState(
        `can only supersede an accepted memory (status '${oldRow.status}')`,
        { status: oldRow.status },
      );
    }

    const newId = ctx.idGen.generate(ID_PREFIXES.memory);
    await tx.insert(memories).values({
      id: newId,
      organizationId: ctx.organizationId,
      projectId: req.project_id ?? null,
      taskId: req.task_id ?? null,
      status: "accepted",
      scope: req.scope,
      sourceTaskId: req.source_task_id ?? null,
      sourceRunId: req.source_run_id ?? null,
      sourceMessageId: req.source_message_id ?? null,
      sourceArtifactId: req.source_artifact_id ?? null,
      authorType: "user",
      authorId: ctx.actorUserId,
      confidence: String(req.confidence),
      text: req.text ?? null,
      payload: req.payload ?? null,
      tags: req.tags,
      supersedesId: oldId,
      supersededById: null,
      createdAt: now,
      updatedAt: now,
    });

    const to = applyMemoryTransition("accepted", "supersede");
    await tx
      .update(memories)
      .set({ status: to, supersededById: newId, updatedAt: now })
      .where(eq(memories.id, oldId));

    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "memory.superseded",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: oldId,
        projectId: oldRow.projectId,
        taskId: oldRow.taskId,
        payload: {
          memory_id: oldId,
          superseded_by_id: newId,
          from_status: "accepted",
          to_status: to,
        },
      }),
    );
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "memory.accepted",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: newId,
        projectId: req.project_id ?? null,
        taskId: req.task_id ?? null,
        payload: { memory_id: newId, supersedes_id: oldId, status: "accepted" },
      }),
    );

    return { memory: await loadMemory(tx, newId), superseded: await loadMemory(tx, oldId) };
  });
}

export interface ContextSelectionInput {
  projectId?: string;
  taskId?: string;
}

/**
 * GET /memories/context — accepted-only retrieval for a run context. Loads the
 * org's accepted memories and runs the pure Phase A selector, so ordering and
 * `source_memory_ids` match `selectInjectableMemories` exactly. Org-scoped
 * memories (no project_id) are intentionally included in the candidate set.
 */
export async function selectForContext(
  ctx: ServerContext,
  input: ContextSelectionInput,
  limit?: number,
): Promise<MemorySelection> {
  const rows = await ctx.db.db
    .select()
    .from(memories)
    .where(and(eq(memories.organizationId, ctx.organizationId), eq(memories.status, "accepted")));
  const candidates = rows.map(mapMemory);
  const memoryContext: MemoryContext = {
    organization_id: ctx.organizationId,
    project_id: input.projectId ?? null,
    task_id: input.taskId ?? null,
  };
  return selectInjectableMemories(
    candidates,
    memoryContext,
    limit !== undefined ? { limit } : {},
  );
}
