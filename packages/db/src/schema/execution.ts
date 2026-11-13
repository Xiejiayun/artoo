import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

import { jsonbArray, jsonbObject, ts } from "./columns.js";
import { agents, aiDataSharingConsents, organizations, users } from "./identity.js";
import { projects, tasks } from "./work.js";

export const modelProfiles = pgTable(
  "model_profiles",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    contextWindow: integer("context_window"),
    costTier: text("cost_tier").notNull(),
    latencyTier: text("latency_tier").notNull(),
    capabilityTags: jsonbArray("capability_tags"),
    config: jsonbObject("config"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("model_profiles_cost_tier_chk", sql`${t.costTier} in ('low','medium','high','premium')`),
    check("model_profiles_latency_tier_chk", sql`${t.latencyTier} in ('fast','normal','slow')`),
    unique("model_profiles_org_name").on(t.organizationId, t.name),
    index("model_profiles_lookup_idx").on(t.organizationId, t.enabled, t.costTier),
  ],
);

export const effortProfiles = pgTable(
  "effort_profiles",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    effort: text("effort").notNull(),
    maxRuntimeMinutes: integer("max_runtime_minutes").notNull(),
    maxCostUsd: numeric("max_cost_usd", { precision: 10, scale: 2 }),
    maxToolCalls: integer("max_tool_calls"),
    retryBudget: integer("retry_budget").notNull().default(0),
    description: text("description").notNull().default(""),
    config: jsonbObject("config"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("effort_profiles_effort_chk", sql`${t.effort} in ('low','medium','high','max')`),
    unique("effort_profiles_org_name").on(t.organizationId, t.name),
    index("effort_profiles_lookup_idx").on(t.organizationId, t.enabled, t.effort),
  ],
);

