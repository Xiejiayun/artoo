import { sql } from "drizzle-orm";
import { bigserial, check, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { organizations } from "./schema/identity.js";
import { projects, tasks } from "./schema/work.js";
import { messages } from "./schema/messaging.js";
import { ts } from "./schema/columns.js";

/** Locked source head. Task transitions never lock this table (source -> task order). */
export const taskEnqueueSources = pgTable(
  "task_enqueue_sources",
  {
    id: text("id").primaryKey(),
    version: integer("version").notNull().default(1),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    actorUserId: text("actor_user_id").notNull(),
    kind: text("kind").notNull(),
    sourceKey: text("source_key").notNull(),
    targetKey: text("target_key").notNull(),
    activeTaskId: text("active_task_id").references(() => tasks.id),
    intentDigest: text("intent_digest"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("task_enqueue_head_chk", sql`(${t.activeTaskId} IS NULL) = (${t.intentDigest} IS NULL)`),
    check("task_enqueue_source_v1_chk", sql`${t.version} = 1`),
  ],
);

/** Immutable replay identities; comment content lives only in moderated messages. */
export const taskEnqueueEvents = pgTable(
  "task_enqueue_events",
  {
    version: integer("version").notNull().default(1),
    sourceId: text("source_id")
      .notNull()
      .references(() => taskEnqueueSources.id),
    eventKey: text("event_key").notNull(),
    position: bigserial("position", { mode: "number" }).notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    requestDigest: text("request_digest").notNull(),
    messageId: text("message_id").references(() => messages.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("task_enqueue_event_v1_chk", sql`${t.version} = 1`),
    primaryKey({ columns: [t.sourceId, t.eventKey] }),
    index("task_enqueue_events_task_idx").on(t.taskId, t.position),
  ],
);
