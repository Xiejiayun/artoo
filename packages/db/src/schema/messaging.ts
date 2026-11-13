import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Foreign-key callbacks retain deferred resolution of the cross-domain tables.
import { goals, runs } from "../schema.js";
import { jsonbArray, jsonbObject, ts } from "./columns.js";
import { aiDataSharingConsents, organizations, users } from "./identity.js";
import { projects, tasks } from "./work.js";

export const rooms = pgTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").references(() => projects.id),
    taskId: text("task_id"),
    goalId: text("goal_id").references((): AnyPgColumn => goals.id),
    type: text("type").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [check("rooms_type_chk", sql`${t.type} in ('dm','project','sprint','task','agent_team','incident','goal')`)],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    position: bigserial("position", { mode: "number" }).notNull().unique(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id),
    taskId: text("task_id").references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    threadRootId: text("thread_root_id").references((): AnyPgColumn => messages.id),
    replyCount: integer("reply_count").notNull().default(0),
    clientRequestId: text("client_request_id"),
    clientRequestHash: text("client_request_hash"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    kind: text("kind").notNull(),
    body: text("body").notNull().default(""),
    payload: jsonbObject("payload"),
    moderatedAt: ts("moderated_at"),
    moderatedByUserId: text("moderated_by_user_id").references(() => users.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("messages_moderation_pair_chk", sql`(${t.moderatedAt} is null) = (${t.moderatedByUserId} is null)`),
    check("messages_actor_type_chk", sql`${t.actorType} in ('user','agent','system','bridge')`),
    index("messages_room_created_idx").on(t.roomId, t.createdAt),
    index("messages_org_task_created_idx").on(t.organizationId, t.taskId, t.createdAt, t.id),
    index("messages_room_position_idx").on(t.roomId, t.position),
    index("messages_thread_position_idx").on(t.threadRootId, t.position),
    index("messages_body_trgm_idx").using("gin", t.body.op("gin_trgm_ops")).where(sql`${t.moderatedAt} is null`),
    unique("messages_client_request_unique").on(t.organizationId, t.roomId, t.actorType, t.actorId, t.clientRequestId),
  ],
);