export const computers = pgTable(
  "computers",
  {
    id: text("id").primaryKey(),
    deletedAt: ts("deleted_at"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    displayName: text("display_name").notNull(),
    hostname: text("hostname").notNull(),
    os: text("os").notNull(),
    arch: text("arch").notNull(),
    status: text("status").notNull(),
    lastHeartbeatAt: ts("last_heartbeat_at"),
    resources: jsonbObject("resources"),
    capabilities: jsonbArray("capabilities"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("computers_status_chk", sql`${t.status} in ('enrolling','online','offline','disabled')`),
    index("computers_status_heartbeat_idx").on(t.status, t.lastHeartbeatAt),
  ],
);

export const agentRuntimes = pgTable(
  "agent_runtimes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    runtime: text("runtime").notNull(),
    version: text("version"),
    status: text("status").notNull(),
    capabilities: jsonbArray("capabilities"),
    lastSeenAt: ts("last_seen_at"),
    metadata: jsonbObject("metadata"),
  },
  (t) => [
    check("agent_runtimes_status_chk", sql`${t.status} in ('detected','available','missing','disabled')`),
    unique("agent_runtimes_computer_runtime").on(t.computerId, t.runtime),
  ],
);

export const agentInstances = pgTable(
  "agent_instances",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id),
    deletedAt: ts("deleted_at"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    computerId: text("computer_id")
      .notNull()
      .references(() => computers.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    runtime: text("runtime").notNull(),
    modelProfileId: text("model_profile_id").references(() => modelProfiles.id),
    effortProfileId: text("effort_profile_id").references(() => effortProfiles.id),
    status: text("status").notNull(),
    workspaceRoot: text("workspace_root"),
    config: jsonbObject("config"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("agent_instances_status_chk", sql`${t.status} in ('idle','queued','running','stopping','failed','disabled')`),
    index("agent_instances_status_computer_idx").on(t.status, t.computerId),
    index("agent_instances_org_project_idx").on(t.organizationId, t.projectId),
    index("agent_instances_profiles_idx").on(t.modelProfileId, t.effortProfileId, t.status),
  ],
);

export const skillInstalls = pgTable(
  "skill_installs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").references(() => projects.id),
    skillId: text("skill_id").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    manifest: jsonb("manifest").notNull(),
    capabilities: jsonbArray("capabilities"),
    compatibleRuntimes: jsonbArray("compatible_runtimes"),
    permissionSummary: jsonbObject("permission_summary"),
    installedByType: text("installed_by_type").notNull(),
    installedById: text("installed_by_id").notNull(),
    installedAt: ts("installed_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check("skill_installs_installed_by_type_chk", sql`${t.installedByType} in ('user','agent','system')`),
    index("skill_installs_org_enabled_idx").on(t.organizationId, t.enabled),
    index("skill_installs_project_enabled_idx").on(t.projectId, t.enabled),
    index("skill_installs_skill_idx").on(t.organizationId, t.skillId),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    computerId: text("computer_id").notNull(),
    agentInstanceId: text("agent_instance_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    schedulerDecisionId: text("scheduler_decision_id"),
    modelProfileId: text("model_profile_id").references(() => modelProfiles.id),
    effortProfileId: text("effort_profile_id").references(() => effortProfiles.id),
    status: text("status").notNull(),
    contextPackId: text("context_pack_id"),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
    failureReason: text("failure_reason"),
    sequence: bigint("sequence", { mode: "number" }).notNull().default(0),
    workspaceRoot: text("workspace_root"),
    workspaceBranch: text("workspace_branch"),
    workspaceAllocation: jsonb("workspace_allocation"),
    verificationRequirement: jsonb("verification_requirement"),
    /** Complete immutable versioned owned-result assignment; SQL NULL preserves ordinary mode. */
    ownedResultAssignment: jsonb("owned_result_assignment"),
    createdAt: ts("created_at").notNull(),
    requestedByUserId: text("requested_by_user_id").references(() => users.id),
    aiDataSharingConsentId: text("ai_data_sharing_consent_id").references(() => aiDataSharingConsents.id),
    aiDataSharingPolicyVersion: text("ai_data_sharing_policy_version"),
  },
  (t) => [
    check(
      "runs_status_chk",
      sql`${t.status} in ('queued','starting','running','awaiting_input','paused','completed','failed','cancelled')`,
    ),
    index("runs_task_status_created_idx").on(t.taskId, t.status, t.createdAt),
    index("runs_agent_history_idx").on(t.organizationId, t.agentInstanceId, t.createdAt.desc(), t.id.desc()),
    index("runs_org_task_created_idx").on(t.organizationId, t.taskId, t.createdAt.desc(), t.id.desc()),
    index("runs_org_active_idx")
      .on(t.organizationId, t.computerId, t.agentInstanceId)
      .where(sql`${t.status} not in ('completed', 'failed', 'cancelled')`),
    check(
      "runs_owned_result_assignment_chk",
      sql`${t.ownedResultAssignment} IS NULL OR
    (jsonb_typeof(${t.ownedResultAssignment}) = 'object' AND ${t.ownedResultAssignment} -> 'version' = '1'::jsonb
      AND ${t.workspaceAllocation} IS NOT NULL AND ${t.verificationRequirement} IS NULL) IS TRUE`,
    ),
  ],
);

export const schedulerDecisions = pgTable(
  "scheduler_decisions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    selectedComputerId: text("selected_computer_id").notNull(),
    selectedAgentInstanceId: text("selected_agent_instance_id").notNull(),
    selectedModelProfileId: text("selected_model_profile_id").references(() => modelProfiles.id),
    selectedEffortProfileId: text("selected_effort_profile_id").references(() => effortProfiles.id),
    mode: text("mode").notNull(),
    score: integer("score").notNull(),
    reason: text("reason").notNull(),
    candidates: jsonbArray("candidates"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [check("scheduler_decisions_mode_chk", sql`${t.mode} in ('auto','manual')`)],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    type: text("type").notNull(),
    uri: text("uri").notNull(),
    metadata: jsonbObject("metadata"),
    checksum: text("checksum"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check(
      "artifacts_type_chk",
      sql`${t.type} in ('patch','pull_request','file','screenshot','report','log_bundle','url','test_result','contract')`,
    ),
  ],
);

/** Latest provider-reported aggregate per run; NULL means unreported. */
export const runUsage = pgTable(
  "run_usage",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "number" }),
    costUsd: doublePrecision("cost_usd"),
    currency: text("currency"),
    providerSessionId: text("provider_session_id"),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check(
      "run_usage_nonnegative_chk",
      sql`(${t.inputTokens} IS NULL OR ${t.inputTokens} >= 0) AND (${t.outputTokens} IS NULL OR ${t.outputTokens} >= 0) AND (${t.cachedInputTokens} IS NULL OR ${t.cachedInputTokens} >= 0) AND (${t.costUsd} IS NULL OR ${t.costUsd} >= 0)`,
    ),
    check("run_usage_currency_chk", sql`${t.currency} IS NULL OR ${t.currency} = 'USD'`),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    runId: text("run_id").references(() => runs.id),
    requestedByType: text("requested_by_type").notNull(),
    requestedById: text("requested_by_id").notNull(),
    action: text("action").notNull(),
    risk: text("risk").notNull(),
    summary: text("summary").notNull(),
    payloadRef: text("payload_ref"),
    status: text("status").notNull(),
    resolvedBy: text("resolved_by"),
    resolvedAt: ts("resolved_at"),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("approvals_requested_by_type_chk", sql`${t.requestedByType} in ('user','agent','system')`),
    check("approvals_risk_chk", sql`${t.risk} in ('low','medium','high')`),
    check("approvals_status_chk", sql`${t.status} in ('pending','approved','rejected','needs_more_info','expired')`),
    index("approvals_status_expires_idx").on(t.status, t.expiresAt),
    index("approvals_org_status_created_idx").on(t.organizationId, t.status, t.createdAt, t.id),
  ],
);

