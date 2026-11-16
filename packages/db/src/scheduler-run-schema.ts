import { sql } from "drizzle-orm";
import { check, pgTable, text, unique } from "drizzle-orm/pg-core";
import { schedulerExecutionLeases } from "./scheduler-execution-lease-schema.js";
import { ts } from "./schema/columns.js";

/** Secrets are never included in public Run/read-model projections. */
export const schedulerRunCredentials = pgTable("scheduler_run_credentials", {
  id: text("id").primaryKey(),
  leaseId: text("lease_id").notNull().references(() => schedulerExecutionLeases.id),
  secretHash: text("secret_hash").notNull(),
  createdAt: ts("created_at").notNull(),
  revokedAt: ts("revoked_at"),
}, (t) => [
  unique("scheduler_run_credential_lease_unique").on(t.leaseId),
  check("scheduler_run_credential_hash_chk", sql`${t.secretHash} ~ '^[a-f0-9]{64}$'`),
  check("scheduler_run_credential_time_chk", sql`isfinite(${t.createdAt}) AND (${t.revokedAt} IS NULL OR (isfinite(${t.revokedAt}) AND ${t.revokedAt} >= ${t.createdAt}))`),
]);

/** Intent is durable; only a node-owned physical closure may cancel the Run. */
export const schedulerRunStopIntents = pgTable("scheduler_run_stop_intents", {
  leaseId: text("lease_id").primaryKey().references(() => schedulerExecutionLeases.id),
  requestedByUserId: text("requested_by_user_id").notNull(),
  requestedAt: ts("requested_at").notNull(),
}, (t) => [check("scheduler_run_stop_intents_requested_at_check", sql`isfinite(${t.requestedAt})`)]);
