import { contextPacks, memories, projects, tasks } from "@artoo/db";
import {
  ContextPackSchema,
  ID_PREFIXES,
  normalizeLeasePath,
  selectInjectableMemories,
  type ContextPack,
  type Memory,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { mapMemory } from "../mappers.js";

export interface BuildContextPackParams {
  runId: string;
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

  const payload: ContextPack = ContextPackSchema.parse({
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
      filesystem_write_scope: filesystemWriteScope,
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
