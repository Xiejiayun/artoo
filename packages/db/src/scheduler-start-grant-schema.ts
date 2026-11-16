import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, unique } from "drizzle-orm/pg-core";
import type { SchedulerStartGrantV1 } from "@artoo/domain";
import { schedulerPreparedStarts } from "./scheduler-prepared-start-schema.js";
import { runs } from "./schema/execution.js";
import { organizations } from "./schema/identity.js";
import { ts } from "./schema/columns.js";

export const schedulerStartGrants = pgTable(
  "scheduler_start_grants",
  {
    requestId: text("request_id")
      .primaryKey()
      .references(() => schedulerPreparedStarts.requestId),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    journalNamespace: text("journal_namespace").notNull(),
    nodeAttemptId: text("node_attempt_id").notNull(),
    grantId: text("grant_id").notNull(),
    snapshot: jsonb("snapshot").notNull().$type<SchedulerStartGrantV1>(),
    snapshotDigest: text("snapshot_digest").notNull(),
    issuedAt: ts("issued_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [
    unique("scheduler_start_grant_run_unique").on(t.runId),
    unique("scheduler_start_grant_id_unique").on(t.grantId),
    unique("scheduler_start_grant_attempt_unique").on(t.organizationId, t.journalNamespace, t.nodeAttemptId),
    check(
      "scheduler_start_grant_lifetime_chk",
      sql`${t.expiresAt} > ${t.issuedAt} AND ${t.expiresAt} <= ${t.issuedAt} + interval '5 seconds'`,
    ),
    check(
      "scheduler_start_grant_snapshot_chk",
      sql`(${t.snapshot}->'version' = '1'::jsonb
    AND ${t.snapshot}->>'scope' = 'scheduler-start.once.v1'
    AND ${t.snapshot}->>'request_id' = ${t.requestId} AND ${t.snapshot}->>'run_id' = ${t.runId}
    AND ${t.snapshot}->>'organization_id' = ${t.organizationId}
    AND ${t.snapshot}->>'journal_namespace' = ${t.journalNamespace}
    AND ${t.snapshot}->>'node_attempt_id' = ${t.nodeAttemptId}
    AND ${t.snapshot}->>'grant_id' = ${t.grantId}
    AND (${t.snapshot}->>'issued_at')::timestamptz = ${t.issuedAt}
    AND (${t.snapshot}->>'expires_at')::timestamptz = ${t.expiresAt}) IS TRUE`,
    ),
    check("scheduler_start_grant_digest_chk", sql`${t.snapshotDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);
