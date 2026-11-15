import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { organizations, users } from "./schema/identity.js";
import { tasks, projects } from "./schema/work.js";
import { ts } from "./schema/columns.js";

/** New explicit delegation only. Existing Task parents retain their original semantics. */
export const taskDelegations = pgTable(
  "task_delegations",
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
    parentTaskId: text("parent_task_id")
      .notNull()
      .references(() => tasks.id),
    rootTaskId: text("root_task_id")
      .notNull()
      .references(() => tasks.id),
    version: integer("version").notNull().default(1),
    depth: integer("depth").notNull(),
    initiatedByUserId: text("initiated_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("task_delegation_version_chk", sql`${t.version} = 1`),
    check("task_delegation_depth_chk", sql`${t.depth} BETWEEN 1 AND 3`),
    check(
      "task_delegation_identity_chk",
      sql`${t.taskId} <> ${t.parentTaskId} AND ${t.taskId} <> ${t.rootTaskId}
    AND ((${t.depth} = 1 AND ${t.parentTaskId} = ${t.rootTaskId}) OR (${t.depth} > 1 AND ${t.parentTaskId} <> ${t.rootTaskId}))`,
    ),
    index("task_delegation_root_idx").on(t.rootTaskId, t.depth, t.taskId),
  ],
);
