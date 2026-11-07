import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organizations, goals, computers, runs, eventLog } from "./schema.js";
import { sourceCleanGenerations } from "./source-clean-restart-schema.js";

/** Exact old operation coverage after actual whole-Supervisor closure. History
 * remains unchanged; only this committed ledger can remove old occupancy. */
export const sourceCleanOperationSettlements = pgTable("source_clean_operation_settlements", {
  id: text("id").primaryKey(), generationId: text("generation_id").notNull().references(() => sourceCleanGenerations.id),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  goalId: text("goal_id").notNull().references(() => goals.id), computerId: text("computer_id").notNull().references(() => computers.id),
  kind: text("kind").notNull(), operationId: text("operation_id").notNull(), requestDigest: text("request_digest").notNull(),
  runId: text("run_id").references(() => runs.id), eventId: text("event_id").notNull().references(() => eventLog.id),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, table => [unique("source_clean_operation_settlement_uniq").on(table.organizationId, table.kind, table.operationId),
  check("source_clean_operation_settlement_kind_chk", sql`(${table.kind}='validation' AND ${table.runId} IS NOT NULL)
    OR (${table.kind} IN ('validation_review','release') AND ${table.runId} IS NULL)`),
  check("source_clean_operation_settlement_digest_chk", sql`${table.requestDigest} ~ '^sha256:[a-f0-9]{64}$'`)]);
