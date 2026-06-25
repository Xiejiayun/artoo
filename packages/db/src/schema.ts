import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema = the v0.1-core source of truth for the database (design 3.7).
 * Migrations are generated from this and must stay Postgres-compatible so they
 * run on both PGlite (dev/test) and Postgres (prod). Enum domains are enforced
 * with CHECK constraints mirroring the domain status machines.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
const jsonbArray = (name: string) =>
  jsonb(name)
    .notNull()
    .default(sql`'[]'::jsonb`);
const jsonbObject = (name: string) =>
  jsonb(name)
    .notNull()
    .default(sql`'{}'::jsonb`);

// ---------------------------------------------------------------- identity ---

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(),
  createdAt: ts("created_at").notNull(),
}, (t) => [check("users_role_chk", sql`${t.role} in ('owner','admin','member')`)]);

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  displayName: text("display_name").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  capabilities: jsonbArray("capabilities"),
  createdAt: ts("created_at").notNull(),
}, (t) => [
  check(
    "agents_kind_chk",
    sql`${t.kind} in ('coding','reviewer','planner','integrator','qa','memory_curator','mock')`,
  ),
  check(
    "agents_status_chk",
    sql`${t.status} in ('offline','idle','queued','running','awaiting_approval','blocked','failed')`,
  ),
]);

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

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  parentTaskId: text("parent_task_id").references((): AnyPgColumn => tasks.id),
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
}, (t) => [
  check(
    "tasks_status_chk",
    sql`${t.status} in ('backlog','ready','assigned','running','awaiting_approval','blocked','review','done','cancelled')`,
  ),
  check("tasks_assignee_type_chk", sql`${t.assigneeType} is null or ${t.assigneeType} in ('user','agent','agent_team')`),
  check("tasks_preferred_effort_chk", sql`${t.preferredEffort} is null or ${t.preferredEffort} in ('low','medium','high','max')`),
  check("tasks_created_by_type_chk", sql`${t.createdByType} in ('user','agent','system')`),
  index("tasks_project_status_updated_idx").on(t.projectId, t.status, t.updatedAt),
  index("tasks_parent_idx").on(t.parentTaskId),
  index("tasks_goal_idx").on(t.goalId),
  // #115 P1d: DB-level dedup so a plan→DAG materialization retry cannot create
  // duplicate tasks for the same plan spec. NULLs (non-plan tasks) don't collide.
  unique("tasks_source_plan_spec_uniq").on(t.sourcePlanId, t.sourcePlanSpecRef),
]);

export const taskDependencies = pgTable("task_dependencies", {
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
}, (t) => [
  check(
    "task_deps_type_chk",
    sql`${t.type} in ('blocks','artifact_required','contract_required','review_required','soft_context')`,
  ),
  unique("task_deps_unique").on(t.fromTaskId, t.toTaskId, t.type),
  index("task_deps_to_idx").on(t.toTaskId),
]);

export const fileLeases = pgTable("file_leases", {
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
}, (t) => [
  check("file_leases_mode_chk", sql`${t.mode} in ('read','write')`),
  check("file_leases_status_chk", sql`${t.status} in ('held','released','expired')`),
  check("file_leases_holder_type_chk", sql`${t.holderType} in ('run','task','agent','system')`),
  index("file_leases_project_status_idx").on(t.projectId, t.status),
  index("file_leases_path_idx").on(t.path),
]);

export const integrationQueue = pgTable("integration_queue", {
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
}, (t) => [
  check(
    "integration_queue_status_chk",
    sql`${t.status} in ('queued','integrating','done','failed')`,
  ),
  index("integration_queue_project_status_idx").on(t.projectId, t.status),
]);

export const modelProfiles = pgTable("model_profiles", {
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
}, (t) => [
  check("model_profiles_cost_tier_chk", sql`${t.costTier} in ('low','medium','high','premium')`),
  check("model_profiles_latency_tier_chk", sql`${t.latencyTier} in ('fast','normal','slow')`),
  unique("model_profiles_org_name").on(t.organizationId, t.name),
  index("model_profiles_lookup_idx").on(t.organizationId, t.enabled, t.costTier),
]);

export const effortProfiles = pgTable("effort_profiles", {
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
}, (t) => [
  check("effort_profiles_effort_chk", sql`${t.effort} in ('low','medium','high','max')`),
  unique("effort_profiles_org_name").on(t.organizationId, t.name),
  index("effort_profiles_lookup_idx").on(t.organizationId, t.enabled, t.effort),
]);

