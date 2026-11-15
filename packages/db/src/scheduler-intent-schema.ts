import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type { SchedulerIntentSnapshotV1 } from "@artoo/domain";
import { agents, organizations, users } from "./schema/identity.js";
import { projects, tasks } from "./schema/work.js";
import { ts } from "./schema/columns.js";

/** Immutable original-user request metadata; never an execution grant. */
export const schedulerIntents = pgTable(
  "scheduler_intents",
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
    version: integer("version").notNull().default(1),
    state: text("state").notNull().default("pending").$type<"pending" | "cancelled">(),
    snapshot: jsonb("snapshot").notNull().$type<SchedulerIntentSnapshotV1>(),
    snapshotDigest: text("snapshot_digest").notNull(),
    executionAuthorized: boolean("execution_authorized").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    cancelledAt: ts("cancelled_at"),
    cancelledByUserId: text("cancelled_by_user_id").references(() => users.id),
  },
  (t) => [
    check("scheduler_intent_version_chk", sql`${t.version} = 1`),
    check("scheduler_intent_state_chk", sql`${t.state} IN ('pending','cancelled')`),
    check("scheduler_intent_authority_chk", sql`${t.executionAuthorized} = false`),
    check(
      "scheduler_intent_snapshot_chk",
      sql`(${t.snapshot}->'version' = '1'::jsonb AND ${t.snapshot}->'execution_authorized' = 'false'::jsonb) IS TRUE`,
    ),
    check("scheduler_intent_digest_chk", sql`${t.snapshotDigest} ~ '^sha256:[a-f0-9]{64}$'`),
    check(
      "scheduler_intent_cancel_chk",
      sql`(${t.state} = 'pending' AND ${t.cancelledAt} IS NULL AND ${t.cancelledByUserId} IS NULL) OR
    (${t.state} = 'cancelled' AND ${t.cancelledAt} IS NOT NULL AND ${t.cancelledByUserId} IS NOT NULL)`,
    ),
    unique("scheduler_intent_request_unique").on(t.taskId, t.requestKey),
    uniqueIndex("scheduler_intent_pending_task_idx").on(t.taskId).where(sql`${t.state} = 'pending'`),
    index("scheduler_intent_scope_idx").on(t.organizationId, t.projectId, t.createdAt.desc()),
  ],
);
