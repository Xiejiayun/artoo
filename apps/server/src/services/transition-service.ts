import { appendEvent, runs, tasks, type EventInput } from "@artoo/db";
import {
  applyRunTransition,
  applyTaskTransition,
  type RunStatus,
  type RunTrigger,
  type TaskStatus,
  type TaskTrigger,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";

export interface TransitionResult {
  /** True iff the guarded UPDATE actually changed the row (status was `from`). */
  changed: boolean;
  to: TaskStatus;
}

/**
 * Guarded compare-and-set task transition. The UPDATE only fires when the row
 * is still in `from`, so a duplicate/stale request changes nothing and writes
 * NO event (Gate 0.5: events are written only on a real state change). The
 * caller computes `from` from the row it just read inside the same transaction.
 */
export async function transitionTask(
  tx: DrizzleDb,
  ctx: ServerContext,
  params: {
    taskId: string;
    from: TaskStatus;
    trigger: TaskTrigger;
    now: string;
    /** Events to append iff the transition actually changes state. */
    events?: (to: TaskStatus) => EventInput[];
  },
): Promise<TransitionResult> {
  const to = applyTaskTransition(params.from, params.trigger);
  const updated = await tx
    .update(tasks)
    .set({ status: to, updatedAt: params.now })
    .where(
      and(
        eq(tasks.id, params.taskId),
        eq(tasks.status, params.from),
        eq(tasks.organizationId, ctx.organizationId),
      ),
    )
    .returning({ id: tasks.id });

  const changed = updated.length > 0;
  if (changed && params.events !== undefined) {
    for (const event of params.events(to)) {
      await appendEvent(tx, event);
    }
  }
  return { changed, to };
}

export interface RunTransitionResult {
  changed: boolean;
  to: RunStatus;
}

/**
 * Guarded compare-and-set run transition. Like {@link transitionTask} but on the
 * runs table; an extra `set` patch (ended_at, failure_reason) is applied with the
 * status change. Returns whether the row actually changed.
 */
export async function transitionRun(
  tx: DrizzleDb,
  ctx: ServerContext,
  params: {
    runId: string;
    from: RunStatus;
    trigger: RunTrigger;
    patch?: Partial<{ endedAt: string; startedAt: string; failureReason: string }>;
  },
): Promise<RunTransitionResult> {
  const to = applyRunTransition(params.from, params.trigger);
  const updated = await tx
    .update(runs)
    .set({ status: to, ...params.patch })
    .where(
      and(
        eq(runs.id, params.runId),
        eq(runs.status, params.from),
        eq(runs.organizationId, ctx.organizationId),
      ),
    )
    .returning({ id: runs.id });
  return { changed: updated.length > 0, to };
}