export const contentReports = pgTable(
  "content_reports",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    reporterUserId: text("reporter_user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    bodySnapshot: text("body_snapshot").notNull(),
    status: text("status").notNull().default("open"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id),
    resolutionNote: text("resolution_note"),
    createdAt: ts("created_at").notNull(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [
    uniqueIndex("content_reports_reporter_message_idx").on(t.organizationId, t.reporterUserId, t.messageId),
    check("content_reports_status_chk", sql`${t.status} in ('open','resolved','dismissed')`),
    index("content_reports_queue_idx").on(t.organizationId, t.status, t.createdAt, t.id),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    threadRootId: text("thread_root_id").references(() => messages.id),
    actorId: text("actor_id").notNull(),
    bodyPreview: text("body_preview").notNull(),
    readAt: ts("read_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("notifications_user_message_unique").on(t.userId, t.messageId),
    index("notifications_user_created_idx").on(t.organizationId, t.userId, t.createdAt, t.id),
    index("notifications_user_unread_idx").on(t.organizationId, t.userId).where(sql`${t.readAt} IS NULL`),
  ],
);

export const assistantTurns = pgTable(
  "assistant_turns",
  {
    id: text("id").primaryKey(),
    position: bigserial("position", { mode: "number" }).notNull().unique(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id),
    threadRootId: text("thread_root_id").references(() => messages.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    clientRequestId: text("client_request_id").notNull(),
    agentInstanceId: text("agent_instance_id"),
    userMessageId: text("user_message_id")
      .notNull()
      .references(() => messages.id),
    responseMessageId: text("response_message_id").references(() => messages.id),
    runId: text("run_id").references(() => runs.id),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    aiDataSharingConsentId: text("ai_data_sharing_consent_id").references(() => aiDataSharingConsents.id),
    aiDataSharingPolicyVersion: text("ai_data_sharing_policy_version"),
  },
  (t) => [
    unique("assistant_turns_request_unique").on(t.organizationId, t.roomId, t.actorUserId, t.clientRequestId),
    check(
      "assistant_turns_status_chk",
      sql`${t.status} in ('queued','waiting','running','completed','failed','cancelled')`,
    ),
    index("assistant_turns_room_position_idx").on(t.roomId, t.position),
    index("assistant_turns_status_idx").on(t.organizationId, t.status),
  ],
);

/** Absence is legacy/unknown delivery, never proof that a start was not sent. */
export const assistantRunDispatches = pgTable(
  "assistant_run_dispatches",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    turnId: text("turn_id")
      .notNull()
      .references(() => assistantTurns.id),
    version: integer("version").notNull().default(1),
    state: text("state").notNull(),
    createdAt: ts("created_at").notNull(),
    exposedAt: ts("exposed_at"),
  },
  (t) => [
    check("assistant_run_dispatches_version_chk", sql`${t.version} = 1`),
    check(
      "assistant_run_dispatches_state_chk",
      sql`(${t.state} = 'prepared' AND ${t.exposedAt} IS NULL) OR (${t.state} = 'exposed' AND ${t.exposedAt} IS NOT NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// V3 #114 — team discussion records (decision / handoff / blocker). First-class,
// auditable collaboration objects. `goal_id`/`plan_id` are nullable TEXT WITHOUT
// FK constraints for now (the canonical goals/plans tables land in #115/migration
// 0011); FK constraints are added in a later migration once both exist.
// ---------------------------------------------------------------------------
export const decisionRecords = pgTable(
  "decision_records",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id),
    taskId: text("task_id").references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    goalId: text("goal_id"),
    planId: text("plan_id"),
    sourceMessageId: text("source_message_id").references(() => messages.id),
    status: text("status").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    summary: text("summary").notNull(),
    rationale: text("rationale"),
    alternatives: jsonbArray("alternatives"),
    evidenceRefs: jsonbArray("evidence_refs"),
    impactSummary: text("impact_summary"),
    supersededById: text("superseded_by_id"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check("decision_records_status_chk", sql`${t.status} in ('proposed','accepted','rejected','superseded')`),
    check("decision_records_actor_type_chk", sql`${t.actorType} in ('user','agent','system','bridge')`),
    index("decision_records_room_idx").on(t.roomId),
    // Idempotent promotion: at most one decision per source message (NULLs unconstrained).
    unique("decision_records_source_message").on(t.sourceMessageId),
  ],
);

export const handoffs = pgTable(
  "handoffs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id),
    taskId: text("task_id").references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    goalId: text("goal_id"),
    planId: text("plan_id"),
    senderType: text("sender_type").notNull(),
    senderId: text("sender_id").notNull(),
    recipientType: text("recipient_type").notNull(),
    recipientId: text("recipient_id").notNull(),
    expectedAction: text("expected_action").notNull(),
    blockingCondition: text("blocking_condition"),
    priority: text("priority"),
    dueAt: ts("due_at"),
    status: text("status").notNull(),
    nextAction: text("next_action"),
    latestStatus: text("latest_status"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check("handoffs_status_chk", sql`${t.status} in ('open','accepted','completed','cancelled','expired')`),
    check("handoffs_sender_type_chk", sql`${t.senderType} in ('user','agent','system','bridge')`),
    check("handoffs_recipient_type_chk", sql`${t.recipientType} in ('user','agent','system','bridge')`),
    index("handoffs_room_idx").on(t.roomId),
    index("handoffs_recipient_idx").on(t.recipientType, t.recipientId),
  ],
);

export const blockers = pgTable(
  "blockers",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id),
    taskId: text("task_id").references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    goalId: text("goal_id"),
    planId: text("plan_id"),
    type: text("type").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    sourceKind: text("source_kind"),
    sourceId: text("source_id"),
    summary: text("summary").notNull(),
    mitigation: text("mitigation"),
    nextAction: text("next_action"),
    status: text("status").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check(
      "blockers_type_chk",
      sql`${t.type} in ('approval','dependency','lease_conflict','offline_agent','stale_runtime','policy','budget','failed_run','missing_artifact','human_input')`,
    ),
    check("blockers_status_chk", sql`${t.status} in ('open','mitigated','accepted_risk','resolved')`),
    index("blockers_room_idx").on(t.roomId),
    index("blockers_source_idx").on(t.sourceKind, t.sourceId),
  ],
);
