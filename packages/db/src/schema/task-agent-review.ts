import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, unique } from "drizzle-orm/pg-core";
import { agents, aiDataSharingConsents, organizations, users } from "./identity.js";
import { eventLog, runs } from "./execution.js";
import { messages } from "./messaging.js";
import { projects, tasks } from "./work.js";
import { ts } from "./columns.js";

export const taskAgentReviews = pgTable("task_agent_reviews", {
  id: text("id").primaryKey(), version: integer("version").notNull().default(1),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  sourceTaskId: text("source_task_id").notNull().references(() => tasks.id),
  sourceRunId: text("source_run_id").notNull().references(() => runs.id),
  sourceAgentId: text("source_agent_id").notNull().references(() => agents.id),
  reviewTaskId: text("review_task_id").notNull().references(() => tasks.id),
  reviewerAgentId: text("reviewer_agent_id").notNull().references(() => agents.id),
  artifacts: jsonb("artifacts").notNull(),
  sourceUpdatedAt: ts("source_updated_at").notNull(),
  sourceEventPosition: bigint("source_event_position", { mode: "number" }).notNull(),
  requestedByUserId: text("requested_by_user_id").notNull().references(() => users.id),
  aiDataSharingConsentId: text("ai_data_sharing_consent_id").references(() => aiDataSharingConsents.id),
  aiDataSharingPolicyVersion: text("ai_data_sharing_policy_version").notNull(),
  createdAt: ts("created_at").notNull(),
}, t => [
  unique("task_agent_reviews_task_uniq").on(t.reviewTaskId),
  unique("task_agent_reviews_subject_reviewer_uniq").on(t.organizationId, t.sourceRunId, t.reviewerAgentId),
  index("task_agent_reviews_source_idx").on(t.organizationId, t.sourceTaskId, t.createdAt, t.id),
  check("task_agent_reviews_scope_chk", sql`${t.version}=1 AND ${t.sourceTaskId}<>${t.reviewTaskId} AND ${t.sourceAgentId}<>${t.reviewerAgentId} AND ${t.sourceEventPosition}>0`),
  check("task_agent_reviews_artifacts_chk", sql`jsonb_typeof(${t.artifacts})='array' AND jsonb_array_length(${t.artifacts}) BETWEEN 1 AND 100`),
]);

export const taskAgentReviewFeedback = pgTable("task_agent_review_feedback", {
  reviewId: text("review_id").primaryKey().references(() => taskAgentReviews.id),
  reviewRunId: text("review_run_id").notNull().references(() => runs.id),
  reportMessageId: text("report_message_id").notNull().references(() => messages.id),
  reviewEventId: text("review_event_id").notNull().references(() => eventLog.id),
  requestedByUserId: text("requested_by_user_id").notNull().references(() => users.id),
  createdAt: ts("created_at").notNull(),
});
