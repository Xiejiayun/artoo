import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Cross-domain foreign keys keep their original deferred callbacks.
import { devices, discussions, goals, plans } from "../schema.js";
import { sourceCleanGenerations } from "../source-clean-restart-schema.js";
import { ts } from "./columns.js";
import { computers, agentInstances, runs, contextPacks, eventLog, runEvidence } from "./execution.js";
import { agents, aiDataSharingConsents, organizations, users } from "./identity.js";
import { assistantTurns } from "./messaging.js";
import { projects, tasks } from "./work.js";

/** Durable opt-in orchestration; actorUserId is the authorizer, not the audit actor. */
export const goalAutomations = pgTable(
  "goal_automations",
  {
    goalId: text("goal_id")
      .primaryKey()
      .references(() => goals.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    status: text("status").notNull(),
    discussionId: text("discussion_id").references(() => discussions.id),
    planId: text("plan_id").references(() => plans.id),
    agentInstanceId: text("agent_instance_id").references(() => agentInstances.id),
    computerId: text("computer_id").references(() => computers.id),
    workspaceRoot: text("workspace_root"),
    verificationProfileId: text("verification_profile_id").notNull(),
    executionMode: text("execution_mode").notNull().default("single_agent"),
    team: jsonb("team"),
    // An explicit grant on new goals only; historical fixed-computer goals retain SQL NULL.
    sourceHandoff: jsonb("source_handoff"),
    appDelivery: jsonb("app_delivery"),
    appPublication: jsonb("app_publication"),
    applicationPublicationAuthorizationEventId: text("application_publication_authorization_event_id").references(
      () => eventLog.id,
    ),
    // SQL NULL preserves unsampled historical planning; captured unknown scope is a versioned object.
    planningCapabilitySnapshot: jsonb("planning_capability_snapshot"),
    releaseProfileId: text("release_profile_id"),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check(
      "goal_automations_status_chk",
      sql`${t.status} in ('planning','executing','waiting','completed','failed','cancelled')`,
    ),
    index("goal_automations_status_idx").on(t.organizationId, t.status, t.createdAt),
    check("goal_automations_mode_chk", sql`${t.executionMode} in ('single_agent','agent_team')`),
    check(
      "goal_automations_app_publication_chk",
      sql`(${t.appPublication} IS NULL AND ${t.applicationPublicationAuthorizationEventId} IS NULL) OR
    (${t.appPublication} IS NOT NULL AND ${t.applicationPublicationAuthorizationEventId} IS NOT NULL AND ${t.executionMode} = 'agent_team'
      AND ${t.appDelivery} IS NULL AND ${t.sourceHandoff} IS NULL AND ${t.releaseProfileId} IS NULL
      AND ${t.appPublication} = jsonb_build_object('version',1,'kind','same-computer-local-application-publication',
        'publication_profile_id',${t.appPublication}->>'publication_profile_id')
      AND (${t.appPublication}->>'publication_profile_id') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') IS TRUE`,
    ),
    check(
      "goal_automations_app_delivery_chk",
      sql`${t.appDelivery} IS NULL OR
    (${t.executionMode} = 'agent_team' AND ${t.status} <> 'completed' AND ${t.sourceHandoff} IS NULL AND ${t.releaseProfileId} IS NULL
      AND ${t.appDelivery} = '{"version":1,"kind":"local-application-development"}'::jsonb) IS TRUE`,
    ),
    check(
      "goal_automations_source_handoff_chk",
      sql`${t.sourceHandoff} IS NULL OR
    (${t.executionMode} = 'agent_team' AND ${t.releaseProfileId} IS NOT NULL
      AND ${t.sourceHandoff} IN ('{"version":1,"mode":"automatic"}'::jsonb,
        '{"version":1,"mode":"automatic","research_revision":{"version":1,"strategy":"configured_pool"}}'::jsonb)) IS TRUE`,
    ),
    check(
      "goal_automations_planning_capability_snapshot_chk",
      sql`${t.planningCapabilitySnapshot} IS NULL OR
    (jsonb_typeof(${t.planningCapabilitySnapshot}) = 'object' AND ${t.planningCapabilitySnapshot} -> 'version' = '1'::jsonb) IS TRUE`,
    ),
  ],
);

/** Durable application publication projections. They do not reconstruct node-local permits or owners. */
export const applicationPublications = pgTable(
  "application_publications",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    publisherSessionId: text("publisher_session_id").notNull(),
    authorizationEventId: text("authorization_event_id")
      .notNull()
      .references(() => eventLog.id),
    request: jsonb("request").notNull(),
    requestDigest: text("request_digest").notNull(),
    status: text("status").notNull(),
    receipt: jsonb("receipt"),
    receiptDigest: text("receipt_digest"),
    receiptEventId: text("receipt_event_id").references(() => eventLog.id),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    unique("application_publications_goal_uniq").on(t.goalId),
    check("application_publications_status_chk", sql`${t.status} IN ('queued','published','failed')`),
    check(
      "application_publications_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${t.receiptDigest} IS NULL OR ${t.receiptDigest} ~ '^sha256:[a-f0-9]{64}$')`,
    ),
    check(
      "application_publications_receipt_chk",
      sql`(${t.status} = 'queued' AND ${t.receipt} IS NULL AND ${t.receiptDigest} IS NULL AND ${t.receiptEventId} IS NULL) OR
    (${t.status} IN ('published','failed') AND ${t.receipt} IS NOT NULL AND ${t.receiptDigest} IS NOT NULL AND ${t.receiptEventId} IS NOT NULL
      AND ${t.receipt}->>'outcome' = ${t.status}) IS TRUE`,
    ),
  ],
);
export const applicationPublicationObservations = pgTable(
  "application_publication_observations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    publicationId: text("publication_id")
      .notNull()
      .references(() => applicationPublications.id),
    publisherSessionId: text("publisher_session_id").notNull(),
    sequence: integer("sequence").notNull(),
    generation: integer("generation").notNull(),
    state: text("state").notNull(),
    requestDigest: text("request_digest").notNull(),
    payload: jsonb("payload").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => eventLog.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("application_publication_observation_sequence_uniq").on(t.publicationId, t.publisherSessionId, t.sequence),
    check("application_publication_observation_sequence_chk", sql`${t.sequence} >= 1 AND ${t.generation} = 2`),
    check(
      "application_publication_observation_state_chk",
      sql`${t.state} IN ('healthy','live','draining','closed-normal','closed-aborted','expired','unknown')`,
    ),
    check(
      "application_publication_observation_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.payloadDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);
/** Immutable historical completion; later runtime observations remain independent facts. */
export const applicationPublicationSettlements = pgTable(
  "application_publication_settlements",
  {
    goalId: text("goal_id")
      .primaryKey()
      .references(() => goals.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    publicationId: text("publication_id")
      .notNull()
      .references(() => applicationPublications.id),
    requestDigest: text("request_digest").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    authorizationEventId: text("authorization_event_id")
      .notNull()
      .references(() => eventLog.id),
    observationId: text("observation_id")
      .notNull()
      .references(() => applicationPublicationObservations.id),
    observationSequence: integer("observation_sequence").notNull(),
    leaseId: text("lease_id").notNull(),
    deadlineAt: ts("deadline_at").notNull(),
    scope: text("scope").notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => eventLog.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("application_publication_settlement_publication_uniq").on(t.publicationId),
    check(
      "application_publication_settlement_scope_chk",
      sql`${t.scope} = 'bounded-local-application-publication' AND ${t.observationSequence} >= 1`,
    ),
    check(
      "application_publication_settlement_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.receiptDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

/** One independent decision per immutable execution attempt, with a separate read-only run. */
export const autonomousReviews = pgTable(
  "autonomous_reviews",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    subjectRunId: text("subject_run_id")
      .notNull()
      .references(() => runs.id),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => runEvidence.id),
    subjectDigest: text("subject_digest").notNull(),
    reviewerInstanceId: text("reviewer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    reviewTaskId: text("review_task_id")
      .notNull()
      .references(() => tasks.id),
    turnId: text("turn_id")
      .notNull()
      .references(() => assistantTurns.id),
    status: text("status").notNull().default("pending"),
    verdict: jsonb("verdict"),
    error: text("error"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    unique("autonomous_reviews_subject_uniq").on(t.organizationId, t.subjectRunId),
    unique("autonomous_reviews_task_uniq").on(t.reviewTaskId),
    check(
      "autonomous_reviews_status_chk",
      sql`${t.status} in ('pending','accepted','changes_requested','failed','cancelled')`,
    ),
    index("autonomous_reviews_goal_idx").on(t.organizationId, t.goalId),
  ],
);

/** Durable target-product publication, distinct from Artoo distribution. */
export const productReleases = pgTable(
  "product_releases",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => runEvidence.id),
    status: text("status").notNull(),
    request: jsonb("request").notNull(),
    receipt: jsonb("receipt"),
    publicationGeneration: integer("publication_generation").notNull().default(0),
    rootReleaseId: text("root_release_id").references((): AnyPgColumn => productReleases.id),
    retryOfReleaseId: text("retry_of_release_id").references((): AnyPgColumn => productReleases.id),
    retryAuthorizationEventId: text("retry_authorization_event_id").references(() => eventLog.id),
    recoveryId: text("recovery_id").references((): AnyPgColumn => goalSourceRecoveryCheckpoints.recoveryId),
    recoveryOfReleaseId: text("recovery_of_release_id").references((): AnyPgColumn => productReleases.id),
    recoveryAuthorizationEventId: text("recovery_authorization_event_id").references(() => eventLog.id),
    interruptedRecoveryId: text("interrupted_recovery_id").references(
      (): AnyPgColumn => goalSourceRecoveryCheckpoints.recoveryId,
    ),
    cleanGenerationId: text("clean_generation_id").references((): AnyPgColumn => sourceCleanGenerations.id),
    cleanOfReleaseId: text("clean_of_release_id").references((): AnyPgColumn => productReleases.id),
    cleanAuthorizationEventId: text("clean_authorization_event_id").references(() => eventLog.id),
    interruptedCleanGenerationId: text("interrupted_clean_generation_id").references(
      (): AnyPgColumn => sourceCleanGenerations.id,
    ),
    interruptionEventId: text("interruption_event_id").references(() => eventLog.id),
    interruptionCheckpointDigest: text("interruption_checkpoint_digest"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    unique("product_releases_goal_generation_uniq").on(t.organizationId, t.goalId, t.publicationGeneration),
    unique("product_releases_retry_predecessor_uniq").on(t.retryOfReleaseId),
    unique("product_releases_recovery_predecessor_uniq").on(t.recoveryOfReleaseId),
    unique("product_releases_clean_predecessor_uniq").on(t.cleanOfReleaseId),
    uniqueIndex("product_releases_goal_queued_uniq").on(t.organizationId, t.goalId).where(sql`${t.status} = 'queued'`),
    check(
      "product_releases_lineage_chk",
      sql`(((${t.publicationGeneration} = 0 AND ${t.rootReleaseId} IS NULL AND ${t.retryOfReleaseId} IS NULL AND ${t.retryAuthorizationEventId} IS NULL)
    OR (${t.publicationGeneration} > 0 AND ${t.rootReleaseId} IS NOT NULL AND ${t.retryOfReleaseId} IS NOT NULL AND ${t.retryAuthorizationEventId} IS NOT NULL))
    AND ${t.recoveryId} IS NULL AND ${t.recoveryOfReleaseId} IS NULL AND ${t.recoveryAuthorizationEventId} IS NULL
    OR (${t.recoveryId} IS NOT NULL AND ${t.recoveryAuthorizationEventId} IS NOT NULL AND ${t.rootReleaseId} IS NULL AND ${t.retryOfReleaseId} IS NULL AND ${t.retryAuthorizationEventId} IS NULL
      AND ((${t.publicationGeneration} = 0 AND ${t.recoveryOfReleaseId} IS NULL) OR (${t.publicationGeneration} > 0 AND ${t.recoveryOfReleaseId} IS NOT NULL)))
    OR (${t.publicationGeneration} > 0 AND ${t.recoveryId} IS NOT NULL AND ${t.rootReleaseId} IS NOT NULL
      AND ${t.retryOfReleaseId} IS NOT NULL AND ${t.retryAuthorizationEventId} IS NOT NULL
      AND ${t.recoveryOfReleaseId} IS NULL AND ${t.recoveryAuthorizationEventId} IS NULL))
      AND ${t.cleanGenerationId} IS NULL AND ${t.cleanOfReleaseId} IS NULL AND ${t.cleanAuthorizationEventId} IS NULL
    OR (${t.cleanGenerationId} IS NOT NULL AND ${t.recoveryId} IS NULL AND ${t.recoveryOfReleaseId} IS NULL AND ${t.recoveryAuthorizationEventId} IS NULL AND (
      (${t.cleanAuthorizationEventId} IS NOT NULL AND ${t.rootReleaseId} IS NULL AND ${t.retryOfReleaseId} IS NULL AND ${t.retryAuthorizationEventId} IS NULL
        AND ((${t.publicationGeneration}=0 AND ${t.cleanOfReleaseId} IS NULL) OR (${t.publicationGeneration}>0 AND ${t.cleanOfReleaseId} IS NOT NULL)))
      OR (${t.publicationGeneration}>0 AND ${t.rootReleaseId} IS NOT NULL AND ${t.retryOfReleaseId} IS NOT NULL AND ${t.retryAuthorizationEventId} IS NOT NULL
        AND ${t.cleanOfReleaseId} IS NULL AND ${t.cleanAuthorizationEventId} IS NULL)))`,
    ),
    check(
      "product_releases_status_chk",
      sql`${t.status} in ('queued','published','rolled_back','failed','interrupted')`,
    ),
    check(
      "product_releases_interruption_chk",
      sql`(${t.status}='interrupted' AND ${t.receipt} IS NULL
    AND ((${t.interruptedRecoveryId} IS NOT NULL AND ${t.interruptedCleanGenerationId} IS NULL) OR (${t.interruptedRecoveryId} IS NULL AND ${t.interruptedCleanGenerationId} IS NOT NULL))
    AND ${t.interruptionEventId} IS NOT NULL AND ${t.interruptionCheckpointDigest} IS NOT NULL AND ${t.interruptionCheckpointDigest} ~ '^sha256:[a-f0-9]{64}$')
    OR (${t.status}<>'interrupted' AND ${t.interruptedRecoveryId} IS NULL AND ${t.interruptedCleanGenerationId} IS NULL AND ${t.interruptionEventId} IS NULL AND ${t.interruptionCheckpointDigest} IS NULL)`,
    ),
    index("product_releases_dispatch_idx").on(t.organizationId, t.status, t.createdAt),
  ],
);

/** Authenticated receipt provenance; executor-private retry authority cannot be reconstructed from this row. */
export const productReleaseRetrySources = pgTable(
  "product_release_retry_sources",
  {
    releaseId: text("release_id")
      .primaryKey()
      .references(() => productReleases.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    tokenLookup: text("token_lookup").notNull(),
    sessionId: text("session_id").notNull(),
    sourceId: text("source_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    projection: jsonb("projection").notNull(),
    receiptEventId: text("receipt_event_id")
      .notNull()
      .references(() => eventLog.id),
    receivedAt: ts("received_at").notNull(),
  },
  (t) => [
    unique("product_release_retry_source_uniq").on(t.computerId, t.sessionId, t.sourceId),
    check(
      "product_release_retry_source_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.receiptDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

/** Append-only observations; publication receipts remain immutable. */
export const productReleaseHealthReports = pgTable(
  "product_release_health_reports",
  {
    eventId: text("event_id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    releaseId: text("release_id")
      .notNull()
      .references(() => productReleases.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    version: integer("version").notNull(),
    sequence: integer("sequence").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: ts("received_at").notNull(),
  },
  (t) => [
    unique("product_release_health_sequence_uniq").on(t.organizationId, t.releaseId, t.sequence),
    check("product_release_health_version_chk", sql`${t.version} = 1`),
    check("product_release_health_sequence_chk", sql`${t.sequence} >= 1`),
  ],
);

/** Durable byte transport only; availability never authorizes destination execution. */
export const productSourceTransfers = pgTable(
  "product_source_transfers",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    sourceNodeId: text("source_node_id")
      .notNull()
      .references(() => computers.id),
    sourceRunId: text("source_run_id")
      .notNull()
      .references(() => runs.id),
    sourceEvidenceId: text("source_evidence_id")
      .notNull()
      .references(() => runEvidence.id),
    sourceReviewId: text("source_review_id")
      .notNull()
      .references(() => autonomousReviews.id),
    destinationNodeId: text("destination_node_id")
      .notNull()
      .references(() => computers.id),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    status: text("status").notNull().default("awaiting_upload"),
    uploadedByDeviceId: text("uploaded_by_device_id").references(() => devices.id),
    createdAt: ts("created_at").notNull(),
    availableAt: ts("available_at"),
  },
  (t) => [
    check("product_source_transfers_status_chk", sql`${t.status} in ('awaiting_upload','available')`),
    check("product_source_transfers_digest_chk", sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$'`),
    check("product_source_transfers_nodes_chk", sql`${t.sourceNodeId} <> ${t.destinationNodeId}`),
    check(
      "product_source_transfers_availability_chk",
      sql`(${t.status} = 'available') = (${t.availableAt} IS NOT NULL AND ${t.uploadedByDeviceId} IS NOT NULL)
    AND (${t.status} <> 'awaiting_upload' OR (${t.availableAt} IS NULL AND ${t.uploadedByDeviceId} IS NULL))`,
    ),
    check(
      "product_source_transfers_request_chk",
      sql`(jsonb_typeof(${t.request}) = 'object' AND ${t.request}->'version' = '1'::jsonb
    AND ${t.request}->>'kind' = 'product-source-transfer.v1' AND ${t.request}->>'transfer_id' = ${t.id}
    AND ${t.request}->>'organization_id' = ${t.organizationId} AND ${t.request}->>'project_id' = ${t.projectId}
    AND ${t.request}->>'goal_id' = ${t.goalId} AND ${t.request}->>'plan_id' = ${t.planId}
    AND ${t.request}->'authorization'->>'actor_user_id' = ${t.actorUserId}
    AND ${t.request}->'source'->>'node_id' = ${t.sourceNodeId} AND ${t.request}->'source'->>'run_id' = ${t.sourceRunId}
    AND ${t.request}->'source'->>'evidence_id' = ${t.sourceEvidenceId} AND ${t.request}->'source'->>'review_id' = ${t.sourceReviewId}
    AND ${t.request}->'destination'->>'node_id' = ${t.destinationNodeId}) IS TRUE`,
    ),
    index("product_source_transfers_goal_idx").on(t.organizationId, t.goalId, t.createdAt),
  ],
);

/** Immutable semantic envelope beside the original v1 byte request; never grants execution. */
export const productSourceSemanticTransfers = pgTable(
  "product_source_semantic_transfers",
  {
    id: text("id")
      .primaryKey()
      .references(() => productSourceTransfers.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    sourceExportEventId: text("source_export_event_id")
      .notNull()
      .references(() => eventLog.id),
    sourceExportDigest: text("source_export_digest").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check(
      "product_source_semantic_transfers_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.sourceExportDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "product_source_semantic_transfers_request_chk",
      sql`(jsonb_typeof(${t.request}) = 'object'
    AND ${t.request}->'version' = '2'::jsonb AND ${t.request}->>'kind' = 'product-source-transfer.v2'
    AND ${t.request}->'byte_request'->>'transfer_id' = ${t.id} AND ${t.request}->'byte_request'->>'organization_id' = ${t.organizationId}
    AND ${t.request}->'byte_request'->'version' = '1'::jsonb AND ${t.request}->'byte_request'->>'kind' = 'product-source-transfer.v1'
    AND ${t.request}->'source_export'->'version' = '2'::jsonb AND ${t.request}->>'source_export_digest' = ${t.sourceExportDigest}) IS TRUE`,
    ),
    index("product_source_semantic_transfers_org_idx").on(t.organizationId, t.createdAt),
  ],
);

/** Durable first-hop intent; a qualified receipt does not authorize review or writing. */
export const goalProductHandoffs = pgTable(
  "goal_product_handoffs",
  {
    id: text("id")
      .primaryKey()
      .references(() => productSourceSemanticTransfers.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    nextTaskId: text("next_task_id")
      .notNull()
      .references(() => tasks.id),
    sourceRunId: text("source_run_id")
      .notNull()
      .references(() => runs.id),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    intentDigest: text("intent_digest").notNull(),
    intent: jsonb("intent").notNull(),
    stopRequested: boolean("stop_requested").notNull().default(false),
    qualifiedReceipt: boolean("qualified_receipt").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    unique("goal_product_handoffs_source_next_uniq").on(
      t.organizationId,
      t.goalId,
      t.planId,
      t.sourceRunId,
      t.nextTaskId,
    ),
    check("goal_product_handoffs_intent_digest_chk", sql`${t.intentDigest} ~ '^sha256:[a-f0-9]{64}$'`),
    check(
      "goal_product_handoffs_intent_chk",
      sql`(${t.intent}->'version'='1'::jsonb AND ${t.intent}->>'next_task_id'=${t.nextTaskId} AND ${t.intent}->'request'->'byte_request'->>'transfer_id'=${t.id}) IS TRUE`,
    ),
  ],
);
export const goalProductHandoffOperations = pgTable(
  "goal_product_handoff_operations",
  {
    id: text("id").primaryKey(),
    handoffId: text("handoff_id")
      .notNull()
      .references(() => goalProductHandoffs.id),
    kind: text("kind").notNull(),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    payloadDigest: text("payload_digest").notNull(),
    payload: jsonb("payload").notNull(),
    result: jsonb("result"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_product_handoff_operation_kind_uniq").on(t.handoffId, t.kind),
    check("goal_product_handoff_operation_kind_chk", sql`${t.kind} IN ('upload','import_verify')`),
    check("goal_product_handoff_operation_digest_chk", sql`${t.payloadDigest} ~ '^sha256:[a-f0-9]{64}$'`),
    check(
      "goal_product_handoff_operation_payload_chk",
      sql`(${t.payload}->'version'='1'::jsonb AND ${t.payload}->>'operation_id'=${t.id} AND ${t.payload}->>'kind'=${t.kind}) IS TRUE`,
    ),
  ],
);
export const goalProductHandoffDeliveries = pgTable(
  "goal_product_handoff_deliveries",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => goalProductHandoffOperations.id),
    sessionId: text("session_id").notNull(),
    control: text("control").notNull(),
    ack: jsonb("ack"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_product_handoff_delivery_session_uniq").on(t.operationId, t.sessionId, t.control),
    check("goal_product_handoff_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`),
  ],
);

/** Dedicated imported-subject review history. These are not ordinary autonomous_reviews or run verification rows. */
export const goalImportedProductReviews = pgTable(
  "goal_imported_product_reviews",
  {
    id: text("id").primaryKey(),
    handoffId: text("handoff_id")
      .notNull()
      .references(() => goalProductHandoffs.id),
    operationId: text("operation_id")
      .notNull()
      .references(() => goalProductHandoffOperations.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    nextTaskId: text("next_task_id")
      .notNull()
      .references(() => tasks.id),
    sourceRunId: text("source_run_id")
      .notNull()
      .references(() => runs.id),
    sourceInstanceId: text("source_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    sourceAgentId: text("source_agent_id")
      .notNull()
      .references(() => agents.id),
    reviewerInstanceId: text("reviewer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    reviewerAgentId: text("reviewer_agent_id")
      .notNull()
      .references(() => agents.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    reviewRunId: text("review_run_id").notNull(),
    reviewTaskId: text("review_task_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_imported_reviews_handoff_uniq").on(t.handoffId),
    unique("goal_imported_reviews_run_uniq").on(t.reviewRunId),
    unique("goal_imported_reviews_task_uniq").on(t.reviewTaskId),
    check("goal_imported_reviews_digest_chk", sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$'`),
    check(
      "goal_imported_reviews_distinct_agent_chk",
      sql`${t.sourceAgentId} <> ${t.reviewerAgentId} AND ${t.sourceInstanceId} <> ${t.reviewerInstanceId}`,
    ),
    check(
      "goal_imported_reviews_request_chk",
      sql`(${t.request}->'version'='1'::jsonb AND ${t.request}->>'review_id'=${t.id} AND ${t.request}->'review_start'->>'run_id'=${t.reviewRunId} AND ${t.request}->'review_start'->>'task_id'=${t.reviewTaskId}) IS TRUE`,
    ),
    check(
      "goal_imported_reviews_result_chk",
      sql`${t.result} IS NULL OR (${t.result}->'version'='1'::jsonb AND ${t.result}->>'review_id'=${t.id} AND ${t.result}->>'request_digest'=${t.requestDigest} AND ${t.result}->'execution_authorized'='false'::jsonb AND ${t.result}->>'outcome' IN ('reviewed','failed','uncertain','cancelled_before_start') AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'<>'uncertain')) IS TRUE`,
    ),
  ],
);
export const goalImportedProductReviewDeliveries = pgTable(
  "goal_imported_product_review_deliveries",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => goalImportedProductReviews.id),
    sessionId: text("session_id").notNull(),
    control: text("control").notNull(),
    ack: jsonb("ack"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_imported_review_delivery_session_uniq").on(t.reviewId, t.sessionId, t.control),
    check("goal_imported_review_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`),
  ],
);

/** One admitted imported research review can reserve only this exact real design run. */
export const goalImportedDesignContinuations = pgTable(
  "goal_imported_design_continuations",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => goalImportedProductReviews.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    contextPackId: text("context_pack_id")
      .notNull()
      .references(() => contextPacks.id),
    writerInstanceId: text("writer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    writerAgentId: text("writer_agent_id")
      .notNull()
      .references(() => agents.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    workspaceRoot: text("workspace_root").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_imported_design_review_uniq").on(t.reviewId),
    unique("goal_imported_design_task_uniq").on(t.taskId),
    unique("goal_imported_design_run_uniq").on(t.runId),
    check("goal_imported_design_digest_chk", sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$'`),
    check(
      "goal_imported_design_request_chk",
      sql`(${t.request}->'version'='1'::jsonb AND ${t.request}->>'continuation_id'=${t.id}
    AND ${t.request}->'run_start'->>'run_id'=${t.runId} AND ${t.request}->'run_start'->>'task_id'=${t.taskId} AND ${t.request}->'run_start'->'context_pack'->>'id'=${t.contextPackId}
    AND ${t.request}->'run_start'->>'agent_instance_id'=${t.writerInstanceId} AND ${t.request}->'run_start'->'workspace'->>'root'=${t.workspaceRoot}) IS TRUE`,
    ),
    check(
      "goal_imported_design_result_chk",
      sql`${t.result} IS NULL OR (${t.result}->'version'='1'::jsonb AND ${t.result}->>'continuation_id'=${t.id}
    AND ${t.result}->>'request_digest'=${t.requestDigest} AND ${t.result}->>'run_id'=${t.runId} AND ${t.result}->>'outcome' IN ('finished','failed','uncertain','cancelled_before_start')
    AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'<>'uncertain')) IS TRUE`,
    ),
  ],
);
export const goalImportedDesignDeliveries = pgTable(
  "goal_imported_design_deliveries",
  {
    id: text("id").primaryKey(),
    continuationId: text("continuation_id")
      .notNull()
      .references(() => goalImportedDesignContinuations.id),
    sessionId: text("session_id").notNull(),
    control: text("control").notNull(),
    ack: jsonb("ack"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_imported_design_delivery_session_uniq").on(t.continuationId, t.sessionId, t.control),
    check("goal_imported_design_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`),
  ],
);

/** H3 completion provenance is created only with the original committed node result. */
export const goalImportedDesignCompletions = pgTable(
  "goal_imported_design_completions",
  {
    continuationId: text("continuation_id")
      .primaryKey()
      .references(() => goalImportedDesignContinuations.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => runEvidence.id),
    contextPackId: text("context_pack_id")
      .notNull()
      .references(() => contextPacks.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalImportedDesignDeliveries.id),
    sessionId: text("session_id").notNull(),
    resultDigest: text("result_digest").notNull(),
    completedDesignDigest: text("completed_design_digest").notNull(),
    verifiedDesign: jsonb("verified_design").notNull(),
    createdAt: ts("created_at").notNull(),
    receiptSentAt: ts("receipt_sent_at"),
  },
  (t) => [
    check(
      "goal_imported_design_completion_digest_chk",
      sql`${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.completedDesignDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

/** H4 reserves both participants at creation. A closed result is distinct from trusted acceptance. */
export const goalImportedDesignReviews = pgTable(
  "goal_imported_design_reviews",
  {
    id: text("id").primaryKey(),
    continuationId: text("continuation_id")
      .notNull()
      .references(() => goalImportedDesignCompletions.continuationId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    authorInstanceId: text("author_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    authorAgentId: text("author_agent_id")
      .notNull()
      .references(() => agents.id),
    reviewerInstanceId: text("reviewer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    reviewerAgentId: text("reviewer_agent_id")
      .notNull()
      .references(() => agents.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    workspaceRoot: text("workspace_root").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    resultDigest: text("result_digest"),
    resultDeliveryId: text("result_delivery_id").references((): AnyPgColumn => goalImportedDesignReviewDeliveries.id),
    resultSessionId: text("result_session_id"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    acceptedAt: ts("accepted_at"),
    acceptanceEventId: text("acceptance_event_id").references(() => eventLog.id),
  },
  (t) => [
    unique("goal_imported_design_reviews_continuation_uniq").on(t.continuationId),
    unique("goal_imported_design_reviews_task_uniq").on(t.taskId),
    check(
      "goal_imported_design_reviews_independent_chk",
      sql`${t.authorInstanceId} <> ${t.reviewerInstanceId} AND ${t.authorAgentId} <> ${t.reviewerAgentId}`,
    ),
    check(
      "goal_imported_design_reviews_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${t.resultDigest} IS NULL OR ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$')`,
    ),
    check(
      "goal_imported_design_reviews_result_chk",
      sql`(${t.result} IS NULL AND ${t.resultDigest} IS NULL AND ${t.resultDeliveryId} IS NULL AND ${t.resultSessionId} IS NULL)
    OR (${t.result} IS NOT NULL AND ${t.resultDigest} IS NOT NULL AND ${t.resultDeliveryId} IS NOT NULL AND ${t.resultSessionId} IS NOT NULL
      AND ${t.result}->'version'='1'::jsonb AND ${t.result}->>'review_id'=${t.id} AND ${t.result}->>'request_digest'=${t.requestDigest}
      AND ${t.result}->'execution_authorized'='false'::jsonb AND ${t.result}->>'outcome' IN ('reviewed','failed','uncertain','cancelled_before_start')
      AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'<>'uncertain')) IS TRUE`,
    ),
    check(
      "goal_imported_design_reviews_acceptance_chk",
      sql`(${t.acceptedAt} IS NULL AND ${t.acceptanceEventId} IS NULL) OR (${t.acceptedAt} IS NOT NULL AND ${t.acceptanceEventId} IS NOT NULL
    AND ${t.result}->>'outcome'='reviewed' AND ${t.result}->'verdict'->>'outcome'='accepted') IS TRUE`,
    ),
  ],
);
export const goalImportedDesignReviewDeliveries = pgTable(
  "goal_imported_design_review_deliveries",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => goalImportedDesignReviews.id),
    sessionId: text("session_id").notNull(),
    control: text("control").notNull(),
    ack: jsonb("ack"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_imported_design_review_delivery_session_uniq").on(t.reviewId, t.sessionId, t.control),
    check("goal_imported_design_review_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`),
  ],
);

/** Server send completion only. The node separately requires the actual accepted receipt. */
export const goalImportedDesignReviewReceipts = pgTable(
  "goal_imported_design_review_receipts",
  {
    reviewId: text("review_id")
      .primaryKey()
      .references(() => goalImportedDesignReviews.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalImportedDesignReviewDeliveries.id),
    sessionId: text("session_id").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultDigest: text("result_digest").notNull(),
    sentAt: ts("sent_at").notNull(),
  },
  (t) => [
    check(
      "goal_imported_design_review_receipts_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

/** H5 consumes accepted H4 once; its real run remains distinct from stage acceptance. */
export const goalImportedExecutions = pgTable(
  "goal_imported_executions",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => goalImportedDesignReviewReceipts.reviewId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    contextPackId: text("context_pack_id")
      .notNull()
      .references(() => contextPacks.id),
    writerInstanceId: text("writer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    writerAgentId: text("writer_agent_id")
      .notNull()
      .references(() => agents.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    workspaceRoot: text("workspace_root").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    acceptanceEventId: text("acceptance_event_id")
      .notNull()
      .references(() => eventLog.id),
    designEvidenceId: text("design_evidence_id")
      .notNull()
      .references(() => runEvidence.id),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    resultDigest: text("result_digest"),
    resultDeliveryId: text("result_delivery_id").references((): AnyPgColumn => goalImportedExecutionDeliveries.id),
    resultSessionId: text("result_session_id"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    reviewReadyAt: ts("review_ready_at"),
    reviewReadyEventId: text("review_ready_event_id").references(() => eventLog.id),
  },
  (t) => [
    unique("goal_imported_executions_review_uniq").on(t.reviewId),
    unique("goal_imported_executions_task_uniq").on(t.taskId),
    unique("goal_imported_executions_run_uniq").on(t.runId),
    check(
      "goal_imported_executions_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${t.resultDigest} IS NULL OR ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$')`,
    ),
    check(
      "goal_imported_executions_request_chk",
      sql`(${t.request}->'version'='1'::jsonb AND ${t.request}->>'stage'='implementation' AND ${t.request}->>'execution_id'=${t.id}
    AND ${t.request}->'run_start'->>'run_id'=${t.runId} AND ${t.request}->'run_start'->>'task_id'=${t.taskId} AND ${t.request}->>'acceptance_event_id'=${t.acceptanceEventId}
    AND ${t.request}->>'design_evidence_id'=${t.designEvidenceId} AND ${t.request}->'run_start'->'context_pack'->>'id'=${t.contextPackId}
    AND ${t.request}->'run_start'->>'agent_instance_id'=${t.writerInstanceId} AND ${t.request}->'run_start'->'workspace'->>'root'=${t.workspaceRoot}) IS TRUE`,
    ),
    check(
      "goal_imported_executions_result_chk",
      sql`(${t.result} IS NULL AND ${t.resultDigest} IS NULL AND ${t.resultDeliveryId} IS NULL AND ${t.resultSessionId} IS NULL)
    OR (${t.result} IS NOT NULL AND ${t.resultDigest} IS NOT NULL AND ${t.resultDeliveryId} IS NOT NULL AND ${t.resultSessionId} IS NOT NULL
      AND ${t.result}->'version'='1'::jsonb AND ${t.result}->>'execution_id'=${t.id} AND ${t.result}->>'request_digest'=${t.requestDigest} AND ${t.result}->>'run_id'=${t.runId}
      AND ${t.result}->>'outcome' IN ('finished','failed','uncertain','cancelled_before_start') AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'<>'uncertain')) IS TRUE`,
    ),
    check(
      "goal_imported_executions_ready_chk",
      sql`(${t.reviewReadyAt} IS NULL AND ${t.reviewReadyEventId} IS NULL) OR (${t.reviewReadyAt} IS NOT NULL AND ${t.reviewReadyEventId} IS NOT NULL
    AND ${t.result}->>'outcome'='finished' AND ${t.result}->'verified_execution'->'verification'->>'outcome'='passed') IS TRUE`,
    ),
  ],
);
export const goalImportedExecutionDeliveries = pgTable(
  "goal_imported_execution_deliveries",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => goalImportedExecutions.id),
    sessionId: text("session_id").notNull(),
    control: text("control").notNull(),
    ack: jsonb("ack"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_imported_execution_delivery_session_uniq").on(t.executionId, t.sessionId, t.control),
    check("goal_imported_execution_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`),
  ],
);
export const goalImportedExecutionCompletions = pgTable(
  "goal_imported_execution_completions",
  {
    executionId: text("execution_id")
      .primaryKey()
      .references(() => goalImportedExecutions.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => runEvidence.id),
    contextPackId: text("context_pack_id")
      .notNull()
      .references(() => contextPacks.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalImportedExecutionDeliveries.id),
    sessionId: text("session_id").notNull(),
    resultDigest: text("result_digest").notNull(),
    completedExecutionDigest: text("completed_execution_digest").notNull(),
    verifiedExecution: jsonb("verified_execution").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check(
      "goal_imported_execution_completion_digest_chk",
      sql`${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.completedExecutionDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

/** Immutable qualified revision intent; only a one-way accepted settlement can be added. */
export const productDesignRevisions = pgTable(
  "product_design_revisions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    designTaskId: text("design_task_id")
      .notNull()
      .references(() => tasks.id),
    requestingReviewId: text("requesting_review_id")
      .notNull()
      .references(() => autonomousReviews.id),
    authorInstanceId: text("author_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    workspaceRoot: text("workspace_root").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    sequence: integer("sequence").notNull(),
    intent: jsonb("intent").notNull(),
    state: text("state").notNull().default("active"),
    acceptedRunId: text("accepted_run_id").references(() => runs.id),
    acceptedEvidenceId: text("accepted_evidence_id").references(() => runEvidence.id),
    acceptedReviewId: text("accepted_review_id").references(() => autonomousReviews.id),
    createdAt: ts("created_at").notNull(),
    acceptedAt: ts("accepted_at"),
  },
  (t) => [
    unique("product_design_revision_request_uniq").on(t.organizationId, t.requestingReviewId),
    unique("product_design_revision_sequence_uniq").on(t.organizationId, t.goalId, t.sequence),
    uniqueIndex("product_design_revision_active_uniq").on(t.organizationId, t.goalId).where(sql`${t.state} = 'active'`),
    check("product_design_revisions_sequence_check", sql`${t.sequence} > 0`),
    check(
      "product_design_revision_intent_chk",
      sql`(${t.intent}->'version'='1'::jsonb AND ${t.intent}->>'revision_id'=${t.id}
    AND ${t.intent}->>'goal_id'=${t.goalId} AND ${t.intent}->>'plan_id'=${t.planId} AND ${t.intent}->>'project_id'=${t.projectId} AND ${t.intent}->>'computer_id'=${t.computerId}
    AND ${t.intent}->>'workspace_root'=${t.workspaceRoot} AND ${t.intent}->>'design_task_id'=${t.designTaskId} AND NOT ${t.intent} ? 'author_run_id'
    AND ${t.intent}->'requesting_review'->>'review_id'=${t.requestingReviewId}
    AND octet_length(${t.intent}->'baseline'->'design'->>'text') BETWEEN 1 AND 1048576
    AND octet_length(${t.intent}->'baseline'->'design'->>'text')=(${t.intent}->'baseline'->'design'->>'size')::integer) IS TRUE`,
    ),
    check(
      "product_design_revision_state_chk",
      sql`(${t.state}='active' AND ${t.acceptedRunId} IS NULL AND ${t.acceptedEvidenceId} IS NULL AND ${t.acceptedReviewId} IS NULL AND ${t.acceptedAt} IS NULL)
    OR (${t.state}='accepted' AND ${t.acceptedRunId} IS NOT NULL AND ${t.acceptedEvidenceId} IS NOT NULL AND ${t.acceptedReviewId} IS NOT NULL AND ${t.acceptedAt} IS NOT NULL)`,
    ),
  ],
);

/** Append-only per-attempt author binding. Reviewer runs retain the author's descriptor. */
export const productDesignRevisionRuns = pgTable(
  "product_design_revision_runs",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id),
    revisionId: text("revision_id")
      .notNull()
      .references(() => productDesignRevisions.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    contextPackId: text("context_pack_id")
      .notNull()
      .references(() => contextPacks.id),
    attempt: integer("attempt").notNull(),
    descriptorDigest: text("descriptor_digest").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("product_design_revision_attempt_uniq").on(t.revisionId, t.attempt),
    unique("product_design_revision_context_uniq").on(t.contextPackId),
    check("product_design_revision_runs_attempt_check", sql`${t.attempt} > 0`),
    check("product_design_revision_runs_descriptor_digest_check", sql`${t.descriptorDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);

/** H6 review and one-use repair. All retries consume the original goal counter. */
export const goalImportedExecutionReviews = pgTable(
  "goal_imported_execution_reviews",
  {
    id: text("id").primaryKey(),
    baseExecutionId: text("base_execution_id")
      .notNull()
      .references(() => goalImportedExecutionCompletions.executionId),
    sourceKind: text("source_kind").notNull(),
    sourceOperationId: text("source_operation_id").notNull(),
    sourceDigest: text("source_digest").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    authorInstanceId: text("author_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    authorAgentId: text("author_agent_id")
      .notNull()
      .references(() => agents.id),
    reviewerInstanceId: text("reviewer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    reviewerAgentId: text("reviewer_agent_id")
      .notNull()
      .references(() => agents.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    workspaceRoot: text("workspace_root").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    resultDigest: text("result_digest"),
    resultDeliveryId: text("result_delivery_id").references(
      (): AnyPgColumn => goalImportedExecutionReviewDeliveries.id,
    ),
    resultSessionId: text("result_session_id"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    acceptedAt: ts("accepted_at"),
    acceptanceEventId: text("acceptance_event_id").references(() => eventLog.id),
  },
  (t) => [
    unique("goal_imported_execution_reviews_source_uniq").on(t.baseExecutionId, t.sourceKind, t.sourceOperationId),
    check(
      "goal_imported_execution_reviews_source_chk",
      sql`${t.sourceKind} IN ('execution','repair') AND ${t.sourceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "goal_imported_execution_reviews_independent_chk",
      sql`${t.authorInstanceId} <> ${t.reviewerInstanceId} AND ${t.authorAgentId} <> ${t.reviewerAgentId}`,
    ),
    check(
      "goal_imported_execution_reviews_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${t.resultDigest} IS NULL OR ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$')`,
    ),
    check(
      "goal_imported_execution_reviews_result_chk",
      sql`(${t.result} IS NULL AND ${t.resultDigest} IS NULL AND ${t.resultDeliveryId} IS NULL AND ${t.resultSessionId} IS NULL)
    OR (${t.result} IS NOT NULL AND ${t.resultDigest} IS NOT NULL AND ${t.resultDeliveryId} IS NOT NULL AND ${t.resultSessionId} IS NOT NULL
      AND ${t.result}->'version'='1'::jsonb AND ${t.result}->>'review_id'=${t.id} AND ${t.result}->>'request_digest'=${t.requestDigest}
      AND ${t.result}->'execution_authorized'='false'::jsonb AND ${t.result}->>'outcome' IN ('reviewed','failed','uncertain','cancelled_before_start')
      AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'<>'uncertain')) IS TRUE`,
    ),
    check(
      "goal_imported_execution_reviews_acceptance_chk",
      sql`(${t.acceptedAt} IS NULL AND ${t.acceptanceEventId} IS NULL) OR (${t.acceptedAt} IS NOT NULL AND ${t.acceptanceEventId} IS NOT NULL
    AND ${t.result}->>'outcome'='reviewed' AND ${t.result}->'verdict'->>'outcome'='accepted') IS TRUE`,
    ),
  ],
);
export const goalImportedExecutionReviewDeliveries = pgTable(
  "goal_imported_execution_review_deliveries",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => goalImportedExecutionReviews.id),
    sessionId: text("session_id").notNull(),
    control: text("control").notNull(),
    ack: jsonb("ack"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_imported_execution_review_delivery_session_uniq").on(t.reviewId, t.sessionId, t.control),
    check("goal_imported_execution_review_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`),
  ],
);

/** Server send completion only. The node separately requires the actual accepted receipt. */
export const goalImportedExecutionReviewReceipts = pgTable(
  "goal_imported_execution_review_receipts",
  {
    reviewId: text("review_id")
      .primaryKey()
      .references(() => goalImportedExecutionReviews.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalImportedExecutionReviewDeliveries.id),
    sessionId: text("session_id").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultDigest: text("result_digest").notNull(),
    sentAt: ts("sent_at").notNull(),
  },
  (t) => [
    check(
      "goal_imported_execution_review_receipts_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

export const goalImportedExecutionRepairs = pgTable(
  "goal_imported_execution_repairs",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => goalImportedExecutionReviewReceipts.reviewId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    contextPackId: text("context_pack_id")
      .notNull()
      .references(() => contextPacks.id),
    writerInstanceId: text("writer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    writerAgentId: text("writer_agent_id")
      .notNull()
      .references(() => agents.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    workspaceRoot: text("workspace_root").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    authorizationEventId: text("authorization_event_id")
      .notNull()
      .references(() => eventLog.id),
    baseExecutionId: text("base_execution_id")
      .notNull()
      .references(() => goalImportedExecutions.id),
    attemptIndex: integer("attempt_index").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    resultDigest: text("result_digest"),
    resultDeliveryId: text("result_delivery_id").references(
      (): AnyPgColumn => goalImportedExecutionRepairDeliveries.id,
    ),
    resultSessionId: text("result_session_id"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    reviewReadyAt: ts("review_ready_at"),
    reviewReadyEventId: text("review_ready_event_id").references(() => eventLog.id),
  },
  (t) => [
    unique("goal_imported_execution_repairs_review_uniq").on(t.reviewId),
    unique("goal_imported_execution_repairs_attempt_uniq").on(t.goalId, t.attemptIndex),
    unique("goal_imported_execution_repairs_run_uniq").on(t.runId),
    check(
      "goal_imported_execution_repairs_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${t.resultDigest} IS NULL OR ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$')`,
    ),
    check(
      "goal_imported_execution_repairs_request_chk",
      sql`(${t.request}->'version'='1'::jsonb AND ${t.request}->>'repair_id'=${t.id}
    AND ${t.request}->'run_start'->>'run_id'=${t.runId} AND ${t.request}->'run_start'->>'task_id'=${t.taskId} AND ${t.request}->'authorization'->>'event_id'=${t.authorizationEventId}
    AND ${t.request}->'execution_request'->>'execution_id'=${t.baseExecutionId} AND ${t.attemptIndex}>0 AND (${t.request}->'authorization'->>'attempt_index')::integer=${t.attemptIndex} AND ${t.request}->'authorization'->>'goal_id'=${t.goalId} AND ${t.request}->'run_start'->'context_pack'->>'id'=${t.contextPackId}
    AND ${t.request}->'run_start'->>'agent_instance_id'=${t.writerInstanceId} AND ${t.request}->'run_start'->'workspace'->>'root'=${t.workspaceRoot}) IS TRUE`,
    ),
    check(
      "goal_imported_execution_repairs_result_chk",
      sql`(${t.result} IS NULL AND ${t.resultDigest} IS NULL AND ${t.resultDeliveryId} IS NULL AND ${t.resultSessionId} IS NULL)
    OR (${t.result} IS NOT NULL AND ${t.resultDigest} IS NOT NULL AND ${t.resultDeliveryId} IS NOT NULL AND ${t.resultSessionId} IS NOT NULL
      AND ${t.result}->'version'='1'::jsonb AND ${t.result}->>'repair_id'=${t.id} AND ${t.result}->>'request_digest'=${t.requestDigest} AND ${t.result}->>'run_id'=${t.runId}
      AND ${t.result}->>'outcome' IN ('finished','failed','uncertain','cancelled_before_start') AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'<>'uncertain')) IS TRUE`,
    ),
    check(
      "goal_imported_execution_repairs_ready_chk",
      sql`(${t.reviewReadyAt} IS NULL AND ${t.reviewReadyEventId} IS NULL) OR (${t.reviewReadyAt} IS NOT NULL AND ${t.reviewReadyEventId} IS NOT NULL
    AND ${t.result}->>'outcome'='finished' AND ${t.result}->'verified_repair'->'verification'->>'outcome'='passed') IS TRUE`,
    ),
  ],
);
export const goalImportedExecutionRepairDeliveries = pgTable(
  "goal_imported_execution_repair_deliveries",
  {
    id: text("id").primaryKey(),
    repairId: text("repair_id")
      .notNull()
      .references(() => goalImportedExecutionRepairs.id),
    sessionId: text("session_id").notNull(),
    control: text("control").notNull(),
    ack: jsonb("ack"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_imported_execution_repair_delivery_session_uniq").on(t.repairId, t.sessionId, t.control),
    check("goal_imported_execution_repair_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`),
  ],
);
export const goalImportedExecutionRepairCompletions = pgTable(
  "goal_imported_execution_repair_completions",
  {
    repairId: text("repair_id")
      .primaryKey()
      .references(() => goalImportedExecutionRepairs.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => runEvidence.id),
    contextPackId: text("context_pack_id")
      .notNull()
      .references(() => contextPacks.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalImportedExecutionRepairDeliveries.id),
    sessionId: text("session_id").notNull(),
    resultDigest: text("result_digest").notNull(),
    completedRepairDigest: text("completed_repair_digest").notNull(),
    verifiedRepair: jsonb("verified_repair").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check(
      "goal_imported_execution_repair_completion_digest_chk",
      sql`${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.completedRepairDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

/** Send-completion markers; receipt possession remains a separate node-local boundary. */
export const goalImportedExecutionReceipts = pgTable(
  "goal_imported_execution_receipts",
  {
    executionId: text("execution_id")
      .primaryKey()
      .references(() => goalImportedExecutions.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalImportedExecutionDeliveries.id),
    sessionId: text("session_id").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultDigest: text("result_digest").notNull(),
    sentAt: ts("sent_at").notNull(),
  },
  (t) => [
    check(
      "goal_imported_execution_receipts_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

export const goalImportedExecutionRepairReceipts = pgTable(
  "goal_imported_execution_repair_receipts",
  {
    repairId: text("repair_id")
      .primaryKey()
      .references(() => goalImportedExecutionRepairs.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalImportedExecutionRepairDeliveries.id),
    sessionId: text("session_id").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultDigest: text("result_digest").notNull(),
    sentAt: ts("sent_at").notNull(),
  },
  (t) => [
    check(
      "goal_imported_execution_repair_receipts_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

/** H7 author attempts retain H6 as immutable ancestry, with a new current product source. */
export const goalImportedValidations = pgTable(
  "goal_imported_validations",
  {
    id: text("id").primaryKey(),
    rootValidationId: text("root_validation_id")
      .notNull()
      .references((): AnyPgColumn => goalImportedValidations.id),
    originReviewId: text("origin_review_id")
      .notNull()
      .references(() => goalImportedExecutionReviews.id),
    parentValidationId: text("parent_validation_id").references((): AnyPgColumn => goalImportedValidations.id),
    kind: text("kind").notNull(),
    generation: integer("generation").notNull(),
    predecessorKind: text("predecessor_kind").notNull(),
    predecessorId: text("predecessor_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    contextPackId: text("context_pack_id")
      .notNull()
      .references(() => contextPacks.id),
    writerInstanceId: text("writer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    writerAgentId: text("writer_agent_id")
      .notNull()
      .references(() => agents.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    workspaceRoot: text("workspace_root").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    authorizationEventId: text("authorization_event_id")
      .notNull()
      .references(() => eventLog.id),
    attemptIndex: integer("attempt_index").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    initialSourceDigest: text("initial_source_digest").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    resultDigest: text("result_digest"),
    resultDeliveryId: text("result_delivery_id").references((): AnyPgColumn => goalImportedValidationDeliveries.id),
    resultSessionId: text("result_session_id"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    readyAt: ts("ready_at"),
    readyEventId: text("ready_event_id").references(() => eventLog.id),
    readyKind: text("ready_kind"),
  },
  (t) => [
    unique("goal_imported_validations_generation_uniq").on(t.rootValidationId, t.generation),
    unique("goal_imported_validations_predecessor_uniq").on(t.organizationId, t.predecessorKind, t.predecessorId),
    unique("goal_imported_validations_parent_uniq").on(t.parentValidationId),
    unique("goal_imported_validations_run_uniq").on(t.runId),
    unique("goal_imported_validations_task_generation_uniq").on(t.taskId, t.generation),
    check(
      "goal_imported_validations_lineage_chk",
      sql`(${t.kind}='initial' AND ${t.generation}=0 AND ${t.rootValidationId}=${t.id} AND ${t.parentValidationId} IS NULL AND ${t.predecessorKind}='initial' AND ${t.predecessorId}=${t.originReviewId})
    OR (${t.kind}='repair' AND ${t.generation}>0 AND ${t.rootValidationId}<>${t.id} AND ${t.parentValidationId} IS NOT NULL AND ${t.predecessorKind} IN ('review','failure'))`,
    ),
    check(
      "goal_imported_validations_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.initialSourceDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${t.resultDigest} IS NULL OR ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$')`,
    ),
    check(
      "goal_imported_validations_request_chk",
      sql`(${t.request}->'version'='1'::jsonb AND ${t.request}->>'validation_id'=${t.id} AND ${t.request}->>'root_validation_id'=${t.rootValidationId}
    AND (${t.request}->>'generation')::integer=${t.generation} AND ${t.request}->>'kind'=${t.kind} AND ${t.request}->'origin'->>'review_id'=${t.originReviewId}
    AND ${t.request}->'run_start'->>'run_id'=${t.runId} AND ${t.request}->'run_start'->>'task_id'=${t.taskId} AND ${t.request}->'run_start'->'context_pack'->>'id'=${t.contextPackId}
    AND ${t.request}->'run_start'->>'agent_instance_id'=${t.writerInstanceId} AND ${t.request}->'run_start'->'workspace'->>'root'=${t.workspaceRoot}
    AND ${t.request}->'authorization'->>'event_id'=${t.authorizationEventId} AND ${t.request}->'authorization'->>'goal_id'=${t.goalId}
    AND (${t.request}->'authorization'->>'attempt_index')::integer=${t.attemptIndex} AND ${t.attemptIndex}>=0) IS TRUE`,
    ),
    check(
      "goal_imported_validations_result_chk",
      sql`(${t.result} IS NULL AND ${t.resultDigest} IS NULL AND ${t.resultDeliveryId} IS NULL AND ${t.resultSessionId} IS NULL)
    OR (${t.result} IS NOT NULL AND ${t.resultDigest} IS NOT NULL AND ${t.resultDeliveryId} IS NOT NULL AND ${t.resultSessionId} IS NOT NULL
      AND ${t.result}->'version'='1'::jsonb AND ${t.result}->>'validation_id'=${t.id} AND ${t.result}->>'request_digest'=${t.requestDigest} AND ${t.result}->>'run_id'=${t.runId}
      AND ${t.result}->>'outcome' IN ('finished','failed','uncertain','cancelled_before_start') AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'<>'uncertain')) IS TRUE`,
    ),
    check(
      "goal_imported_validations_ready_chk",
      sql`(${t.readyAt} IS NULL AND ${t.readyEventId} IS NULL AND ${t.readyKind} IS NULL)
    OR (${t.readyAt} IS NOT NULL AND ${t.readyEventId} IS NOT NULL AND (${t.readyKind}='review' AND ${t.result}->>'outcome'='finished' AND ${t.result}->'verified_validation'->'verification'->>'outcome'='passed'
      OR ${t.readyKind}='repair' AND ${t.result}->>'outcome'='failed' AND ${t.result}->'closed_failure' IS NOT NULL)) IS TRUE`,
    ),
  ],
);
export const goalImportedValidationDeliveries = pgTable(
  "goal_imported_validation_deliveries",
  {
    id: text("id").primaryKey(),
    validationId: text("validation_id")
      .notNull()
      .references(() => goalImportedValidations.id),
    sessionId: text("session_id").notNull(),
    control: text("control").notNull(),
    ack: jsonb("ack"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_imported_validation_delivery_session_uniq").on(t.validationId, t.sessionId, t.control),
    check("goal_imported_validation_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`),
  ],
);
export const goalImportedValidationCompletions = pgTable(
  "goal_imported_validation_completions",
  {
    validationId: text("validation_id")
      .primaryKey()
      .references(() => goalImportedValidations.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    contextPackId: text("context_pack_id")
      .notNull()
      .references(() => contextPacks.id),
    evidenceId: text("evidence_id").references(() => runEvidence.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalImportedValidationDeliveries.id),
    sessionId: text("session_id").notNull(),
    outcome: text("outcome").notNull(),
    resultDigest: text("result_digest").notNull(),
    completionDigest: text("completion_digest").notNull(),
    completion: jsonb("completion").notNull(),
    sourceDigest: text("source_digest").notNull(),
    source: jsonb("source").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check(
      "goal_imported_validation_completion_outcome_chk",
      sql`${t.outcome} IN ('verified','closed-failure') AND (${t.outcome}<>'verified' OR ${t.evidenceId} IS NOT NULL)`,
    ),
    check(
      "goal_imported_validation_completion_digest_chk",
      sql`${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.completionDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.sourceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);
/** Records Server send completion; actual receipt possession remains a separate Node authority. */
export const goalImportedValidationReceipts = pgTable(
  "goal_imported_validation_receipts",
  {
    validationId: text("validation_id")
      .primaryKey()
      .references(() => goalImportedValidations.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalImportedValidationDeliveries.id),
    sessionId: text("session_id").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultDigest: text("result_digest").notNull(),
    sentAt: ts("sent_at").notNull(),
  },
  (t) => [
    check(
      "goal_imported_validation_receipt_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);
export const goalImportedValidationReviews = pgTable(
  "goal_imported_validation_reviews",
  {
    id: text("id").primaryKey(),
    validationId: text("validation_id")
      .notNull()
      .references(() => goalImportedValidationCompletions.validationId),
    retryOf: text("retry_of").references((): AnyPgColumn => goalImportedValidationReviews.id),
    sequence: integer("sequence").notNull(),
    sourceDigest: text("source_digest").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    authorInstanceId: text("author_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    authorAgentId: text("author_agent_id")
      .notNull()
      .references(() => agents.id),
    reviewerInstanceId: text("reviewer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    reviewerAgentId: text("reviewer_agent_id")
      .notNull()
      .references(() => agents.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    workspaceRoot: text("workspace_root").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    authorizationEventId: text("authorization_event_id")
      .notNull()
      .references(() => eventLog.id),
    attemptIndex: integer("attempt_index").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    resultDigest: text("result_digest"),
    resultDeliveryId: text("result_delivery_id").references(
      (): AnyPgColumn => goalImportedValidationReviewDeliveries.id,
    ),
    resultSessionId: text("result_session_id"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    acceptedAt: ts("accepted_at"),
    acceptanceEventId: text("acceptance_event_id").references(() => eventLog.id),
  },
  (t) => [
    unique("goal_imported_validation_review_sequence_uniq").on(t.validationId, t.sequence),
    unique("goal_imported_validation_review_retry_uniq").on(t.retryOf),
    check(
      "goal_imported_validation_review_independent_chk",
      sql`${t.authorInstanceId}<>${t.reviewerInstanceId} AND ${t.authorAgentId}<>${t.reviewerAgentId}`,
    ),
    check(
      "goal_imported_validation_review_sequence_chk",
      sql`${t.attemptIndex}>=0 AND ((${t.sequence}=0 AND ${t.retryOf} IS NULL) OR (${t.sequence}>0 AND ${t.retryOf} IS NOT NULL))`,
    ),
    check(
      "goal_imported_validation_review_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.sourceDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${t.resultDigest} IS NULL OR ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$')`,
    ),
    check(
      "goal_imported_validation_review_result_chk",
      sql`(${t.result} IS NULL AND ${t.resultDigest} IS NULL AND ${t.resultDeliveryId} IS NULL AND ${t.resultSessionId} IS NULL)
    OR (${t.result} IS NOT NULL AND ${t.resultDigest} IS NOT NULL AND ${t.resultDeliveryId} IS NOT NULL AND ${t.resultSessionId} IS NOT NULL AND ${t.result}->'version'='1'::jsonb
      AND ${t.result}->>'review_id'=${t.id} AND ${t.result}->>'request_digest'=${t.requestDigest} AND ${t.result}->'execution_authorized'='false'::jsonb
      AND ${t.result}->>'outcome' IN ('reviewed','failed','uncertain','cancelled_before_start') AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'<>'uncertain')) IS TRUE`,
    ),
    check(
      "goal_imported_validation_review_accepted_chk",
      sql`(${t.acceptedAt} IS NULL AND ${t.acceptanceEventId} IS NULL) OR (${t.acceptedAt} IS NOT NULL AND ${t.acceptanceEventId} IS NOT NULL
    AND ${t.result}->>'outcome'='reviewed' AND ${t.result}->'verdict'->>'outcome'='accepted') IS TRUE`,
    ),
  ],
);
export const goalImportedValidationReviewDeliveries = pgTable(
  "goal_imported_validation_review_deliveries",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => goalImportedValidationReviews.id),
    sessionId: text("session_id").notNull(),
    control: text("control").notNull(),
    ack: jsonb("ack"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_imported_validation_review_delivery_session_uniq").on(t.reviewId, t.sessionId, t.control),
    check("goal_imported_validation_review_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`),
  ],
);
export const goalImportedValidationReviewReceipts = pgTable(
  "goal_imported_validation_review_receipts",
  {
    reviewId: text("review_id")
      .primaryKey()
      .references(() => goalImportedValidationReviews.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalImportedValidationReviewDeliveries.id),
    sessionId: text("session_id").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultDigest: text("result_digest").notNull(),
    sentAt: ts("sent_at").notNull(),
  },
  (t) => [
    check(
      "goal_imported_validation_review_receipt_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);
/** An existing publisher request consumes precisely one independently accepted H7 final source. */
export const goalImportedValidationPublications = pgTable(
  "goal_imported_validation_publications",
  {
    releaseId: text("release_id")
      .primaryKey()
      .references(() => productReleases.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    validationId: text("validation_id")
      .notNull()
      .references(() => goalImportedValidationCompletions.validationId),
    reviewId: text("review_id")
      .notNull()
      .references(() => goalImportedValidationReviews.id),
    originReviewId: text("origin_review_id")
      .notNull()
      .references(() => goalImportedExecutionReviews.id),
    acceptanceEventId: text("acceptance_event_id")
      .notNull()
      .references(() => eventLog.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => runEvidence.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    sourceDigest: text("source_digest").notNull(),
    origin: jsonb("origin").notNull(),
    capabilities: jsonb("capabilities").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    index("goal_imported_validation_publication_goal_idx").on(t.organizationId, t.goalId),
    check("goal_imported_validation_publication_digest_chk", sql`${t.sourceDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);

/** H9 registration records historical identity, never a persisted native permit. */
export const nodeRecoveryRegistrations = pgTable(
  "node_recovery_registrations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    tokenLookup: text("token_lookup").notNull(),
    sessionId: text("session_id").notNull(),
    epochId: text("epoch_id").notNull(),
    generation: integer("generation").notNull(),
    guardianInstanceId: text("guardian_instance_id").notNull(),
    storeIdentityDigest: text("store_identity_digest").notNull(),
    configurationDigest: text("configuration_digest").notNull(),
    workspaceIdentityDigest: text("workspace_identity_digest").notNull(),
    workspaceRoot: text("workspace_root").notNull(),
    registrationDigest: text("registration_digest").notNull(),
    registration: jsonb("registration").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("node_recovery_epoch_uniq").on(t.organizationId, t.computerId, t.epochId),
    unique("node_recovery_generation_uniq").on(
      t.organizationId,
      t.computerId,
      t.guardianInstanceId,
      t.storeIdentityDigest,
      t.generation,
    ),
    check("node_recovery_registration_generation_chk", sql`${t.generation}>=0`),
    check(
      "node_recovery_registration_digest_chk",
      sql`${t.registrationDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.storeIdentityDigest} ~ '^sha256:[a-f0-9]{64}$'
    AND ${t.configurationDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.workspaceIdentityDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);
export const nodeRecoveryAvailabilities = pgTable(
  "node_recovery_availabilities",
  {
    id: text("id").primaryKey(),
    registrationId: text("registration_id")
      .notNull()
      .references(() => nodeRecoveryRegistrations.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    tokenLookup: text("token_lookup").notNull(),
    sessionId: text("session_id").notNull(),
    availabilityDigest: text("availability_digest").notNull(),
    availability: jsonb("availability").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("node_recovery_availability_uniq").on(t.registrationId, t.sessionId, t.availabilityDigest),
    check("node_recovery_availability_digest_chk", sql`${t.availabilityDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);
export const goalSourceRecoveries = pgTable(
  "goal_source_recoveries",
  {
    id: text("id").primaryKey(),
    registrationId: text("registration_id")
      .notNull()
      .references(() => nodeRecoveryRegistrations.id),
    availabilityId: text("availability_id")
      .notNull()
      .references(() => nodeRecoveryAvailabilities.id),
    originReviewId: text("origin_review_id")
      .notNull()
      .references(() => goalImportedExecutionReviews.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    authorizationEventId: text("authorization_event_id")
      .notNull()
      .references(() => eventLog.id),
    currentSessionId: text("current_session_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    resultDigest: text("result_digest"),
    resultDeliveryId: text("result_delivery_id").references((): AnyPgColumn => goalSourceRecoveryDeliveries.id),
    resultSessionId: text("result_session_id"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    settledAt: ts("settled_at"),
    settlementEventId: text("settlement_event_id").references(() => eventLog.id),
  },
  (t) => [
    unique("goal_source_recovery_registration_uniq").on(t.registrationId),
    check(
      "goal_source_recovery_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${t.resultDigest} IS NULL OR ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$')`,
    ),
    check(
      "goal_source_recovery_result_chk",
      sql`((${t.result} IS NULL AND ${t.resultDigest} IS NULL AND ${t.resultDeliveryId} IS NULL AND ${t.resultSessionId} IS NULL)
    OR (${t.result} IS NOT NULL AND ${t.resultDigest} IS NOT NULL AND ${t.resultDeliveryId} IS NOT NULL AND ${t.resultSessionId}=${t.currentSessionId}
      AND ${t.result}->'version'='1'::jsonb AND ${t.result}->>'recovery_id'=${t.id} AND ${t.result}->>'request_digest'=${t.requestDigest}
      AND ${t.result}->>'outcome' IN ('recovered','unknown') AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'='recovered'))) IS TRUE`,
    ),
    check(
      "goal_source_recovery_settled_chk",
      sql`((${t.settledAt} IS NULL AND ${t.settlementEventId} IS NULL) OR
    (${t.settledAt} IS NOT NULL AND ${t.settlementEventId} IS NOT NULL AND ${t.result}->>'outcome'='recovered')) IS TRUE`,
    ),
  ],
);
export const goalSourceRecoveryDeliveries = pgTable(
  "goal_source_recovery_deliveries",
  {
    id: text("id").primaryKey(),
    recoveryId: text("recovery_id")
      .notNull()
      .references(() => goalSourceRecoveries.id),
    sessionId: text("session_id").notNull(),
    control: text("control").notNull(),
    ack: jsonb("ack"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_source_recovery_delivery_uniq").on(t.recoveryId, t.sessionId, t.control),
    check("goal_source_recovery_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`),
  ],
);
export const goalSourceRecoveryCheckpoints = pgTable(
  "goal_source_recovery_checkpoints",
  {
    recoveryId: text("recovery_id")
      .primaryKey()
      .references(() => goalSourceRecoveries.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    registrationId: text("registration_id")
      .notNull()
      .references(() => nodeRecoveryRegistrations.id),
    oldEpochId: text("old_epoch_id").notNull(),
    newEpochId: text("new_epoch_id").notNull(),
    generation: integer("generation").notNull(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalSourceRecoveryDeliveries.id),
    sessionId: text("session_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultDigest: text("result_digest").notNull(),
    checkpointDigest: text("checkpoint_digest").notNull(),
    checkpoint: jsonb("checkpoint").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_source_recovery_old_epoch_uniq").on(t.registrationId, t.oldEpochId),
    unique("goal_source_recovery_new_epoch_uniq").on(t.newEpochId),
    check("goal_source_recovery_checkpoint_epoch_chk", sql`${t.oldEpochId}<>${t.newEpochId} AND ${t.generation}>0`),
    check(
      "goal_source_recovery_checkpoint_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.checkpointDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);
/** Exact old operations are settled without rewriting their original uncertain result. */
export const goalSourceRecoverySettlements = pgTable(
  "goal_source_recovery_settlements",
  {
    id: text("id").primaryKey(),
    recoveryId: text("recovery_id")
      .notNull()
      .references(() => goalSourceRecoveryCheckpoints.recoveryId),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    kind: text("kind").notNull(),
    operationId: text("operation_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    runId: text("run_id").references(() => runs.id),
    eventId: text("event_id")
      .notNull()
      .references(() => eventLog.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_source_recovery_operation_uniq").on(t.organizationId, t.kind, t.operationId),
    check(
      "goal_source_recovery_operation_kind_chk",
      sql`(${t.kind}='validation' AND ${t.runId} IS NOT NULL) OR (${t.kind} IN ('validation_review','release') AND ${t.runId} IS NULL)`,
    ),
    check("goal_source_recovery_operation_digest_chk", sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);
export const goalSourceRecoveryReceipts = pgTable(
  "goal_source_recovery_receipts",
  {
    recoveryId: text("recovery_id")
      .primaryKey()
      .references(() => goalSourceRecoveries.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalSourceRecoveryDeliveries.id),
    sessionId: text("session_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultDigest: text("result_digest").notNull(),
    sentAt: ts("sent_at").notNull(),
  },
  (t) => [
    check(
      "goal_source_recovery_receipt_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);

/** H9 author attempts retain H6 as immutable ancestry, with a new current product source. */
export const goalRecoveryValidations = pgTable(
  "goal_recovery_validations",
  {
    recoveryId: text("recovery_id")
      .notNull()
      .references(() => goalSourceRecoveryCheckpoints.recoveryId),
    id: text("id").primaryKey(),
    rootValidationId: text("root_validation_id")
      .notNull()
      .references((): AnyPgColumn => goalRecoveryValidations.id),
    originReviewId: text("origin_review_id")
      .notNull()
      .references(() => goalImportedExecutionReviews.id),
    parentValidationId: text("parent_validation_id").references((): AnyPgColumn => goalRecoveryValidations.id),
    kind: text("kind").notNull(),
    generation: integer("generation").notNull(),
    predecessorKind: text("predecessor_kind").notNull(),
    predecessorId: text("predecessor_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    contextPackId: text("context_pack_id")
      .notNull()
      .references(() => contextPacks.id),
    writerInstanceId: text("writer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    writerAgentId: text("writer_agent_id")
      .notNull()
      .references(() => agents.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    workspaceRoot: text("workspace_root").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    authorizationEventId: text("authorization_event_id")
      .notNull()
      .references(() => eventLog.id),
    attemptIndex: integer("attempt_index").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    initialSourceDigest: text("initial_source_digest").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    resultDigest: text("result_digest"),
    resultDeliveryId: text("result_delivery_id").references((): AnyPgColumn => goalRecoveryValidationDeliveries.id),
    resultSessionId: text("result_session_id"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    readyAt: ts("ready_at"),
    readyEventId: text("ready_event_id").references(() => eventLog.id),
    readyKind: text("ready_kind"),
  },
  (t) => [
    unique("goal_recovery_validations_generation_uniq").on(t.rootValidationId, t.generation),
    unique("goal_recovery_validations_predecessor_uniq").on(t.organizationId, t.predecessorKind, t.predecessorId),
    unique("goal_recovery_validations_parent_uniq").on(t.parentValidationId),
    unique("goal_recovery_validations_run_uniq").on(t.runId),
    unique("goal_recovery_validations_task_generation_uniq").on(t.taskId, t.generation),
    check(
      "goal_recovery_validations_lineage_chk",
      sql`(${t.kind}='initial' AND ${t.generation}=0 AND ${t.rootValidationId}=${t.id} AND ${t.parentValidationId} IS NULL AND ${t.predecessorKind}='initial' AND ${t.predecessorId}=${t.recoveryId})
    OR (${t.kind}='repair' AND ${t.generation}>0 AND ${t.rootValidationId}<>${t.id} AND ${t.parentValidationId} IS NOT NULL AND ${t.predecessorKind} IN ('review','failure'))`,
    ),
    check(
      "goal_recovery_validations_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.initialSourceDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${t.resultDigest} IS NULL OR ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$')`,
    ),
    check(
      "goal_recovery_validations_request_chk",
      sql`(${t.request}->'version'='1'::jsonb AND ${t.request}->>'validation_id'=${t.id} AND ${t.request}->>'root_validation_id'=${t.rootValidationId}
    AND (${t.request}->>'generation')::integer=${t.generation} AND ${t.request}->>'kind'=${t.kind} AND ${t.request}->'origin'->>'review_id'=${t.originReviewId}
    AND ${t.request}->'run_start'->>'run_id'=${t.runId} AND ${t.request}->'run_start'->>'task_id'=${t.taskId} AND ${t.request}->'run_start'->'context_pack'->>'id'=${t.contextPackId}
    AND ${t.request}->'run_start'->>'agent_instance_id'=${t.writerInstanceId} AND ${t.request}->'run_start'->'workspace'->>'root'=${t.workspaceRoot}
    AND ${t.request}->'authorization'->>'event_id'=${t.authorizationEventId} AND ${t.request}->'authorization'->>'goal_id'=${t.goalId}
    AND (${t.request}->'authorization'->>'attempt_index')::integer=${t.attemptIndex} AND ${t.attemptIndex}>=0) IS TRUE`,
    ),
    check(
      "goal_recovery_validations_result_chk",
      sql`(${t.result} IS NULL AND ${t.resultDigest} IS NULL AND ${t.resultDeliveryId} IS NULL AND ${t.resultSessionId} IS NULL)
    OR (${t.result} IS NOT NULL AND ${t.resultDigest} IS NOT NULL AND ${t.resultDeliveryId} IS NOT NULL AND ${t.resultSessionId} IS NOT NULL
      AND ${t.result}->'version'='1'::jsonb AND ${t.result}->>'validation_id'=${t.id} AND ${t.result}->>'request_digest'=${t.requestDigest} AND ${t.result}->>'run_id'=${t.runId}
      AND ${t.result}->>'outcome' IN ('finished','failed','uncertain','cancelled_before_start') AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'<>'uncertain')) IS TRUE`,
    ),
    check(
      "goal_recovery_validations_ready_chk",
      sql`(${t.readyAt} IS NULL AND ${t.readyEventId} IS NULL AND ${t.readyKind} IS NULL)
    OR (${t.readyAt} IS NOT NULL AND ${t.readyEventId} IS NOT NULL AND (${t.readyKind}='review' AND ${t.result}->>'outcome'='finished' AND ${t.result}->'verified_validation'->'verification'->>'outcome'='passed'
      OR ${t.readyKind}='repair' AND ${t.result}->>'outcome'='failed' AND ${t.result}->'closed_failure' IS NOT NULL)) IS TRUE`,
    ),
  ],
);
export const goalRecoveryValidationDeliveries = pgTable(
  "goal_recovery_validation_deliveries",
  {
    id: text("id").primaryKey(),
    validationId: text("validation_id")
      .notNull()
      .references(() => goalRecoveryValidations.id),
    sessionId: text("session_id").notNull(),
    control: text("control").notNull(),
    ack: jsonb("ack"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_recovery_validation_delivery_session_uniq").on(t.validationId, t.sessionId, t.control),
    check("goal_recovery_validation_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`),
  ],
);
export const goalRecoveryValidationCompletions = pgTable(
  "goal_recovery_validation_completions",
  {
    validationId: text("validation_id")
      .primaryKey()
      .references(() => goalRecoveryValidations.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    contextPackId: text("context_pack_id")
      .notNull()
      .references(() => contextPacks.id),
    evidenceId: text("evidence_id").references(() => runEvidence.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalRecoveryValidationDeliveries.id),
    sessionId: text("session_id").notNull(),
    outcome: text("outcome").notNull(),
    resultDigest: text("result_digest").notNull(),
    completionDigest: text("completion_digest").notNull(),
    completion: jsonb("completion").notNull(),
    sourceDigest: text("source_digest").notNull(),
    source: jsonb("source").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check(
      "goal_recovery_validation_completion_outcome_chk",
      sql`${t.outcome} IN ('verified','closed-failure') AND (${t.outcome}<>'verified' OR ${t.evidenceId} IS NOT NULL)`,
    ),
    check(
      "goal_recovery_validation_completion_digest_chk",
      sql`${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.completionDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.sourceDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);
/** Records Server send completion; actual receipt possession remains a separate Node authority. */
export const goalRecoveryValidationReceipts = pgTable(
  "goal_recovery_validation_receipts",
  {
    validationId: text("validation_id")
      .primaryKey()
      .references(() => goalRecoveryValidations.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalRecoveryValidationDeliveries.id),
    sessionId: text("session_id").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultDigest: text("result_digest").notNull(),
    sentAt: ts("sent_at").notNull(),
  },
  (t) => [
    check(
      "goal_recovery_validation_receipt_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);
export const goalRecoveryValidationReviews = pgTable(
  "goal_recovery_validation_reviews",
  {
    recoveryId: text("recovery_id")
      .notNull()
      .references(() => goalSourceRecoveryCheckpoints.recoveryId),
    id: text("id").primaryKey(),
    validationId: text("validation_id")
      .notNull()
      .references(() => goalRecoveryValidationCompletions.validationId),
    retryOf: text("retry_of").references((): AnyPgColumn => goalRecoveryValidationReviews.id),
    sequence: integer("sequence").notNull(),
    sourceDigest: text("source_digest").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    authorInstanceId: text("author_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    authorAgentId: text("author_agent_id")
      .notNull()
      .references(() => agents.id),
    reviewerInstanceId: text("reviewer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    reviewerAgentId: text("reviewer_agent_id")
      .notNull()
      .references(() => agents.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    workspaceRoot: text("workspace_root").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    authorizationEventId: text("authorization_event_id")
      .notNull()
      .references(() => eventLog.id),
    attemptIndex: integer("attempt_index").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request").notNull(),
    result: jsonb("result"),
    resultDigest: text("result_digest"),
    resultDeliveryId: text("result_delivery_id").references(
      (): AnyPgColumn => goalRecoveryValidationReviewDeliveries.id,
    ),
    resultSessionId: text("result_session_id"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    acceptedAt: ts("accepted_at"),
    acceptanceEventId: text("acceptance_event_id").references(() => eventLog.id),
  },
  (t) => [
    unique("goal_recovery_validation_review_sequence_uniq").on(t.validationId, t.sequence),
    unique("goal_recovery_validation_review_retry_uniq").on(t.retryOf),
    check(
      "goal_recovery_validation_review_independent_chk",
      sql`${t.authorInstanceId}<>${t.reviewerInstanceId} AND ${t.authorAgentId}<>${t.reviewerAgentId}`,
    ),
    check(
      "goal_recovery_validation_review_sequence_chk",
      sql`${t.attemptIndex}>=0 AND ((${t.sequence}=0 AND ${t.retryOf} IS NULL) OR (${t.sequence}>0 AND ${t.retryOf} IS NOT NULL))`,
    ),
    check(
      "goal_recovery_validation_review_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.sourceDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${t.resultDigest} IS NULL OR ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$')`,
    ),
    check(
      "goal_recovery_validation_review_result_chk",
      sql`(${t.result} IS NULL AND ${t.resultDigest} IS NULL AND ${t.resultDeliveryId} IS NULL AND ${t.resultSessionId} IS NULL)
    OR (${t.result} IS NOT NULL AND ${t.resultDigest} IS NOT NULL AND ${t.resultDeliveryId} IS NOT NULL AND ${t.resultSessionId} IS NOT NULL AND ${t.result}->'version'='1'::jsonb
      AND ${t.result}->>'review_id'=${t.id} AND ${t.result}->>'request_digest'=${t.requestDigest} AND ${t.result}->'execution_authorized'='false'::jsonb
      AND ${t.result}->>'outcome' IN ('reviewed','failed','uncertain','cancelled_before_start') AND ${t.result}->'closed'=to_jsonb(${t.result}->>'outcome'<>'uncertain')) IS TRUE`,
    ),
    check(
      "goal_recovery_validation_review_accepted_chk",
      sql`(${t.acceptedAt} IS NULL AND ${t.acceptanceEventId} IS NULL) OR (${t.acceptedAt} IS NOT NULL AND ${t.acceptanceEventId} IS NOT NULL
    AND ${t.result}->>'outcome'='reviewed' AND ${t.result}->'verdict'->>'outcome'='accepted') IS TRUE`,
    ),
  ],
);
export const goalRecoveryValidationReviewDeliveries = pgTable(
  "goal_recovery_validation_review_deliveries",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => goalRecoveryValidationReviews.id),
    sessionId: text("session_id").notNull(),
    control: text("control").notNull(),
    ack: jsonb("ack"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("goal_recovery_validation_review_delivery_session_uniq").on(t.reviewId, t.sessionId, t.control),
    check("goal_recovery_validation_review_delivery_control_chk", sql`${t.control} IN ('start','stop','status')`),
  ],
);
export const goalRecoveryValidationReviewReceipts = pgTable(
  "goal_recovery_validation_review_receipts",
  {
    reviewId: text("review_id")
      .primaryKey()
      .references(() => goalRecoveryValidationReviews.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => goalRecoveryValidationReviewDeliveries.id),
    sessionId: text("session_id").notNull(),
    sessionBindings: jsonb("session_bindings").notNull(),
    requestDigest: text("request_digest").notNull(),
    resultDigest: text("result_digest").notNull(),
    sentAt: ts("sent_at").notNull(),
  },
  (t) => [
    check(
      "goal_recovery_validation_review_receipt_digest_chk",
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.resultDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
  ],
);
/** An existing publisher request consumes precisely one independently accepted H9 final source. */
export const goalRecoveryValidationPublications = pgTable(
  "goal_recovery_validation_publications",
  {
    recoveryId: text("recovery_id")
      .notNull()
      .references(() => goalSourceRecoveryCheckpoints.recoveryId),
    releaseId: text("release_id")
      .primaryKey()
      .references(() => productReleases.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    validationId: text("validation_id")
      .notNull()
      .references(() => goalRecoveryValidationCompletions.validationId),
    reviewId: text("review_id")
      .notNull()
      .references(() => goalRecoveryValidationReviews.id),
    originReviewId: text("origin_review_id")
      .notNull()
      .references(() => goalImportedExecutionReviews.id),
    acceptanceEventId: text("acceptance_event_id")
      .notNull()
      .references(() => eventLog.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => runEvidence.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    sourceDigest: text("source_digest").notNull(),
    origin: jsonb("origin").notNull(),
    capabilities: jsonb("capabilities").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    index("goal_recovery_validation_publication_goal_idx").on(t.organizationId, t.goalId),
    check("goal_recovery_validation_publication_digest_chk", sql`${t.sourceDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);

/** Fixed, node-local scopes reserved before the first imported research attempt. */
export const goalResearchDestinationPools = pgTable(
  "goal_research_destination_pools",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    nextTaskId: text("next_task_id")
      .notNull()
      .references(() => tasks.id),
    baseResearchTaskId: text("base_research_task_id")
      .notNull()
      .references(() => tasks.id),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    sourceComputerId: text("source_computer_id")
      .notNull()
      .references(() => computers.id),
    sourceWorkspaceRoot: text("source_workspace_root").notNull(),
    maxRetries: integer("max_retries").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    currentRevisionId: text("current_revision_id").references((): AnyPgColumn => goalResearchRevisions.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("research_destination_pool_goal_next_uniq").on(t.organizationId, t.goalId, t.planId, t.nextTaskId),
    check("research_destination_pool_budget_chk", sql`${t.maxRetries} BETWEEN 0 AND 10`),
    check("research_destination_pool_digest_chk", sql`${t.snapshotDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);

/** A reservation remains after failure or closure. No ordinary assignment may borrow an unused slot. */
export const goalResearchDestinationSlots = pgTable(
  "goal_research_destination_slots",
  {
    id: text("id").primaryKey(),
    poolId: text("pool_id")
      .notNull()
      .references(() => goalResearchDestinationPools.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    slotIndex: integer("slot_index").notNull(),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    workspaceRoot: text("workspace_root").notNull(),
    workspaceKey: text("workspace_key").notNull(),
    mappingDigest: text("mapping_digest").notNull(),
    descriptor: jsonb("descriptor").notNull(),
    writerInstanceId: text("writer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    reviewerInstanceId: text("reviewer_instance_id")
      .notNull()
      .references(() => agentInstances.id),
    status: text("status").notNull().default("reserved"),
    handoffId: text("handoff_id").references(() => goalProductHandoffs.id),
    revisionId: text("revision_id").references((): AnyPgColumn => goalResearchRevisions.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("research_destination_slot_index_uniq").on(t.poolId, t.slotIndex),
    unique("research_destination_slot_root_uniq").on(t.organizationId, t.computerId, t.workspaceKey),
    unique("research_destination_slot_handoff_uniq").on(t.handoffId),
    unique("research_destination_slot_revision_uniq").on(t.revisionId),
    check(
      "research_destination_slot_state_chk",
      sql`${t.status} IN ('reserved','consumed','uncertain') AND ${t.slotIndex} BETWEEN 0 AND 10`,
    ),
    check("research_destination_slot_digest_chk", sql`${t.mappingDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);

/** Append-only successor authority; original accepted research tasks and capsules are never rewritten. */
export const goalResearchRevisions = pgTable(
  "goal_research_revisions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    nextTaskId: text("next_task_id")
      .notNull()
      .references(() => tasks.id),
    baseResearchTaskId: text("base_research_task_id")
      .notNull()
      .references(() => tasks.id),
    auxiliaryTaskId: text("auxiliary_task_id")
      .notNull()
      .references(() => tasks.id),
    parentReviewId: text("parent_review_id")
      .notNull()
      .references(() => goalImportedProductReviews.id),
    predecessorRevisionId: text("predecessor_revision_id").references((): AnyPgColumn => goalResearchRevisions.id),
    poolId: text("pool_id")
      .notNull()
      .references(() => goalResearchDestinationPools.id),
    slotId: text("slot_id")
      .notNull()
      .references(() => goalResearchDestinationSlots.id),
    generation: integer("generation").notNull(),
    attemptIndex: integer("attempt_index").notNull(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    consentId: text("consent_id").references(() => aiDataSharingConsents.id),
    policyVersion: text("policy_version").notNull(),
    authorizationEventId: text("authorization_event_id")
      .notNull()
      .references(() => eventLog.id),
    intentDigest: text("intent_digest").notNull(),
    intent: jsonb("intent").notNull(),
    handoffId: text("handoff_id").references(() => goalProductHandoffs.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("research_revision_parent_uniq").on(t.parentReviewId),
    unique("research_revision_auxiliary_uniq").on(t.auxiliaryTaskId),
    unique("research_revision_slot_uniq").on(t.slotId),
    unique("research_revision_handoff_uniq").on(t.handoffId),
    unique("research_revision_attempt_uniq").on(t.organizationId, t.goalId, t.attemptIndex),
    unique("research_revision_generation_uniq").on(t.poolId, t.generation),
    check(
      "research_revision_generation_chk",
      sql`${t.generation} BETWEEN 1 AND 10 AND ${t.attemptIndex} >= ${t.generation}`,
    ),
    check("research_revision_digest_chk", sql`${t.intentDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);