export const computers = pgTable("computers", {
  id: text("id").primaryKey(),
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
}, (t) => [
  check("computers_status_chk", sql`${t.status} in ('enrolling','online','offline','disabled')`),
  index("computers_status_heartbeat_idx").on(t.status, t.lastHeartbeatAt),
]);

export const agentRuntimes = pgTable("agent_runtimes", {
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
}, (t) => [
  check("agent_runtimes_status_chk", sql`${t.status} in ('detected','available','missing','disabled')`),
  unique("agent_runtimes_computer_runtime").on(t.computerId, t.runtime),
]);

export const agentInstances = pgTable("agent_instances", {
  id: text("id").primaryKey(),
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
}, (t) => [
  check("agent_instances_status_chk", sql`${t.status} in ('idle','queued','running','stopping','failed','disabled')`),
  index("agent_instances_status_computer_idx").on(t.status, t.computerId),
  index("agent_instances_profiles_idx").on(t.modelProfileId, t.effortProfileId, t.status),
]);

export const skillInstalls = pgTable("skill_installs", {
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
}, (t) => [
  check("skill_installs_installed_by_type_chk", sql`${t.installedByType} in ('user','agent','system')`),
  index("skill_installs_org_enabled_idx").on(t.organizationId, t.enabled),
  index("skill_installs_project_enabled_idx").on(t.projectId, t.enabled),
  index("skill_installs_skill_idx").on(t.organizationId, t.skillId),
]);

// ------------------------------------------------------------------ devices ---
// A device (#28 v2-C) is one client install — a control surface plus, on
// desktop, a compute-node host. It is NOT a human user and NOT an agent. On
// desktop it maps to a `computers` row (computer_id) for the embedded node.

export const devices = pgTable("devices", {
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
}, (t) => [
  check("devices_platform_chk", sql`${t.platform} in ('windows','macos','android','ios')`),
  check("devices_trust_chk", sql`${t.trust} in ('active','revoked')`),
  index("devices_org_trust_idx").on(t.organizationId, t.trust),
  index("devices_computer_idx").on(t.computerId),
]);

// The two credential CLASSES bound to one device identity. Only the hash (+ a
// non-secret lookup) is stored; the raw token never lands in this table.
export const deviceTokens = pgTable("device_tokens", {
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
}, (t) => [
  check("device_tokens_kind_chk", sql`${t.kind} in ('control_session','node')`),
  check("device_tokens_status_chk", sql`${t.status} in ('active','revoked')`),
  unique("device_tokens_lookup").on(t.tokenLookup),
  index("device_tokens_device_idx").on(t.deviceId, t.kind, t.status),
]);

// Short-lived single-use pairing codes. The raw code is never stored — only its
// HMAC (keyed by a server pepper) so a DB leak does not enable offline guessing.
export const pairingCodes = pgTable("pairing_codes", {
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
}, (t) => [
  check("pairing_codes_status_chk", sql`${t.status} in ('pending','claimed','expired','cancelled')`),
  check(
    "pairing_codes_platform_chk",
    sql`${t.intendedPlatform} is null or ${t.intendedPlatform} in ('windows','macos','android','ios')`,
  ),
  index("pairing_codes_code_hash_idx").on(t.codeHash),
  index("pairing_codes_org_status_idx").on(t.organizationId, t.status),
]);

// -------------------------------------------------------------- google auth ---
// #34: a human user's external (Google/OIDC) identity, the server-owned
// revocable session, and the short-lived in-flight OAuth authorization-code flow.

export const userIdentities = pgTable("user_identities", {
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
}, (t) => [
  check("user_identities_provider_chk", sql`${t.provider} in ('google')`),
  unique("user_identities_provider_subject").on(t.provider, t.subject),
  index("user_identities_user_idx").on(t.userId),
]);

// Server-owned revocable session. Only the token hash (+ a non-secret lookup) is
// stored — the raw session token lives in the client's HttpOnly cookie (web) or
// OS secure storage (native). Mirrors the #28 device-token at-rest model.
export const sessions = pgTable("sessions", {
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
}, (t) => [
  unique("sessions_token_lookup").on(t.tokenLookup),
  index("sessions_user_idx").on(t.userId),
]);

