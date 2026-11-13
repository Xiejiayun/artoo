import { jsonbArray, jsonbObject, ts } from "./schema/columns.js";
import { agents, aiDataSharingConsents, organizations, users } from "./schema/identity.js";
import { sql } from "drizzle-orm";
import { sourceCleanGenerations } from "./source-clean-restart-schema.js";
import {
  type AnyPgColumn,
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
  real,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema = the v0.1-core source of truth for the database (design 3.7).
 * Migrations are generated from this and must stay Postgres-compatible so they
 * run on both PGlite (dev/test) and Postgres (prod). Enum domains are enforced
 * with CHECK constraints mirroring the domain status machines.
 */

export * from "./schema/identity.js";

// -------------------------------------------------------------------- work ---

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

// ------------------------------------------------------------------ devices ---
// A device (#28 v2-C) is one client install — a control surface plus, on
// desktop, a compute-node host. It is NOT a human user and NOT an agent. On
// desktop it maps to a `computers` row (computer_id) for the embedded node.

export const devices = pgTable(
  "devices",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    displayName: text("display_name").notNull(),
    platform: text("platform").notNull(),
    appVersion: text("app_version").notNull(),
    /** Set when this device hosts a compute node. Null for control-only (mobile). */
    computerId: text("computer_id").references(() => computers.id),
    enrolledByUserId: text("enrolled_by_user_id")
      .notNull()
      .references(() => users.id),
    trust: text("trust").notNull(),
    lastSeenAt: ts("last_seen_at"),
    createdAt: ts("created_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    check("devices_platform_chk", sql`${t.platform} in ('windows','macos','linux','android','ios')`),
    check("devices_trust_chk", sql`${t.trust} in ('active','revoked')`),
    index("devices_org_trust_idx").on(t.organizationId, t.trust),
    index("devices_computer_idx").on(t.computerId),
  ],
);

// The two credential CLASSES bound to one device identity. Only the hash (+ a
// non-secret lookup) is stored; the raw token never lands in this table.
export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    kind: text("kind").notNull(),
    tokenLookup: text("token_lookup").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull(),
    createdAt: ts("created_at").notNull(),
    lastUsedAt: ts("last_used_at"),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    check("device_tokens_kind_chk", sql`${t.kind} in ('control_session','node')`),
    check("device_tokens_status_chk", sql`${t.status} in ('active','revoked')`),
    unique("device_tokens_lookup").on(t.tokenLookup),
    index("device_tokens_device_idx").on(t.deviceId, t.kind, t.status),
  ],
);

// Short-lived single-use pairing codes. The raw code is never stored — only its
// HMAC (keyed by a server pepper) so a DB leak does not enable offline guessing.
export const pairingCodes = pgTable(
  "pairing_codes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    codeHash: text("code_hash").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    intendedPlatform: text("intended_platform"),
    status: text("status").notNull(),
    expiresAt: ts("expires_at").notNull(),
    claimedByDeviceId: text("claimed_by_device_id").references(() => devices.id),
    createdAt: ts("created_at").notNull(),
    claimedAt: ts("claimed_at"),
  },
  (t) => [
    check("pairing_codes_status_chk", sql`${t.status} in ('pending','claimed','expired','cancelled')`),
    check(
      "pairing_codes_platform_chk",
      sql`${t.intendedPlatform} is null or ${t.intendedPlatform} in ('windows','macos','linux','android','ios')`,
    ),
    index("pairing_codes_code_hash_idx").on(t.codeHash),
    index("pairing_codes_org_status_idx").on(t.organizationId, t.status),
  ],
);

// -------------------------------------------------------------- google auth ---
// #34: a human user's external (Google/OIDC) identity, the server-owned
// revocable session, and the short-lived in-flight OAuth authorization-code flow.

export const userIdentities = pgTable(
  "user_identities",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(),
    /** The provider's stable user id (Google `sub`). */
    subject: text("subject").notNull(),
    email: text("email"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("user_identities_provider_chk", sql`${t.provider} in ('google')`),
    unique("user_identities_provider_subject").on(t.provider, t.subject),
    index("user_identities_user_idx").on(t.userId),
  ],
);

// Server-owned revocable session. Only the token hash (+ a non-secret lookup) is
// stored — the raw session token lives in the client's HttpOnly cookie (web) or
// OS secure storage (native). Mirrors the #28 device-token at-rest model.
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenLookup: text("token_lookup").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: ts("created_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    lastSeenAt: ts("last_seen_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [unique("sessions_token_lookup").on(t.tokenLookup), index("sessions_user_idx").on(t.userId)],
);

