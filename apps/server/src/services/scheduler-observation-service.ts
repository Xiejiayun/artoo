import { projects } from "@artoo/db";
import type { SchedulerObservationsV1 } from "@artoo/domain";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

const querySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    hanging_after_ms: z.coerce
      .number()
      .int()
      .min(1000)
      .max(7 * 86400000)
      .optional(),
  })
  .strict();
type ObservationRow = {
  assignments: number;
  queue_samples: number;
  queue_mean_ms: number | null;
  queue_max_ms: number | null;
  execution_samples: number;
  execution_mean_ms: number | null;
  execution_max_ms: number | null;
  terminal_runs: number;
  failed_runs: number;
  hanging_tasks: number;
  unconfirmed_disconnect_runs: number;
};

/** Read-only durable baseline. No scheduling decisions or process-exit inference. */
export async function getSchedulerObservations(
  ctx: ServerContext,
  projectId: string,
  query: unknown,
): Promise<SchedulerObservationsV1> {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw AppError.validation("invalid scheduler observation window");
  const now = ctx.clock.nowIso();
  const to = parsed.data.to ?? now;
  const from = parsed.data.from ?? new Date(Date.parse(to) - 7 * 86400000).toISOString();
  if (
    Date.parse(from) >= Date.parse(to) ||
    Date.parse(to) > Date.parse(now) ||
    Date.parse(to) - Date.parse(from) > 31 * 86400000
  ) {
    throw AppError.validation("observation window must be positive, at most 31 days, and not in the future");
  }
  const hangingAfter = parsed.data.hanging_after_ms ?? 3600000;
  const cutoff = new Date(Date.parse(now) - hangingAfter).toISOString();
  return ctx.db.db.transaction(
    async (tx) => {
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.organizationId, ctx.organizationId), eq(projects.id, projectId)));
      if (!project) throw AppError.notFound("project not found");
      // Position, rather than timestamp alone, binds a ready event to this queue
      // cycle. Retry/review cycles can share timestamps under a deterministic clock.
      const result = await tx.execute(sql`
      WITH assignments AS (
        SELECT a.task_id, a.occurred_at, q.occurred_at AS ready_at
        FROM event_log a LEFT JOIN LATERAL (
          SELECT e.occurred_at FROM event_log e
          WHERE e.organization_id = a.organization_id AND e.project_id = a.project_id
            AND e.task_id = a.task_id AND e.position < a.position
            AND e.type = 'task.updated' AND e.payload ->> 'status' = 'ready'
            AND NOT EXISTS (SELECT 1 FROM event_log previous
              WHERE previous.organization_id = a.organization_id AND previous.project_id = a.project_id
                AND previous.task_id = a.task_id AND previous.type = 'task.assigned'
                AND previous.position > e.position AND previous.position < a.position)
          ORDER BY e.position DESC LIMIT 1
        ) q ON true
        WHERE a.organization_id = ${ctx.organizationId} AND a.project_id = ${projectId}
          AND a.type = 'task.assigned' AND a.occurred_at >= ${from}::timestamptz
          AND a.occurred_at < ${to}::timestamptz
      ), queue AS (
        SELECT EXTRACT(epoch FROM (occurred_at - ready_at)) * 1000 AS ms
        FROM assignments WHERE ready_at IS NOT NULL AND occurred_at >= ready_at
      ), project_runs AS (
        SELECT r.* FROM runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.organization_id = ${ctx.organizationId} AND t.organization_id = ${ctx.organizationId}
          AND t.project_id = ${projectId}
      ), terminal AS (
        SELECT * FROM project_runs WHERE status IN ('completed','failed','cancelled')
          AND ended_at >= ${from}::timestamptz AND ended_at < ${to}::timestamptz
      ), execution AS (
        SELECT EXTRACT(epoch FROM (ended_at - started_at)) * 1000 AS ms FROM terminal
        WHERE started_at IS NOT NULL AND ended_at >= started_at
      )
      SELECT (SELECT count(*)::int FROM assignments) AS assignments,
        (SELECT count(*)::int FROM queue) AS queue_samples,
        (SELECT avg(ms)::float8 FROM queue) AS queue_mean_ms,
        (SELECT max(ms)::float8 FROM queue) AS queue_max_ms,
        (SELECT count(*)::int FROM execution) AS execution_samples,
        (SELECT avg(ms)::float8 FROM execution) AS execution_mean_ms,
        (SELECT max(ms)::float8 FROM execution) AS execution_max_ms,
        (SELECT count(*)::int FROM terminal) AS terminal_runs,
        (SELECT count(*)::int FROM terminal WHERE status = 'failed') AS failed_runs,
        (SELECT count(DISTINCT task_id)::int FROM project_runs
          WHERE status IN ('queued','starting','running','paused','awaiting_input')
            AND COALESCE(started_at, created_at) <= ${cutoff}::timestamptz) AS hanging_tasks,
        (SELECT count(*)::int FROM project_runs r
          WHERE r.status = 'failed' AND r.failure_reason = 'daemon_disconnect'
            AND NOT EXISTS (SELECT 1 FROM event_log e
              WHERE e.organization_id = r.organization_id AND e.run_id = r.id
                AND e.type IN ('run.failed','run.reconciled')
                AND e.payload -> 'process_exit_confirmed' = 'true'::jsonb)) AS unconfirmed_disconnect_runs
    `);
      const row = (result.rows as ObservationRow[])[0]!;
      return {
        version: 1 as const,
        project_id: projectId,
        observed_at: now,
        window: { from, to },
        hanging_after_ms: hangingAfter,
        queue: {
          assignments: row.assignments,
          samples: row.queue_samples,
          mean_ms: row.queue_mean_ms,
          max_ms: row.queue_max_ms,
        },
        execution: { samples: row.execution_samples, mean_ms: row.execution_mean_ms, max_ms: row.execution_max_ms },
        failure: {
          terminal_runs: row.terminal_runs,
          failed_runs: row.failed_runs,
          rate: row.terminal_runs === 0 ? null : row.failed_runs / row.terminal_runs,
        },
        current: { hanging_tasks: row.hanging_tasks, unconfirmed_disconnect_runs: row.unconfirmed_disconnect_runs },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