// Short-lived single-use OAuth flow state. `state` is round-tripped through the
// IdP (looked up by its hash); `flow_binding_hash` is the hash of a high-entropy
// secret held only in the initiating browser's HttpOnly cookie, compared on
// callback BEFORE the state is consumed (binds the callback to the initiator).
export const oauthFlows = pgTable("oauth_flows", {
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
}, (t) => [
  check("oauth_flows_provider_chk", sql`${t.provider} in ('google')`),
  check("oauth_flows_status_chk", sql`${t.status} in ('pending','consumed','expired')`),
  unique("oauth_flows_state_hash").on(t.stateHash),
  index("oauth_flows_org_status_idx").on(t.organizationId, t.status),
]);

export const runs = pgTable("runs", {
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
  createdAt: ts("created_at").notNull(),
}, (t) => [
  check(
    "runs_status_chk",
    sql`${t.status} in ('queued','starting','running','awaiting_input','paused','completed','failed','cancelled')`,
  ),
  index("runs_task_status_created_idx").on(t.taskId, t.status, t.createdAt),
]);

export const schedulerDecisions = pgTable("scheduler_decisions", {
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
}, (t) => [check("scheduler_decisions_mode_chk", sql`${t.mode} in ('auto','manual')`)]);

export const artifacts = pgTable("artifacts", {
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
}, (t) => [
  check(
    "artifacts_type_chk",
    sql`${t.type} in ('patch','pull_request','file','screenshot','report','log_bundle','url','test_result','contract')`,
  ),
]);

// ------------------------------------------------------------------ collab ---

export const rooms = pgTable("rooms", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  projectId: text("project_id").references(() => projects.id),
  taskId: text("task_id"),
  goalId: text("goal_id").references((): AnyPgColumn => goals.id),
  type: text("type").notNull(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull(),
}, (t) => [
  check("rooms_type_chk", sql`${t.type} in ('dm','project','sprint','task','agent_team','incident','goal')`),
]);

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id),
  taskId: text("task_id").references(() => tasks.id),
  runId: text("run_id").references(() => runs.id),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  kind: text("kind").notNull(),
  body: text("body").notNull().default(""),
  payload: jsonbObject("payload"),
  createdAt: ts("created_at").notNull(),
}, (t) => [
  check("messages_actor_type_chk", sql`${t.actorType} in ('user','agent','system','bridge')`),
  index("messages_room_created_idx").on(t.roomId, t.createdAt),
]);

export const approvals = pgTable("approvals", {
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
}, (t) => [
  check("approvals_requested_by_type_chk", sql`${t.requestedByType} in ('agent','system')`),
  check("approvals_risk_chk", sql`${t.risk} in ('low','medium','high')`),
  check(
    "approvals_status_chk",
    sql`${t.status} in ('pending','approved','rejected','needs_more_info','expired')`,
  ),
  index("approvals_status_expires_idx").on(t.status, t.expiresAt),
]);

// ------------------------------------------------------------------ memory ---

export const memories = pgTable("memories", {
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
}, (t) => [
  check("memories_status_chk", sql`${t.status} in ('proposed','accepted','rejected','superseded')`),
  check("memories_scope_chk", sql`${t.scope} in ('task','project','organization','code')`),
  check("memories_author_type_chk", sql`${t.authorType} in ('user','agent','system')`),
  index("memories_org_status_idx").on(t.organizationId, t.status),
  index("memories_project_scope_idx").on(t.projectId, t.scope),
  index("memories_updated_idx").on(t.updatedAt),
]);

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

export const eventLog = pgTable("event_log", {
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
}, (t) => [
  index("event_log_correlation_idx").on(t.correlationId, t.occurredAt),
  index("event_log_task_idx").on(t.taskId, t.occurredAt),
  index("event_log_goal_idx").on(t.goalId, t.occurredAt),
]);

// Attempt/run-scoped dedup for ingested node run events (Round 18): a composite
// UNIQUE makes re-delivered events idempotent without string-key collisions.
export const runEventIngest = pgTable("run_event_ingest", {
  nodeId: text("node_id").notNull(),
  runId: text("run_id").notNull(),
  sequence: integer("sequence").notNull(),
  eventId: text("event_id").notNull(),
  createdAt: ts("created_at").notNull(),
}, (t) => [unique("run_event_ingest_unique").on(t.nodeId, t.runId, t.sequence)]);

