import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { SchedulerAgentPolicyV1, SchedulerComputerPolicyV1, SchedulerProjectPolicyV1 } from "@artoo/domain";
import { agents, organizations, users } from "./schema/identity.js";
import { computers } from "./schema/execution.js";
import { projects, tasks } from "./schema/work.js";
import { ts } from "./schema/columns.js";

export const schedulerProjectPolicies = pgTable(
  "scheduler_project_policies",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    policy: jsonb("policy").notNull().$type<SchedulerProjectPolicyV1>(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    updatedByUserId: text("updated_by_user_id")
      .notNull()
      .references(() => users.id),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check("scheduler_project_policy_revision_chk", sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
    check(
      "scheduler_project_policy_v1_chk",
      sql`(jsonb_typeof(${t.policy}) = 'object' AND ${t.policy}->'version' = '1'::jsonb) IS TRUE`,
    ),
  ],
);

export const schedulerAgentPolicies = pgTable(
  "scheduler_agent_policies",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    policy: jsonb("policy").notNull().$type<SchedulerAgentPolicyV1>(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    updatedByUserId: text("updated_by_user_id")
      .notNull()
      .references(() => users.id),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check("scheduler_agent_policy_revision_chk", sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
    check(
      "scheduler_agent_policy_v1_chk",
      sql`(jsonb_typeof(${t.policy}) = 'object' AND ${t.policy}->'version' = '1'::jsonb) IS TRUE`,
    ),
  ],
);

export const schedulerComputerPolicies = pgTable(
  "scheduler_computer_policies",
  {
    computerId: text("computer_id")
      .primaryKey()
      .references(() => computers.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    policy: jsonb("policy").notNull().$type<SchedulerComputerPolicyV1>(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    updatedByUserId: text("updated_by_user_id")
      .notNull()
      .references(() => users.id),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check("scheduler_computer_policy_revision_chk", sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
    check(
      "scheduler_computer_policy_v1_chk",
      sql`(jsonb_typeof(${t.policy}) = 'object' AND ${t.policy}->'version' = '1'::jsonb) IS TRUE`,
    ),
  ],
);

/** Migration projection, not a run token, verifier receipt or execution grant. */
export const schedulerTaskProjections = pgTable(
  "scheduler_task_projections",
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
    legacyStatus: text("legacy_status").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull().default(0),
    sourceUpdatedAt: ts("source_updated_at").notNull(),
    syncedAt: ts("synced_at").notNull(),
  },
  (t) => [
    check("scheduler_task_projection_v1_chk", sql`${t.version} = 1`),
    check(
      "scheduler_task_projection_status_chk",
      sql`${t.legacyStatus} IN ('backlog','ready','assigned','running','awaiting_approval','blocked','review','done','cancelled')`,
    ),
    check("scheduler_task_projection_attempt_chk", sql`${t.attemptCount} >= 0`),
    check("scheduler_task_projection_epoch_chk", sql`${t.leaseEpoch} BETWEEN 0 AND 9007199254740991`),
    index("scheduler_task_projection_scope_idx").on(t.organizationId, t.projectId),
  ],
);

export const schedulerReconciliations = pgTable(
  "scheduler_reconciliations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    observedAt: ts("observed_at").notNull(),
    sourceCount: integer("source_count").notNull(),
    projectionCount: integer("projection_count").notNull(),
    mismatchesBefore: integer("mismatches_before").notNull(),
    mismatchesAfter: integer("mismatches_after").notNull(),
    repaired: integer("repaired").notNull(),
    repairRequested: boolean("repair_requested").notNull(),
  },
  (t) => [
    check(
      "scheduler_reconciliation_counts_chk",
      sql`${t.sourceCount} >= 0 AND ${t.projectionCount} >= 0 AND ${t.mismatchesBefore} >= 0 AND ${t.mismatchesAfter} >= 0 AND ${t.repaired} >= 0`,
    ),
    index("scheduler_reconciliation_history_idx").on(t.organizationId, t.projectId, t.id.desc()),
  ],
);
