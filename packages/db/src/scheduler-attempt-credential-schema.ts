import { sql } from "drizzle-orm";
import { check, pgTable, text, unique } from "drizzle-orm/pg-core";
import { schedulerExecutionLeases } from "./scheduler-execution-lease-schema.js";
import { ts } from "./schema/columns.js";

/** The full scope lives in the referenced immutable execution lease binding. */
export const schedulerAttemptCredentials = pgTable(
  "scheduler_attempt_credentials",
  {
    id: text("id").primaryKey(),
    leaseId: text("lease_id")
      .notNull()
      .references(() => schedulerExecutionLeases.id),
    secretHash: text("secret_hash").notNull(),
    createdAt: ts("created_at").notNull(),
    observedAt: ts("observed_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    unique("scheduler_attempt_credential_lease_unique").on(t.leaseId),
    check("scheduler_attempt_credential_hash_chk", sql`${t.secretHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "scheduler_attempt_credential_time_chk",
      sql`(isfinite(${t.createdAt}) AND isfinite(${t.observedAt}) AND isfinite(${t.expiresAt})
    AND ${t.observedAt} >= ${t.createdAt} AND ${t.expiresAt} > ${t.createdAt}
    AND ((${t.revokedAt} IS NULL AND ${t.expiresAt} > ${t.observedAt}) OR ${t.revokedAt} = ${t.observedAt})) IS TRUE`,
    ),
  ],
);
