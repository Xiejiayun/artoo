import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, unique } from "drizzle-orm/pg-core";
import type { SchedulerPreparedStartSnapshotV1 } from "@artoo/domain";
import { schedulerExecutionRequests } from "./scheduler-execution-request-schema.js";
import { runs } from "./schema/execution.js";
import { ts } from "./schema/columns.js";

export const schedulerPreparedStarts = pgTable(
  "scheduler_prepared_starts",
  {
    requestId: text("request_id")
      .primaryKey()
      .references(() => schedulerExecutionRequests.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    snapshot: jsonb("snapshot").notNull().$type<SchedulerPreparedStartSnapshotV1>(),
    snapshotDigest: text("snapshot_digest").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("scheduler_prepared_start_run_unique").on(t.runId),
    check(
      "scheduler_prepared_start_snapshot_chk",
      sql`(${t.snapshot}->'version' = '1'::jsonb
    AND ${t.snapshot}->>'request_id' = ${t.requestId} AND ${t.snapshot}->>'run_id' = ${t.runId}
    AND ${t.snapshot}->'execution_authorized' = 'false'::jsonb) IS TRUE`,
    ),
    check("scheduler_prepared_start_digest_chk", sql`${t.snapshotDigest} ~ '^sha256:[a-f0-9]{64}$'`),
  ],
);
