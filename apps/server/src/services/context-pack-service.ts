import { assistantTurns, contextPacks, discussions, memories, messages, projects, tasks } from "@artoo/db";
import {
  ContextPackSchema,
  ID_PREFIXES,
  normalizeLeasePath,
  selectInjectableMemories,
  type ContextPack,
  type Memory,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, isNull, lte, ne, or } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { mapMemory } from "../mappers.js";
import { AppError } from "../errors.js";

export interface BuildContextPackParams {
  runId: string;
  assistantTurnId?: string;
  task: typeof tasks.$inferSelect;
  /** The run's bound workspace root (#20), else falls back to project default. */
  workspaceRoot: string | null;
  /** The run's declared write paths (#20); drives policy file-scope when present. */
  writePaths?: readonly string[];
}

export interface BuiltContextPack {
  contextPackId: string;
  sourceMemoryIds: string[];
}

/** Render a memory's injectable content (text, else its structured payload). */
function renderMemory(memory: Memory): string {
  return memory.text ?? JSON.stringify(memory.payload ?? {});
}

function dedupeWriteScope(writePaths: readonly string[]): string[] {
  const scope: string[] = [];
  const seen = new Set<string>();
  for (const path of writePaths) {
    const normalized = normalizeLeasePath("", path);
    if (normalized.ok && !seen.has(normalized.path)) {
      seen.add(normalized.path);
      scope.push(path);
    }
  }
  return scope;
}

/**
 * Build and persist a run's ContextPack at run-start (#21 Part D). Accepted
 * memories for the task's context are selected with the same pure Phase A
 * selector used by `GET /memories/context`, so injection order/exclusion match
 * exactly. `context_packs.source_memory_ids` records the audit trail; the caller
 * links `runs.context_pack_id` to the returned id.
 *
 * Runs inside the assign transaction (atomic with run creation): if the run
 * rolls back, no orphan ContextPack is left behind.
 */
export async function buildRunContextPack(
  ctx: ServerContext,
  tx: DrizzleDb,
  params: BuildContextPackParams,
): Promise<BuiltContextPack> {
  const now = ctx.clock.nowIso();
  const { task } = params;

  const acceptedRows = await tx
    .select()
    .from(memories)
    .where(and(eq(memories.organizationId, ctx.organizationId), eq(memories.status, "accepted")));
  const selection = selectInjectableMemories(acceptedRows.map(mapMemory), {
    organization_id: ctx.organizationId,
    project_id: task.projectId,
    task_id: task.id,
  });

  const project = (await tx.select().from(projects).where(eq(projects.id, task.projectId)))[0];
  const workspaceRoot = params.workspaceRoot ?? project?.defaultWorkspace ?? "";

  const taskScoped = selection.memories.filter((m) => m.scope === "task");
  const otherScoped = selection.memories.filter((m) => m.scope !== "task");

  // Prefer the run's declared write paths for the FS write scope (#20). Dedupe
  // using canonical lease keys, but preserve the source-case path because this
  // policy is a runtime/filesystem domain, not the lowercase lease-control key.
  // Fall back to the broad workspace root for back-compat when none were declared.
  const writePaths = dedupeWriteScope(params.writePaths ?? []);
  const filesystemWriteScope =
    writePaths.length > 0 ? [...writePaths] : workspaceRoot === "" ? [] : [workspaceRoot];

  let conversation: ContextPack["conversation"];
  const discussion = (await tx.select({ id: discussions.id, status: discussions.status, deadlineAt: discussions.deadlineAt }).from(discussions)
    .where(and(eq(discussions.taskId, task.id), eq(discussions.organizationId, ctx.organizationId))).limit(1))[0];
  if (discussion && (discussion.status !== "running" || ctx.clock.now().getTime() >= Date.parse(discussion.deadlineAt))) {
    throw AppError.invalidState("This planning discussion has stopped or reached its time limit");
  }
  if (params.assistantTurnId) {
    const turn = (await tx.select().from(assistantTurns).where(and(eq(assistantTurns.id, params.assistantTurnId), eq(assistantTurns.taskId, task.id), eq(assistantTurns.organizationId, ctx.organizationId))))[0];
    const request = turn ? (await tx.select().from(messages).where(eq(messages.id, turn.userMessageId)))[0] : undefined;
    if (!turn || !request) throw new Error("Assistant conversation context is missing");
    const history = await tx.select().from(messages).where(and(eq(messages.roomId, turn.roomId),
      turn.threadRootId ? or(eq(messages.threadRootId, turn.threadRootId), eq(messages.id, turn.threadRootId)) : isNull(messages.threadRootId),
      eq(messages.organizationId, ctx.organizationId), eq(messages.kind, "text"), ne(messages.id, request.id),
      // A prior turn's answer can arrive after an already-queued follow-up. Include
      // it, while excluding future user requests from this turn's instructions.
      or(and(eq(messages.actorType, "user"), lte(messages.position, request.position)), eq(messages.actorType, "agent")),
    )).orderBy(desc(messages.position)).limit(101);
    const selected: { id: string; role: "user" | "assistant"; body: string; actor_id: string }[] = [];
    let remaining = 80000;
    let truncated = history.length > 100;
    for (const message of history.slice(0, 100)) {
      if (message.body.length > remaining) { truncated = true; break; }
      selected.push({ id: message.id, role: message.actorType === "agent" ? "assistant" : "user", body: message.body, actor_id: message.actorId });
      remaining -= message.body.length;
    }
    conversation = { room_id: turn.roomId, thread_root_id: turn.threadRootId, turn_id: turn.id, current_request: request.body, messages: selected.reverse(), history_truncated: truncated };
  }

  const payload: ContextPack = ContextPackSchema.parse({
    ...(conversation ? { conversation } : {}),
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      acceptance_criteria: task.acceptanceCriteria,
    },
    project: {
      id: task.projectId,
      name: project?.name ?? task.projectId,
      default_workspace: project?.defaultWorkspace ?? null,
    },
    workspace: { root: workspaceRoot, file_scope: [] },
    policy: {
      ...(discussion ? { execution_mode: "discussion" as const } : {}),
      filesystem_write_scope: discussion ? [] : filesystemWriteScope,
      requires_approval: ["git.push", "external.post"],
    },
    memory: {
      task_summary: taskScoped.length > 0 ? taskScoped.map(renderMemory).join("\n\n") : null,
      project_notes: otherScoped.map(renderMemory),
    },
    artifacts: { expected: [] },
  });

  const contextPackId = ctx.idGen.generate(ID_PREFIXES.contextPack);
  await tx.insert(contextPacks).values({
    id: contextPackId,
    organizationId: ctx.organizationId,
    taskId: task.id,
    runId: params.runId,
    payload,
    sourceMemoryIds: selection.source_memory_ids,
    createdAt: now,
  });

  return { contextPackId, sourceMemoryIds: selection.source_memory_ids };
}