// Short-lived single-use OAuth flow state. `state` is round-tripped through the
// IdP (looked up by its hash); `flow_binding_hash` is the hash of a high-entropy
// secret held only in the initiating browser's HttpOnly cookie, compared on
// callback BEFORE the state is consumed (binds the callback to the initiator).
export const oauthFlows = pgTable(
  "oauth_flows",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    provider: text("provider").notNull(),
    stateHash: text("state_hash").notNull(),
    nonce: text("nonce").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    flowBindingHash: text("flow_binding_hash").notNull(),
    returnTo: text("return_to").notNull(),
    status: text("status").notNull(),
    createdAt: ts("created_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    consumedAt: ts("consumed_at"),
  },
  (t) => [
    check("oauth_flows_provider_chk", sql`${t.provider} in ('google')`),
    check("oauth_flows_status_chk", sql`${t.status} in ('pending','consumed','expired')`),
    unique("oauth_flows_state_hash").on(t.stateHash),
    index("oauth_flows_org_status_idx").on(t.organizationId, t.status),
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

// ------------------------------------------------------------------ collab ---

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

// ------------------------------------------------------------------ memory ---

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").references(() => projects.id),
    taskId: text("task_id").references(() => tasks.id),
    status: text("status").notNull(),
    scope: text("scope").notNull(),
    // Provenance refs are loose (may point cross-project or at removed rows) so
    // they are plain columns, not FKs.
    sourceTaskId: text("source_task_id"),
    sourceRunId: text("source_run_id"),
    sourceMessageId: text("source_message_id"),
    sourceArtifactId: text("source_artifact_id"),
    authorType: text("author_type").notNull(),
    authorId: text("author_id").notNull(),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default(sql`1`),
    text: text("text"),
    payload: jsonb("payload"),
    tags: jsonbArray("tags"),
    supersedesId: text("supersedes_id"),
    supersededById: text("superseded_by_id"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    check("memories_status_chk", sql`${t.status} in ('proposed','accepted','rejected','superseded')`),
    check("memories_scope_chk", sql`${t.scope} in ('task','project','organization','code')`),
    check("memories_author_type_chk", sql`${t.authorType} in ('user','agent','system')`),
    index("memories_org_status_idx").on(t.organizationId, t.status),
    index("memories_project_scope_idx").on(t.projectId, t.scope),
    index("memories_updated_idx").on(t.updatedAt),
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

// ---------------------------------------------------------------------------
// V3 #115 — persistent goals: Goal owns a versioned Plan; the accepted plan
// materializes into a task DAG; Checkpoints are reference-based markers on safe
// boundaries for explain/replay. `organization_id` is explicit on plans/
// checkpoints for direct org-scoping (review note 3); plans carry DB
// idempotency anchors (review note 4) for plan→DAG materialization.
// ---------------------------------------------------------------------------

export const goals = pgTable(
  "goals",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    roomId: text("room_id").references(() => rooms.id),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    objective: text("objective").notNull().default(""),
    priority: text("priority").notNull().default("p2"),
    status: text("status").notNull().default("draft"),
    acceptanceCriteria: jsonbArray("acceptance_criteria"),
    stopConditions: jsonb("stop_conditions").notNull().default(sql`'{"rules":[]}'::jsonb`),
    budgets: jsonb("budgets").notNull().default(sql`'{}'::jsonb`),
    currentPlanId: text("current_plan_id"),
    runningSince: ts("running_since"),
    elapsedCostUsd: real("elapsed_cost_usd"),
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check(
      "goals_status_chk",
      sql`${t.status} in ('draft','planned','running','awaiting_approval','paused','blocked','completed','cancelled','archived')`,
    ),
    check("goals_priority_chk", sql`${t.priority} in ('p0','p1','p2','p3')`),
    index("goals_project_status_idx").on(t.projectId, t.status),
    index("goals_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("goals_owner_idx").on(t.ownerUserId),
  ],
);

export const plans = pgTable(
  "plans",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    version: integer("version").notNull(),
    authorType: text("author_type").notNull(),
    authorId: text("author_id").notNull(),
    rationale: text("rationale").notNull().default(""),
    status: text("status").notNull().default("proposed"),
    taskSpecs: jsonb("task_specs").notNull().default(sql`'[]'::jsonb`),
    materializedAt: ts("materialized_at"),
    materializationEventId: text("materialization_event_id"),
    createdAt: ts("created_at").notNull(),
    acceptedAt: ts("accepted_at"),
  },
  (t) => [
    check("plans_status_chk", sql`${t.status} in ('proposed','accepted','rejected','superseded')`),
    check("plans_author_type_chk", sql`${t.authorType} in ('user','agent','system','bridge')`),
    unique("plans_goal_version_uniq").on(t.goalId, t.version),
    index("plans_goal_idx").on(t.goalId),
  ],
);

export const checkpoints = pgTable(
  "checkpoints",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    planId: text("plan_id").references(() => plans.id),
    type: text("type").notNull(),
    triggerEventId: text("trigger_event_id"),
    stateRefs: jsonb("state_refs").notNull().default(sql`'{}'::jsonb`),
    summary: text("summary").notNull().default(""),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check(
      "checkpoints_type_chk",
      sql`${t.type} in ('plan_accepted','dag_materialized','approval_decided','run_terminal','artifact_accepted','paused','resumed')`,
    ),
    index("checkpoints_goal_idx").on(t.goalId, t.createdAt),
  ],
);

export const discussions = pgTable(
  "discussions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id),
    threadRootId: text("thread_root_id")
      .notNull()
      .references(() => messages.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    participants: jsonbArray("participants"),
    rounds: integer("rounds").notNull(),
    maxMinutes: integer("max_minutes").notNull(),
    status: text("status").notNull(),
    currentStep: integer("current_step").notNull().default(0),
    activeTurnId: text("active_turn_id").references(() => assistantTurns.id),
    finalMessageId: text("final_message_id").references(() => messages.id),
    planId: text("plan_id").references(() => plans.id),
    error: text("error"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    deadlineAt: ts("deadline_at").notNull(),
    aiDataSharingConsentId: text("ai_data_sharing_consent_id").references(() => aiDataSharingConsents.id),
    aiDataSharingPolicyVersion: text("ai_data_sharing_policy_version"),
  },
  (t) => [
    check("discussions_status_chk", sql`${t.status} in ('running','stopping','ready','failed','cancelled')`),
    check("discussions_rounds_chk", sql`${t.rounds} between 1 and 3`),
    check("discussions_minutes_chk", sql`${t.maxMinutes} between 2 and 60`),
    index("discussions_goal_idx").on(t.organizationId, t.goalId, t.createdAt),
  ],
);

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