// Idempotency-Key store. `scope` is attempt/run-scoped for re-entrant writes
// (assign/retry derive scope from run_id, not task_id) per Round 17/18.
export const idempotencyKeys = pgTable("idempotency_keys", {
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  responseJson: jsonb("response_json"),
  eventIds: jsonbArray("event_ids"),
  createdAt: ts("created_at").notNull(),
  expiresAt: ts("expires_at"),
}, (t) => [unique("idempotency_keys_pk").on(t.scope, t.key)]);

// ---------------------------------------------------------------------------
// V3 #114 — team discussion records (decision / handoff / blocker). First-class,
// auditable collaboration objects. `goal_id`/`plan_id` are nullable TEXT WITHOUT
// FK constraints for now (the canonical goals/plans tables land in #115/migration
// 0011); FK constraints are added in a later migration once both exist.
// ---------------------------------------------------------------------------
export const decisionRecords = pgTable("decision_records", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  roomId: text("room_id").notNull().references(() => rooms.id),
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
}, (t) => [
  check("decision_records_status_chk", sql`${t.status} in ('proposed','accepted','rejected','superseded')`),
  check("decision_records_actor_type_chk", sql`${t.actorType} in ('user','agent','system','bridge')`),
  index("decision_records_room_idx").on(t.roomId),
  // Idempotent promotion: at most one decision per source message (NULLs unconstrained).
  unique("decision_records_source_message").on(t.sourceMessageId),
]);

export const handoffs = pgTable("handoffs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  roomId: text("room_id").notNull().references(() => rooms.id),
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
}, (t) => [
  check("handoffs_status_chk", sql`${t.status} in ('open','accepted','completed','cancelled','expired')`),
  check("handoffs_sender_type_chk", sql`${t.senderType} in ('user','agent','system','bridge')`),
  check("handoffs_recipient_type_chk", sql`${t.recipientType} in ('user','agent','system','bridge')`),
  index("handoffs_room_idx").on(t.roomId),
  index("handoffs_recipient_idx").on(t.recipientType, t.recipientId),
]);

export const blockers = pgTable("blockers", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  roomId: text("room_id").notNull().references(() => rooms.id),
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
}, (t) => [
  check(
    "blockers_type_chk",
    sql`${t.type} in ('approval','dependency','lease_conflict','offline_agent','stale_runtime','policy','budget','failed_run','missing_artifact','human_input')`,
  ),
  check("blockers_status_chk", sql`${t.status} in ('open','mitigated','accepted_risk','resolved')`),
  index("blockers_room_idx").on(t.roomId),
  index("blockers_source_idx").on(t.sourceKind, t.sourceId),
]);

// ---------------------------------------------------------------------------
// V3 #115 — persistent goals: Goal owns a versioned Plan; the accepted plan
// materializes into a task DAG; Checkpoints are reference-based markers on safe
// boundaries for explain/replay. `organization_id` is explicit on plans/
// checkpoints for direct org-scoping (review note 3); plans carry DB
// idempotency anchors (review note 4) for plan→DAG materialization.
// ---------------------------------------------------------------------------

export const goals = pgTable("goals", {
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
}, (t) => [
  check(
    "goals_status_chk",
    sql`${t.status} in ('draft','planned','running','awaiting_approval','paused','blocked','completed','cancelled','archived')`,
  ),
  check("goals_priority_chk", sql`${t.priority} in ('p0','p1','p2','p3')`),
  index("goals_project_status_idx").on(t.projectId, t.status),
  index("goals_owner_idx").on(t.ownerUserId),
]);

export const plans = pgTable("plans", {
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
}, (t) => [
  check("plans_status_chk", sql`${t.status} in ('proposed','accepted','rejected','superseded')`),
  check("plans_author_type_chk", sql`${t.authorType} in ('user','agent','system','bridge')`),
  unique("plans_goal_version_uniq").on(t.goalId, t.version),
  index("plans_goal_idx").on(t.goalId),
]);

export const checkpoints = pgTable("checkpoints", {
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
}, (t) => [
  check(
    "checkpoints_type_chk",
    sql`${t.type} in ('plan_accepted','dag_materialized','approval_decided','run_terminal','artifact_accepted','paused','resumed')`,
  ),
  index("checkpoints_goal_idx").on(t.goalId, t.createdAt),
]);
