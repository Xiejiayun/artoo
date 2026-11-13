import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { jsonbArray, ts } from "./columns.js";

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    role: text("role").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [check("users_role_chk", sql`${t.role} in ('owner','admin','member')`)],
);

/** A new grant gets a new ID, so re-consenting cannot revive withdrawn jobs. */
export const aiDataSharingConsents = pgTable(
  "ai_data_sharing_consents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    policyVersion: text("policy_version").notNull(),
    policySnapshot: jsonb("policy_snapshot").notNull(),
    grantedAt: ts("granted_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("ai_data_sharing_active_user_idx").on(t.organizationId, t.userId).where(sql`${t.revokedAt} is null`),
  ],
);

/** Team content policy and restricted review queue. */
export const contentRules = pgTable("content_rules", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id),
  blockedPhrases: jsonb("blocked_phrases").notNull().$type<string[]>(),
  updatedByUserId: text("updated_by_user_id")
    .notNull()
    .references(() => users.id),
  updatedAt: ts("updated_at").notNull(),
});

export const memberSuspensions = pgTable("member_suspensions", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  suspendedByUserId: text("suspended_by_user_id")
    .notNull()
    .references(() => users.id),
  reason: text("reason").notNull(),
  suspendedAt: ts("suspended_at").notNull(),
  reinstatedAt: ts("reinstated_at"),
});

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    deletedAt: ts("deleted_at"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    displayName: text("display_name").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    capabilities: jsonbArray("capabilities"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check(
      "agents_kind_chk",
      sql`${t.kind} in ('coding','reviewer','planner','integrator','qa','memory_curator','mock')`,
    ),
    check(
      "agents_status_chk",
      sql`${t.status} in ('offline','idle','queued','running','awaiting_approval','blocked','failed')`,
    ),
  ],
);
