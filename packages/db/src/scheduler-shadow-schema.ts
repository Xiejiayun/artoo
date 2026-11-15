import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type { SchedulerRankingSnapshotV1, rankSchedulerCandidates } from "@artoo/domain";
import { agents, organizations } from "./schema/identity.js";
import { agentInstances, computers, schedulerDecisions } from "./schema/execution.js";
import { projects, tasks } from "./schema/work.js";
import { ts } from "./schema/columns.js";

/** Counterfactual ownership only; deliberately separate from the legacy mirror. */
export const schedulerShadowTaskHeads = pgTable(
  "scheduler_shadow_task_heads",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => tasks.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    version: integer("version").notNull().default(1),
    epoch: bigint("epoch", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    check("scheduler_shadow_head_version_chk", sql`${t.version} = 1`),
    check("scheduler_shadow_head_epoch_chk", sql`${t.epoch} BETWEEN 0 AND 9007199254740991`),
  ],
);

/** No row in this table is a Run, process-exit confirmation or execution grant. */
export const schedulerShadowAttempts = pgTable(
  "scheduler_shadow_attempts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => schedulerShadowTaskHeads.taskId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    agentInstanceId: text("agent_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    epoch: bigint("epoch", { mode: "number" }).notNull(),
    state: text("state").notNull().$type<"claimed" | "running" | "finished" | "expired" | "cancelled">(),
    claimedAt: ts("claimed_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    executionAuthorized: boolean("execution_authorized").notNull().default(false),
    snapshot: jsonb("snapshot").notNull().$type<SchedulerRankingSnapshotV1>(),
    ranking: jsonb("ranking").notNull().$type<ReturnType<typeof rankSchedulerCandidates>>(),
  },
  (t) => [
    check("scheduler_shadow_attempt_epoch_chk", sql`${t.epoch} BETWEEN 1 AND 9007199254740991`),
    check(
      "scheduler_shadow_attempt_state_chk",
      sql`${t.state} IN ('claimed','running','finished','expired','cancelled')`,
    ),
    check("scheduler_shadow_attempt_authority_chk", sql`${t.executionAuthorized} = false`),
    check(
      "scheduler_shadow_attempt_snapshot_chk",
      sql`(${t.snapshot}->'version' = '1'::jsonb AND ${t.ranking}->'version' = '1'::jsonb AND ${t.ranking}->'execution_authorized' = 'false'::jsonb) IS TRUE`,
    ),
    check(
      "scheduler_shadow_attempt_times_chk",
      sql`${t.expiresAt} > ${t.claimedAt} AND
    ((${t.state} IN ('claimed','running') AND ${t.finishedAt} IS NULL) OR
     (${t.state} IN ('finished','expired','cancelled') AND ${t.finishedAt} IS NOT NULL)) AND
    (${t.state} <> 'running' OR ${t.startedAt} IS NOT NULL) AND
    (${t.state} <> 'finished' OR ${t.startedAt} IS NOT NULL)`,
    ),
    unique("scheduler_shadow_attempt_task_epoch_unique").on(t.taskId, t.epoch),
    uniqueIndex("scheduler_shadow_active_task_idx").on(t.taskId).where(sql`${t.state} IN ('claimed','running')`),
    index("scheduler_shadow_capacity_idx")
      .on(t.organizationId, t.expiresAt)
      .where(sql`${t.state} IN ('claimed','running')`),
  ],
);

/** Captured during the original decision, not reconstructed from later state. */
export const schedulerShadowObservations = pgTable(
  "scheduler_shadow_observations",
  {
    decisionId: text("decision_id")
      .primaryKey()
      .references(() => schedulerDecisions.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    collectionStartedAt: ts("collection_started_at").notNull(),
    collectionFinishedAt: ts("collection_finished_at").notNull(),
    recordedAt: ts("recorded_at").notNull(),
    snapshot: jsonb("snapshot").notNull().$type<SchedulerRankingSnapshotV1>(),
    ranking: jsonb("ranking").notNull().$type<ReturnType<typeof rankSchedulerCandidates>>(),
    occupants: jsonb("occupants").notNull().$type<unknown[]>(),
    revalidation: jsonb("revalidation").notNull().$type<{ selected_agent_instance_id: string; observed_at: string }>(),
  },
  (t) => [
    check(
      "scheduler_shadow_observation_snapshot_chk",
      sql`(${t.snapshot}->'version' = '1'::jsonb AND ${t.ranking}->'version' = '1'::jsonb AND ${t.ranking}->'execution_authorized' = 'false'::jsonb) IS TRUE`,
    ),
    index("scheduler_shadow_observations_scope_idx").on(t.organizationId, t.projectId, t.recordedAt.desc()),
  ],
);
