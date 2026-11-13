import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, index, integer, pgTable, text, unique } from "drizzle-orm/pg-core";

// Foreign-key callbacks retain deferred resolution of the cross-domain tables.
import { goals, runs } from "../schema.js";
import { jsonbArray, ts } from "./columns.js";
import { organizations } from "./identity.js";

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  name: text("name").notNull(),
  defaultWorkspace: text("default_workspace"),
  createdAt: ts("created_at").notNull(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    parentTaskId: text("parent_task_id").references((): AnyPgColumn => tasks.id),
    executionPolicyTaskId: text("execution_policy_task_id").references((): AnyPgColumn => tasks.id),
    roomId: text("room_id"),
    goalId: text("goal_id").references((): AnyPgColumn => goals.id),
    sourcePlanId: text("source_plan_id"),
    sourcePlanSpecRef: text("source_plan_spec_ref"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull(),
    priority: text("priority").notNull().default("p2"),
    assigneeType: text("assignee_type"),
    assigneeId: text("assignee_id"),
    requiredCapabilities: jsonbArray("required_capabilities"),
    preferredModelProfileId: text("preferred_model_profile_id"),
    preferredEffort: text("preferred_effort"),
    acceptanceCriteria: jsonbArray("acceptance_criteria"),
    createdByType: text("created_by_type").notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check(
      "tasks_status_chk",
      sql`${t.status} in ('backlog','ready','assigned','running','awaiting_approval','blocked','review','done','cancelled')`,
    ),
    check(
      "tasks_assignee_type_chk",
      sql`${t.assigneeType} is null or ${t.assigneeType} in ('user','agent','agent_team')`,
    ),
    check(
      "tasks_preferred_effort_chk",
      sql`${t.preferredEffort} is null or ${t.preferredEffort} in ('low','medium','high','max')`,
    ),
    check("tasks_created_by_type_chk", sql`${t.createdByType} in ('user','agent','system')`),
    index("tasks_project_status_updated_idx").on(t.projectId, t.status, t.updatedAt),
    index("tasks_org_project_created_idx").on(t.organizationId, t.projectId, t.createdAt, t.id),
    index("tasks_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
    index("tasks_description_trgm_idx").using("gin", t.description.op("gin_trgm_ops")),
    index("tasks_parent_idx").on(t.parentTaskId),
    index("tasks_goal_idx").on(t.goalId),
    // #115 P1d: DB-level dedup so a plan→DAG materialization retry cannot create
    // duplicate tasks for the same plan spec. NULLs (non-plan tasks) don't collide.
    unique("tasks_source_plan_spec_uniq").on(t.sourcePlanId, t.sourcePlanSpecRef),
  ],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fromTaskId: text("from_task_id")
      .notNull()
      .references(() => tasks.id),
    toTaskId: text("to_task_id")
      .notNull()
      .references(() => tasks.id),
    type: text("type").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check(
      "task_deps_type_chk",
      sql`${t.type} in ('blocks','artifact_required','contract_required','review_required','soft_context')`,
    ),
    unique("task_deps_unique").on(t.fromTaskId, t.toTaskId, t.type),
    index("task_deps_to_idx").on(t.toTaskId),
  ],
);

export const fileLeases = pgTable(
  "file_leases",
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
    runId: text("run_id").references(() => runs.id),
    holderType: text("holder_type").notNull(),
    holderId: text("holder_id").notNull(),
    path: text("path").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull().default("held"),
    acquiredAt: ts("acquired_at").notNull(),
    expiresAt: ts("expires_at"),
    releasedAt: ts("released_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("file_leases_mode_chk", sql`${t.mode} in ('read','write')`),
    check("file_leases_status_chk", sql`${t.status} in ('held','released','expired')`),
    check("file_leases_holder_type_chk", sql`${t.holderType} in ('run','task','agent','system')`),
    index("file_leases_project_status_idx").on(t.projectId, t.status),
    index("file_leases_path_idx").on(t.path),
  ],
);

export const integrationQueue = pgTable(
  "integration_queue",
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
    runId: text("run_id").references(() => runs.id),
    status: text("status").notNull().default("queued"),
    sequence: integer("sequence").notNull(),
    artifactRef: text("artifact_ref"),
    enqueuedAt: ts("enqueued_at").notNull(),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("integration_queue_status_chk", sql`${t.status} in ('queued','integrating','done','failed')`),
    index("integration_queue_project_status_idx").on(t.projectId, t.status),
  ],
);