export const contextPacks = pgTable("context_packs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  runId: text("run_id"),
  payload: jsonb("payload").notNull(),
  sourceMemoryIds: jsonbArray("source_memory_ids"),
  createdAt: ts("created_at").notNull(),
});

// ------------------------------------------------------------------- event ---

export const eventLog = pgTable(
  "event_log",
  {
    id: text("id").primaryKey(),
    position: bigserial("position", { mode: "number" }).notNull().unique(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id"),
    type: text("type").notNull(),
    schemaVersion: text("schema_version").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    taskId: text("task_id"),
    roomId: text("room_id"),
    runId: text("run_id"),
    goalId: text("goal_id"),
    correlationId: text("correlation_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    sequence: integer("sequence"),
    payload: jsonbObject("payload"),
    occurredAt: ts("occurred_at").notNull(),
  },
  (t) => [
    index("event_log_correlation_idx").on(t.correlationId, t.occurredAt),
    index("event_log_task_idx").on(t.taskId, t.occurredAt),
    index("event_log_run_history_idx").on(t.organizationId, t.runId, t.position.desc()),
    index("event_log_goal_idx").on(t.goalId, t.occurredAt),
    index("event_log_workspace_retention_run_idx")
      .on(t.organizationId, t.runId, t.position.desc())
      .where(sql`${t.type} = 'run.workspace.retained'`),
  ],
);

// Attempt/run-scoped dedup for ingested node run events (Round 18): a composite
// UNIQUE makes re-delivered events idempotent without string-key collisions.
export const runEventIngest = pgTable(
  "run_event_ingest",
  {
    nodeId: text("node_id").notNull(),
    runId: text("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventId: text("event_id").notNull(),
    bodyIdentity: text("body_identity"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("run_event_ingest_unique").on(t.nodeId, t.runId, t.sequence),
    check(
      "run_event_ingest_body_identity_shape",
      sql`${t.bodyIdentity} is null or ${t.bodyIdentity} ~ '^run-event-body-v1:sha256:[0-9a-f]{64}$'`,
    ),
  ],
);

// Idempotency-Key store. `scope` is attempt/run-scoped for re-entrant writes
// (assign/retry derive scope from run_id, not task_id) per Round 17/18.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseJson: jsonb("response_json"),
    eventIds: jsonbArray("event_ids"),
    createdAt: ts("created_at").notNull(),
    expiresAt: ts("expires_at"),
  },
  (t) => [unique("idempotency_keys_pk").on(t.scope, t.key)],
);

/** Only qualified node-owned verification ingestion creates these immutable rows. */
export const runEvidence = pgTable(
  "run_evidence",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    requestId: text("request_id").notNull(),
    payload: jsonb("payload").notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => eventLog.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [unique("run_evidence_request_uniq").on(t.organizationId, t.runId, t.requestId)],
);
