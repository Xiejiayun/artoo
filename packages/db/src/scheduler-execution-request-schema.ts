import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type { SchedulerExecutionRequestSnapshotV2 } from "@artoo/domain";
import { agents, organizations, users } from "./schema/identity.js";
import { projects, tasks } from "./schema/work.js";
import { ts } from "./schema/columns.js";
import { runs } from "./schema/execution.js";
import { devices } from "./schema.js";

/** Conditional original-user permission; consumption requires a separate claim transaction. */
export const schedulerExecutionRequests = pgTable(
  "scheduler_execution_requests",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    requestKey: text("request_key").notNull(),
    version: integer("version").notNull().default(2),
    state: text("state").notNull().default("pending").$type<"pending" | "cancelled" | "consumed">(),
    snapshot: jsonb("snapshot").notNull().$type<SchedulerExecutionRequestSnapshotV2>(),
    snapshotDigest: text("snapshot_digest").notNull(),
    createdAt: ts("created_at").notNull(),
    cancelledAt: ts("cancelled_at"),
    cancelledByUserId: text("cancelled_by_user_id").references(() => users.id),
    consumedRunId: text("consumed_run_id").references(() => runs.id),
    consumedDeviceId: text("consumed_device_id").references(() => devices.id),
    consumedSessionId: text("consumed_session_id"),
    consumedAt: ts("consumed_at"),
  },
  (t) => [
    check("scheduler_execution_request_version_chk", sql`${t.version} = 2`),
    check("scheduler_execution_request_state_chk", sql`${t.state} IN ('pending','cancelled','consumed')`),
    check(
      "scheduler_execution_request_snapshot_chk",
      sql`(
    ${t.snapshot}->'version' = '2'::jsonb AND ${t.snapshot}->'request'->'version' = '2'::jsonb
    AND ${t.snapshot}->'request'->>'permission' = 'execute_once'
    AND ${t.snapshot}->>'organization_id' = ${t.organizationId} AND ${t.snapshot}->>'project_id' = ${t.projectId}
    AND ${t.snapshot}->>'task_id' = ${t.taskId} AND ${t.snapshot}->>'actor_user_id' = ${t.actorUserId}
    AND ${t.snapshot}->'request'->>'agent_id' = ${t.agentId} AND ${t.snapshot}->'request'->>'request_key' = ${t.requestKey}
  ) IS TRUE`,
    ),
    check("scheduler_execution_request_digest_chk", sql`${t.snapshotDigest} ~ '^sha256:[a-f0-9]{64}$'`),
    check(
      "scheduler_execution_request_cancel_chk",
      sql`
    (${t.state} IN ('pending','consumed') AND ${t.cancelledAt} IS NULL AND ${t.cancelledByUserId} IS NULL) OR
    (${t.state} = 'cancelled' AND ${t.cancelledAt} IS NOT NULL AND ${t.cancelledByUserId} IS NOT NULL)`,
    ),
    check(
      "scheduler_execution_request_consumed_chk",
      sql`(${t.state} = 'consumed' AND ${t.consumedRunId} IS NOT NULL AND ${t.consumedDeviceId} IS NOT NULL
        AND ${t.consumedSessionId} IS NOT NULL AND length(${t.consumedSessionId}) BETWEEN 1 AND 128 AND ${t.consumedAt} IS NOT NULL) OR
        (${t.state} <> 'consumed' AND ${t.consumedRunId} IS NULL AND ${t.consumedDeviceId} IS NULL
        AND ${t.consumedSessionId} IS NULL AND ${t.consumedAt} IS NULL)`,
    ),
    unique("scheduler_execution_request_consumed_run_unique").on(t.consumedRunId),
    unique("scheduler_execution_request_key_unique").on(t.taskId, t.requestKey),
    uniqueIndex("scheduler_execution_request_pending_task_idx").on(t.taskId).where(sql`${t.state} = 'pending'`),
    index("scheduler_execution_request_scope_idx").on(t.organizationId, t.projectId, t.createdAt.desc()),
  ],
);
