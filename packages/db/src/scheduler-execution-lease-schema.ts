import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type { SchedulerExecutionLeaseBindingV1, SchedulerExecutionLeaseStateV1 } from "@artoo/domain";
import { schedulerStartGrants } from "./scheduler-start-grant-schema.js";
import { organizations } from "./schema/identity.js";
import { projects, tasks } from "./schema/work.js";
import { ts } from "./schema/columns.js";

/** Logical ownership only. No transition releases a Run's physical reservations. */
export const schedulerExecutionLeases = pgTable(
  "scheduler_execution_leases",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => schedulerStartGrants.requestId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    epoch: bigint("epoch", { mode: "number" }).notNull(),
    binding: jsonb("binding").notNull().$type<SchedulerExecutionLeaseBindingV1>(),
    state: text("state").notNull().$type<SchedulerExecutionLeaseStateV1>(),
    claimedAt: ts("claimed_at").notNull(),
    observedAt: ts("observed_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    closedAt: ts("closed_at"),
  },
  (t) => [
    unique("scheduler_execution_lease_request_unique").on(t.requestId),
    unique("scheduler_execution_lease_epoch_unique").on(t.taskId, t.epoch),
    uniqueIndex("scheduler_execution_lease_active_task_idx").on(t.taskId).where(sql`${t.state} = 'active'`),
    index("scheduler_execution_lease_expiry_idx").on(t.organizationId, t.expiresAt).where(sql`${t.state} = 'active'`),
    check("scheduler_execution_lease_epoch_chk", sql`${t.epoch} BETWEEN 1 AND 9007199254740991`),
    check(
      "scheduler_execution_lease_binding_chk",
      sql`(${t.binding}->'version' = '1'::jsonb
    AND ${t.binding}->>'scope' = 'scheduler.execution-lease.v1' AND ${t.binding}->>'lease_id' = ${t.id}
    AND ${t.binding}->>'request_id' = ${t.requestId} AND ${t.binding}->>'organization_id' = ${t.organizationId}
    AND ${t.binding}->>'project_id' = ${t.projectId} AND ${t.binding}->>'task_id' = ${t.taskId}
    AND ${t.binding}->'epoch' = to_jsonb(${t.epoch})) IS TRUE`,
    ),
    check(
      "scheduler_execution_lease_time_chk",
      sql`isfinite(${t.claimedAt}) AND isfinite(${t.observedAt}) AND isfinite(${t.expiresAt})
    AND ${t.observedAt} >= ${t.claimedAt} AND ${t.expiresAt} > ${t.claimedAt}
    AND ${t.expiresAt} <= ${t.observedAt} + interval '5 minutes'
    AND ((${t.state} = 'active' AND ${t.closedAt} IS NULL AND ${t.observedAt} < ${t.expiresAt})
      OR (${t.state} IN ('expired','revoked') AND ${t.closedAt} = ${t.observedAt}
        AND (${t.state} <> 'expired' OR ${t.observedAt} >= ${t.expiresAt}))) IS TRUE`,
    ),
  ],
);
