/**
 * Sync service (#27 v2-B slice 2). The cross-client read/command contract built
 * on the slice-1 WS recovery model:
 *  - `currentCursor` exposes the org's highest `event_log.position` so a client
 *    can pin the snapshot version it read at, then reuse it as the WS
 *    `since_cursor` baseline (hydration/tail);
 *  - `currentTaskVersion` exposes a per-task version (the task's highest
 *    `event_log.position`) returned on the task read surface; a command's
 *    `base_version` is minted from THAT resource snapshot — never from the global
 *    org cursor — so a command can never act on a task the user never hydrated;
 *  - `assertFreshTaskBaseVersion` is the optimistic-concurrency guard: it rejects
 *    a command whose `base_version` is older than the task's current version.
 *
 * The version source is `event_log.position` (a DB-assigned monotonic bigserial)
 * — no separate per-resource version column.
 */
import { eventLog } from "@artoo/db";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

/** The org's highest `event_log.position`, read through any executor (db or tx). */
async function maxOrgPosition(db: DrizzleDb, organizationId: string): Promise<number> {
  const row = (
    await db
      .select({ position: eventLog.position })
      .from(eventLog)
      .where(eq(eventLog.organizationId, organizationId))
      .orderBy(desc(eventLog.position))
      .limit(1)
  )[0];
  return row?.position ?? 0;
}

/** One task's highest `event_log.position`, read through any executor (db or tx). */
async function maxTaskPosition(db: DrizzleDb, organizationId: string, taskId: string): Promise<number> {
  const row = (
    await db
      .select({ position: eventLog.position })
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, organizationId), eq(eventLog.taskId, taskId)))
      .orderBy(desc(eventLog.position))
      .limit(1)
  )[0];
  return row?.position ?? 0;
}

/**
 * The current global sync cursor: the org's highest `event_log.position`, or 0
 * when the org has no events yet. Clients use it as the WS `since_cursor`
 * hydration/tail baseline (NOT as a command base_version source).
 */
export async function currentCursor(ctx: ServerContext): Promise<number> {
  return maxOrgPosition(ctx.db.db, ctx.organizationId);
}

/**
 * The current version of one task: its highest `event_log.position`, or 0 when
 * the task has no events. Returned on the task read surface so a hydrated client
 * can send it back as a command `base_version`.
 */
export async function currentTaskVersion(ctx: ServerContext, taskId: string): Promise<number> {
  return maxTaskPosition(ctx.db.db, ctx.organizationId, taskId);
}

/** Conflict record surfaced (in the AppError details) when a command's
 *  `base_version` is stale. The SDK keys offline-replay conflict handling on
 *  `reason === "stale_base_version"`. */
export interface StaleBaseVersionConflict {
  reason: "stale_base_version";
  base_version: number;
  current_version: number;
  resource: { type: string; id: string };
}

/**
 * Optimistic-concurrency guard for a task-scoped command. When `baseVersion` is
 * provided and is older than the task's current version, reject with a 409 that
 * carries a {@link StaleBaseVersionConflict} record. A `null`/`undefined`
 * baseVersion skips the check (backward-compatible: the command applies blindly).
 * Reads through the supplied executor so the check is consistent inside the
 * command's own transaction.
 */
export async function assertFreshTaskBaseVersion(
  db: DrizzleDb,
  organizationId: string,
  taskId: string,
  baseVersion: number | null | undefined,
): Promise<void> {
  if (baseVersion === null || baseVersion === undefined) {
    return;
  }
  const current = await maxTaskPosition(db, organizationId, taskId);
  if (baseVersion < current) {
    const conflict: StaleBaseVersionConflict = {
      reason: "stale_base_version",
      base_version: baseVersion,
      current_version: current,
      resource: { type: "task", id: taskId },
    };
    throw AppError.conflict("task changed since base_version; refetch and retry", { ...conflict });
  }
}
