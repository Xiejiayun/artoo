import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, type AnyPgColumn } from "drizzle-orm/pg-core";
import { organizations, goals, plans, tasks, runs, contextPacks, agents, agentInstances, computers, users, aiDataSharingConsents,
  eventLog, runEvidence, productReleases, goalImportedExecutionReviews } from "./schema.js";
import { sourceCleanGenerations } from "./source-clean-restart-schema.js";
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
export const goalCleanValidations = pgTable("goal_clean_validations", {
  cleanGenerationId: text("clean_generation_id").notNull().references(() => sourceCleanGenerations.id),
  id: text("id").primaryKey(), rootValidationId: text("root_validation_id").notNull().references((): AnyPgColumn => goalCleanValidations.id),
  originReviewId: text("origin_review_id").notNull().references(() => goalImportedExecutionReviews.id),
  parentValidationId: text("parent_validation_id").references((): AnyPgColumn => goalCleanValidations.id),
  kind: text("kind").notNull(), generation: integer("generation").notNull(), predecessorKind: text("predecessor_kind").notNull(), predecessorId: text("predecessor_id").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizations.id), goalId: text("goal_id").notNull().references(() => goals.id),
  planId: text("plan_id").notNull().references(() => plans.id), taskId: text("task_id").notNull().references(() => tasks.id),
  runId: text("run_id").notNull().references(() => runs.id), contextPackId: text("context_pack_id").notNull().references(() => contextPacks.id),
  writerInstanceId: text("writer_instance_id").notNull().references(() => agentInstances.id), writerAgentId: text("writer_agent_id").notNull().references(() => agents.id),
  computerId: text("computer_id").notNull().references(() => computers.id), workspaceRoot: text("workspace_root").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => users.id), consentId: text("consent_id").references(() => aiDataSharingConsents.id), policyVersion: text("policy_version").notNull(),
  authorizationEventId: text("authorization_event_id").notNull().references(() => eventLog.id), attemptIndex: integer("attempt_index").notNull(),
  sessionBindings: jsonb("session_bindings").notNull(), initialSourceDigest: text("initial_source_digest").notNull(), requestDigest: text("request_digest").notNull(), request: jsonb("request").notNull(),
  result: jsonb("result"), resultDigest: text("result_digest"), resultDeliveryId: text("result_delivery_id").references((): AnyPgColumn => goalCleanValidationDeliveries.id), resultSessionId: text("result_session_id"),
  stopRequested: boolean("stop_requested").notNull().default(false), createdAt: ts("created_at").notNull(),
  readyAt: ts("ready_at"), readyEventId: text("ready_event_id").references(() => eventLog.id), readyKind: text("ready_kind"),
}, t => [unique("goal_clean_validations_generation_uniq").on(t.rootValidationId, t.generation),
  unique("goal_clean_validations_predecessor_uniq").on(t.organizationId, t.predecessorKind, t.predecessorId),
  unique("goal_clean_validations_parent_uniq").on(t.parentValidationId), unique("goal_clean_validations_run_uniq").on(t.runId),
  unique("goal_clean_validations_task_generation_uniq").on(t.taskId, t.generation),
  check("goal_clean_validations_lineage_chk", sql`(${t.kind}='initial' AND ${t.generation}=0 AND ${t.rootValidationId}=${t.id} AND ${t.parentValidationId} IS NULL AND ${t.predecessorKind}='initial' AND ${t.predecessorId}=${t.cleanGenerationId})
    OR (${t.kind}='repair' AND ${t.generation}>0 AND ${t.rootValidationId}<>${t.id} AND ${t.parentValidationId} IS NOT NULL AND ${t.predecessorKind} IN ('review','failure'))`),
  check("goal_clean_validations_digest_chk", sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.initialSourceDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${t.resultDigest} IS NULL OR ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$')`),
  check("goal_clean_validations_request_chk", sql`(${t.request}->'version'='1'::jsonb AND ${t.request}->>'validation_id'=${t.id} AND ${t.request}->>'root_validation_id'=${t.rootValidationId}
    AND (${t.request}->>'generation')::integer=${t.generation} AND ${t.request}->>'kind'=${t.kind} AND ${t.request}->'origin'->>'review_id'=${t.originReviewId}
    AND ${t.request}->'run_start'->>'run_id'=${t.runId} AND ${t.request}->'run_start'->>'task_id'=${t.taskId} AND ${t.request}->'run_start'->'context_pack'->>'id'=${t.contextPackId}
    AND ${t.request}->'run_start'->>'agent_instance_id'=${t.writerInstanceId} AND ${t.request}->'run_start'->'workspace'->>'root'=${t.workspaceRoot}
    AND ${t.request}->'authorization'->>'event_id'=${t.authorizationEventId} AND ${t.request}->'authorization'->>'goal_id'=${t.goalId}
    AND (${t.request}->'authorization'->>'attempt_index')::integer=${t.attemptIndex} AND ${t.attemptIndex}>=0) IS TRUE`),
  check("goal_clean_validations_result_chk", sql`(${t.result} IS NULL AND ${t.resultDigest} IS NULL AND ${t.resultDeliveryId} IS NULL AND ${t.resultSessionId} IS NULL)
    OR (${t.result} IS NOT NULL AND ${t.resultDigest} IS NOT NULL AND ${t.resultDeliveryId} IS NOT NULL AND ${t.resultSessionId} IS NOT NULL
      AND ${t.result}->'version'='1'::jsonb AND ${t.result}->>'validation_id'=${t.id} AND ${t.result}->>'request_digest'=${t.requestDigest} AND ${t.result}->>'run_id'=${t.runId}
      AND ${t.result}->>'outcome' IN ('finished','failed','uncertain','cancelled_before_start') AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'<>'uncertain')) IS TRUE`),
  check("goal_clean_validations_ready_chk", sql`(${t.readyAt} IS NULL AND ${t.readyEventId} IS NULL AND ${t.readyKind} IS NULL)
    OR (${t.readyAt} IS NOT NULL AND ${t.readyEventId} IS NOT NULL AND (${t.readyKind}='review' AND ${t.result}->>'outcome'='finished' AND ${t.result}->'verified_validation'->'verification'->>'outcome'='passed'
      OR ${t.readyKind}='repair' AND ${t.result}->>'outcome'='failed' AND ${t.result}->'closed_failure' IS NOT NULL)) IS TRUE`),
]);
export const goalCleanValidationDeliveries = pgTable("goal_clean_validation_deliveries", {
  id: text("id").primaryKey(), validationId: text("validation_id").notNull().references(() => goalCleanValidations.id), sessionId: text("session_id").notNull(),
  control: text("control").notNull(), ack: jsonb("ack"), createdAt: ts("created_at").notNull(),
}, t => [unique("goal_clean_validation_delivery_session_uniq").on(t.validationId, t.sessionId, t.control), check("goal_clean_validation_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`)]);
export const goalCleanValidationCompletions = pgTable("goal_clean_validation_completions", {
  validationId: text("validation_id").primaryKey().references(() => goalCleanValidations.id), organizationId: text("organization_id").notNull().references(() => organizations.id),
  runId: text("run_id").notNull().references(() => runs.id), contextPackId: text("context_pack_id").notNull().references(() => contextPacks.id), evidenceId: text("evidence_id").references(() => runEvidence.id),
  deliveryId: text("delivery_id").notNull().references(() => goalCleanValidationDeliveries.id), sessionId: text("session_id").notNull(), outcome: text("outcome").notNull(),
  resultDigest: text("result_digest").notNull(), completionDigest: text("completion_digest").notNull(), completion: jsonb("completion").notNull(),
  sourceDigest: text("source_digest").notNull(), source: jsonb("source").notNull(), createdAt: ts("created_at").notNull(),
}, t => [check("goal_clean_validation_completion_outcome_chk", sql`${t.outcome} IN ('verified','closed-failure') AND (${t.outcome}<>'verified' OR ${t.evidenceId} IS NOT NULL)`),
  check("goal_clean_validation_completion_digest_chk", sql`${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.completionDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.sourceDigest} ~ '^sha256:[a-f0-9]{64}$'`)]);
/** Records Server send completion; actual receipt possession remains a separate Node authority. */
export const goalCleanValidationReceipts = pgTable("goal_clean_validation_receipts", {
  validationId: text("validation_id").primaryKey().references(() => goalCleanValidations.id), organizationId: text("organization_id").notNull().references(() => organizations.id),
  deliveryId: text("delivery_id").notNull().references(() => goalCleanValidationDeliveries.id), sessionId: text("session_id").notNull(), sessionBindings: jsonb("session_bindings").notNull(),
  requestDigest: text("request_digest").notNull(), resultDigest: text("result_digest").notNull(), sentAt: ts("sent_at").notNull(),
}, t => [check("goal_clean_validation_receipt_digest_chk", sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$'`)]);
export const goalCleanValidationReviews = pgTable("goal_clean_validation_reviews", {
  cleanGenerationId: text("clean_generation_id").notNull().references(() => sourceCleanGenerations.id),
  id: text("id").primaryKey(), validationId: text("validation_id").notNull().references(() => goalCleanValidationCompletions.validationId),
  retryOf: text("retry_of").references((): AnyPgColumn => goalCleanValidationReviews.id), sequence: integer("sequence").notNull(),
  sourceDigest: text("source_digest").notNull(), organizationId: text("organization_id").notNull().references(() => organizations.id),
  goalId: text("goal_id").notNull().references(() => goals.id), planId: text("plan_id").notNull().references(() => plans.id), taskId: text("task_id").notNull().references(() => tasks.id),
  authorInstanceId: text("author_instance_id").notNull().references(() => agentInstances.id), authorAgentId: text("author_agent_id").notNull().references(() => agents.id),
  reviewerInstanceId: text("reviewer_instance_id").notNull().references(() => agentInstances.id), reviewerAgentId: text("reviewer_agent_id").notNull().references(() => agents.id),
  computerId: text("computer_id").notNull().references(() => computers.id), workspaceRoot: text("workspace_root").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => users.id), consentId: text("consent_id").references(() => aiDataSharingConsents.id), policyVersion: text("policy_version").notNull(),
  authorizationEventId: text("authorization_event_id").notNull().references(() => eventLog.id), attemptIndex: integer("attempt_index").notNull(),
  sessionBindings: jsonb("session_bindings").notNull(), requestDigest: text("request_digest").notNull(), request: jsonb("request").notNull(),
  result: jsonb("result"), resultDigest: text("result_digest"), resultDeliveryId: text("result_delivery_id").references((): AnyPgColumn => goalCleanValidationReviewDeliveries.id), resultSessionId: text("result_session_id"),
  stopRequested: boolean("stop_requested").notNull().default(false), createdAt: ts("created_at").notNull(), acceptedAt: ts("accepted_at"), acceptanceEventId: text("acceptance_event_id").references(() => eventLog.id),
}, t => [unique("goal_clean_validation_review_sequence_uniq").on(t.validationId, t.sequence), unique("goal_clean_validation_review_retry_uniq").on(t.retryOf),
  check("goal_clean_validation_review_independent_chk", sql`${t.authorInstanceId}<>${t.reviewerInstanceId} AND ${t.authorAgentId}<>${t.reviewerAgentId}`),
  check("goal_clean_validation_review_sequence_chk", sql`${t.attemptIndex}>=0 AND ((${t.sequence}=0 AND ${t.retryOf} IS NULL) OR (${t.sequence}>0 AND ${t.retryOf} IS NOT NULL))`),
  check("goal_clean_validation_review_digest_chk", sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.sourceDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${t.resultDigest} IS NULL OR ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$')`),
  check("goal_clean_validation_review_result_chk", sql`(${t.result} IS NULL AND ${t.resultDigest} IS NULL AND ${t.resultDeliveryId} IS NULL AND ${t.resultSessionId} IS NULL)
    OR (${t.result} IS NOT NULL AND ${t.resultDigest} IS NOT NULL AND ${t.resultDeliveryId} IS NOT NULL AND ${t.resultSessionId} IS NOT NULL AND ${t.result}->'version'='1'::jsonb
      AND ${t.result}->>'review_id'=${t.id} AND ${t.result}->>'request_digest'=${t.requestDigest} AND ${t.result}->'execution_authorized'='false'::jsonb
      AND ${t.result}->>'outcome' IN ('reviewed','failed','uncertain','cancelled_before_start') AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'<>'uncertain')) IS TRUE`),
  check("goal_clean_validation_review_accepted_chk", sql`(${t.acceptedAt} IS NULL AND ${t.acceptanceEventId} IS NULL) OR (${t.acceptedAt} IS NOT NULL AND ${t.acceptanceEventId} IS NOT NULL
    AND ${t.result}->>'outcome'='reviewed' AND ${t.result}->'verdict'->>'outcome'='accepted') IS TRUE`),
]);
export const goalCleanValidationReviewDeliveries = pgTable("goal_clean_validation_review_deliveries", {
  id: text("id").primaryKey(), reviewId: text("review_id").notNull().references(() => goalCleanValidationReviews.id), sessionId: text("session_id").notNull(),
  control: text("control").notNull(), ack: jsonb("ack"), createdAt: ts("created_at").notNull(),
}, t => [unique("goal_clean_validation_review_delivery_session_uniq").on(t.reviewId, t.sessionId, t.control), check("goal_clean_validation_review_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`)]);
export const goalCleanValidationReviewReceipts = pgTable("goal_clean_validation_review_receipts", {
  reviewId: text("review_id").primaryKey().references(() => goalCleanValidationReviews.id), organizationId: text("organization_id").notNull().references(() => organizations.id),
  deliveryId: text("delivery_id").notNull().references(() => goalCleanValidationReviewDeliveries.id), sessionId: text("session_id").notNull(), sessionBindings: jsonb("session_bindings").notNull(),
  requestDigest: text("request_digest").notNull(), resultDigest: text("result_digest").notNull(), sentAt: ts("sent_at").notNull(),
}, t => [check("goal_clean_validation_review_receipt_digest_chk", sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$'`)]);
/** An existing publisher request consumes precisely one independently accepted clean-restart final source. */
export const goalCleanValidationPublications = pgTable("goal_clean_validation_publications", {
  cleanGenerationId: text("clean_generation_id").notNull().references(() => sourceCleanGenerations.id),
  releaseId: text("release_id").primaryKey().references(() => productReleases.id), organizationId: text("organization_id").notNull().references(() => organizations.id),
  goalId: text("goal_id").notNull().references(() => goals.id), planId: text("plan_id").notNull().references(() => plans.id),
  validationId: text("validation_id").notNull().references(() => goalCleanValidationCompletions.validationId), reviewId: text("review_id").notNull().references(() => goalCleanValidationReviews.id),
  originReviewId: text("origin_review_id").notNull().references(() => goalImportedExecutionReviews.id), acceptanceEventId: text("acceptance_event_id").notNull().references(() => eventLog.id),
  runId: text("run_id").notNull().references(() => runs.id), evidenceId: text("evidence_id").notNull().references(() => runEvidence.id), computerId: text("computer_id").notNull().references(() => computers.id),
  sourceDigest: text("source_digest").notNull(), origin: jsonb("origin").notNull(), capabilities: jsonb("capabilities").notNull(), createdAt: ts("created_at").notNull(),
}, t => [index("goal_clean_validation_publication_goal_idx").on(t.organizationId, t.goalId),
  check("goal_clean_validation_publication_digest_chk", sql`${t.sourceDigest} ~ '^sha256:[a-f0-9]{64}$'`)]);
