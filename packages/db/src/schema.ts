import { computers, agentInstances, runs, contextPacks, eventLog, runEvidence } from "./schema/execution.js";
import { assistantTurns, messages, rooms } from "./schema/messaging.js";
import { projects, tasks } from "./schema/work.js";
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

export * from "./schema/work.js";

export * from "./schema/execution.js";

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

// ------------------------------------------------------------------ collab ---

export * from "./schema/messaging.js";

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

export * from "./schema/autonomous-handoff.js";
