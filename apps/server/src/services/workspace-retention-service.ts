import { eventLog, type runs } from "@artoo/db";
import { StoredWorkspaceRetainedPayloadSchema, WorkspaceRetentionProjectionSchema, type WorkspaceRetentionProjection } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, inArray } from "drizzle-orm";

type RunRow = typeof runs.$inferSelect;
type EventRow = typeof eventLog.$inferSelect;
export const WORKSPACE_RETAINED_EVENT = "run.workspace.retained";

/** Validate the latest historical worker report; never infer current disk state. */
export function projectWorkspaceRetention(run: RunRow, event: EventRow | undefined): WorkspaceRetentionProjection | null {
  if (!event || event.type !== WORKSPACE_RETAINED_EVENT || event.organizationId !== run.organizationId
    || event.runId !== run.id || event.taskId !== run.taskId || event.actorType !== "system"
    || event.actorId !== run.computerId || run.workspaceRoot === null || run.workspaceBranch === null) return null;
  const payload = StoredWorkspaceRetainedPayloadSchema.safeParse(event.payload);
  if (!payload.success || payload.data.reporter_computer_id !== run.computerId
    || payload.data.workspace_root !== run.workspaceRoot || payload.data.workspace_branch !== run.workspaceBranch) return null;
  const timestamp = Date.parse(event.occurredAt);
  if (!Number.isFinite(timestamp)) return null;
  const projection = WorkspaceRetentionProjectionSchema.safeParse({ ...payload.data,
    event_id: event.id, position: event.position, sequence: event.sequence, reported_at: new Date(timestamp).toISOString() });
  return projection.success ? projection.data : null;
}

/** One metadata row per run, regardless of the amount of process output. */
export async function loadWorkspaceRetentions(db: DrizzleDb, organizationId: string, runRows: readonly RunRow[]): Promise<Map<string, WorkspaceRetentionProjection | null>> {
  if (runRows.length === 0) return new Map();
  const latest = await db.selectDistinctOn([eventLog.runId]).from(eventLog).where(and(
    eq(eventLog.organizationId, organizationId), eq(eventLog.type, WORKSPACE_RETAINED_EVENT),
    inArray(eventLog.runId, runRows.map((run) => run.id)),
  )).orderBy(eventLog.runId, desc(eventLog.position));
  const byRun = new Map(latest.map((event) => [event.runId, event]));
  return new Map(runRows.map((run) => [run.id, projectWorkspaceRetention(run, byRun.get(run.id))]));
}

/** Audit already loads event history; reuse it without adding another query. */
export function workspaceRetentionsFromEvents(runRows: readonly RunRow[], events: readonly EventRow[]): Map<string, WorkspaceRetentionProjection | null> {
  const latest = new Map<string, EventRow>();
  for (const event of events) {
    if (event.type !== WORKSPACE_RETAINED_EVENT || event.runId === null) continue;
    if ((latest.get(event.runId)?.position ?? -1) < event.position) latest.set(event.runId, event);
  }
  return new Map(runRows.map((run) => [run.id, projectWorkspaceRetention(run, latest.get(run.id))]));
}
