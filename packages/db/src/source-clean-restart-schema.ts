import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organizations, computers, devices, nodeRecoveryRegistrations, eventLog } from "./schema.js";
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/** One persistent physical occupancy, including while its native owner is closed. */
export const sourceWorkspaceLineages = pgTable("source_workspace_lineages", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id),
  computerId: text("computer_id").notNull().references(() => computers.id), deviceId: text("device_id").notNull().references(() => devices.id),
  workspaceRoot: text("workspace_root").notNull(), workspaceIdentityDigest: text("workspace_identity_digest").notNull(),
  stable: jsonb("stable").notNull(), stableDigest: text("stable_digest").notNull(),
  initialRegistration: jsonb("initial_registration").notNull(),
  currentRegistrationId: text("current_registration_id").notNull().references(() => nodeRecoveryRegistrations.id),
  currentGenerationId: text("current_generation_id").notNull(), revision: integer("revision").notNull().default(0),
  state: text("state").notNull(), createdAt: ts("created_at").notNull(), updatedAt: ts("updated_at").notNull(),
}, table => [unique("source_workspace_lineage_physical_uniq").on(table.organizationId, table.computerId, table.workspaceIdentityDigest),
  unique("source_workspace_lineage_root_uniq").on(table.organizationId, table.computerId, table.workspaceRoot),
  check("source_workspace_lineage_revision_chk", sql`${table.revision} >= 0`),
  check("source_workspace_lineage_state_chk", sql`${table.state} IN ('active','closing','closed','reserved','recovery')`),
  check("source_workspace_lineage_digest_chk", sql`${table.stableDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${table.workspaceIdentityDigest} ~ '^sha256:[a-f0-9]{64}$'`)]);

export const sourceCleanStops = pgTable("source_clean_stops", {
  id: text("id").primaryKey(), lineageId: text("lineage_id").notNull().references(() => sourceWorkspaceLineages.id),
  organizationId: text("organization_id").notNull().references(() => organizations.id), generationId: text("generation_id").notNull(),
  observerId: text("observer_id").notNull(), registrationId: text("registration_id").notNull().references(() => nodeRecoveryRegistrations.id),
  intentDigest: text("intent_digest").notNull(), intent: jsonb("intent").notNull(),
  closureDigest: text("closure_digest"), closure: jsonb("closure"), receipt: jsonb("receipt"),
  createdAt: ts("created_at").notNull(), closedAt: ts("closed_at"),
}, table => [unique("source_clean_stop_generation_uniq").on(table.lineageId, table.generationId),
  unique("source_clean_stop_observer_uniq").on(table.observerId),
  check("source_clean_stop_digest_chk", sql`${table.intentDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${table.closureDigest} IS NULL OR ${table.closureDigest} ~ '^sha256:[a-f0-9]{64}$')`),
  check("source_clean_stop_closure_chk", sql`(${table.closure} IS NULL AND ${table.closureDigest} IS NULL AND ${table.receipt} IS NULL AND ${table.closedAt} IS NULL) OR
    (${table.closure} IS NOT NULL AND ${table.closureDigest} IS NOT NULL AND ${table.receipt} IS NOT NULL AND ${table.closedAt} IS NOT NULL)`)]);

export const sourceCleanGenerations = pgTable("source_clean_generations", {
  id: text("id").primaryKey(), lineageId: text("lineage_id").notNull().references(() => sourceWorkspaceLineages.id),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  predecessorStopId: text("predecessor_stop_id").notNull().references(() => sourceCleanStops.id), claimantObserverId: text("claimant_observer_id").notNull(),
  grantDigest: text("grant_digest").notNull(), grant: jsonb("grant").notNull(),
  registrationId: text("registration_id").references(() => nodeRecoveryRegistrations.id), lifecycleRegistration: jsonb("lifecycle_registration"),
  checkpointDigest: text("checkpoint_digest"), checkpoint: jsonb("checkpoint"), receipt: jsonb("receipt"),
  createdAt: ts("created_at").notNull(), registeredAt: ts("registered_at"), checkpointedAt: ts("checkpointed_at"),
  settledAt: ts("settled_at"), settlementEventId: text("settlement_event_id").references(() => eventLog.id),
}, table => [unique("source_clean_generation_predecessor_uniq").on(table.predecessorStopId),
  unique("source_clean_generation_claimant_uniq").on(table.claimantObserverId),
  unique("source_clean_generation_registration_uniq").on(table.registrationId),
  check("source_clean_generation_digest_chk", sql`${table.grantDigest} ~ '^sha256:[a-f0-9]{64}$' AND (${table.checkpointDigest} IS NULL OR ${table.checkpointDigest} ~ '^sha256:[a-f0-9]{64}$')`),
  check("source_clean_generation_registration_chk", sql`(${table.registrationId} IS NULL AND ${table.lifecycleRegistration} IS NULL AND ${table.registeredAt} IS NULL) OR
    (${table.registrationId} IS NOT NULL AND ${table.lifecycleRegistration} IS NOT NULL AND ${table.registeredAt} IS NOT NULL)`),
  check("source_clean_generation_checkpoint_chk", sql`(${table.checkpoint} IS NULL AND ${table.checkpointDigest} IS NULL AND ${table.receipt} IS NULL AND ${table.checkpointedAt} IS NULL) OR
    (${table.checkpoint} IS NOT NULL AND ${table.checkpointDigest} IS NOT NULL AND ${table.receipt} IS NOT NULL AND ${table.checkpointedAt} IS NOT NULL AND ${table.registrationId} IS NOT NULL)`),
  check("source_clean_generation_settlement_chk", sql`(${table.settledAt} IS NULL AND ${table.settlementEventId} IS NULL) OR
    (${table.settledAt} IS NOT NULL AND ${table.settlementEventId} IS NOT NULL AND ${table.checkpoint} IS NOT NULL)`)]);
