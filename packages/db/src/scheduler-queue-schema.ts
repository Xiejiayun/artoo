import { sql } from "drizzle-orm";
import { bigint, check, integer, pgTable, text } from "drizzle-orm/pg-core";
import { computers } from "./schema/execution.js";
import { organizations, users } from "./schema/identity.js";
import { projects, tasks } from "./schema/work.js";
import { ts } from "./schema/columns.js";

/** Staged preferences; revision is not a lease epoch or an execution grant. */
export const schedulerTaskQueueMetadata = pgTable(
  "scheduler_task_queue_metadata",
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
    revision: bigint("revision", { mode: "number" }).notNull(),
    notBeforeMs: bigint("not_before_ms", { mode: "number" }).notNull(),
    preferredComputerId: text("preferred_computer_id").references(() => computers.id),
    preferUntilMs: bigint("prefer_until_ms", { mode: "number" }),
    updatedByUserId: text("updated_by_user_id")
      .notNull()
      .references(() => users.id),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check("scheduler_task_queue_version_chk", sql`${t.version} = 1`),
    check("scheduler_task_queue_revision_chk", sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
    check(
      "scheduler_task_queue_time_chk",
      sql`${t.notBeforeMs} BETWEEN 0 AND 8640000000000000 AND
    (${t.preferUntilMs} IS NULL OR ${t.preferUntilMs} BETWEEN 0 AND 8640000000000000)`,
    ),
    check("scheduler_task_queue_affinity_chk", sql`(${t.preferredComputerId} IS NULL) = (${t.preferUntilMs} IS NULL)`),
  ],
);
