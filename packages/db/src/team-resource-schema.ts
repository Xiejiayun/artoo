import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, unique } from "drizzle-orm/pg-core";
import type { LogicalAgentConfigurationV1 } from "@artoo/domain";
import { agents, organizations, users } from "./schema/identity.js";
import { projects } from "./schema/work.js";
import { computers } from "./schema/execution.js";
import { ts } from "./schema/columns.js";

const common = () => ({
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  updatedByUserId: text("updated_by_user_id")
    .notNull()
    .references(() => users.id),
  updatedAt: ts("updated_at").notNull(),
});
export const logicalAgentConfigurations = pgTable(
  "logical_agent_configurations",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id),
    ...common(),
    createKey: text("create_key"),
    creationDigest: text("creation_digest"),
    configuration: jsonb("configuration").notNull().$type<LogicalAgentConfigurationV1>(),
  },
  (t) => [
    unique("logical_agent_create_key_unique").on(t.organizationId, t.createKey),
    check("logical_agent_configuration_revision_chk", sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
    check(
      "logical_agent_creation_digest_chk",
      sql`((${t.createKey} IS NULL AND ${t.creationDigest} IS NULL) OR (${t.createKey} IS NOT NULL AND ${t.creationDigest} ~ '^sha256:[a-f0-9]{64}$')) IS TRUE`,
    ),
    check(
      "logical_agent_configuration_version_chk",
      sql`(jsonb_typeof(${t.configuration})='object' AND ${t.configuration}->'version'='1'::jsonb) IS TRUE`,
    ),
  ],
);
export const projectSquads = pgTable(
  "project_squads",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id),
    ...common(),
    agentIds: jsonb("agent_ids").notNull().$type<string[]>(),
  },
  (t) => [
    index("project_squad_org_idx").on(t.organizationId, t.projectId),
    check("project_squad_revision_chk", sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
    check(
      "project_squad_members_chk",
      sql`jsonb_typeof(${t.agentIds})='array' AND jsonb_array_length(${t.agentIds})<=128`,
    ),
  ],
);
export const computerAdmissions = pgTable(
  "computer_admissions",
  {
    computerId: text("computer_id")
      .primaryKey()
      .references(() => computers.id),
    ...common(),
    state: text("state").notNull(),
  },
  (t) => [
    check("computer_admission_revision_chk", sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
    check("computer_admission_state_chk", sql`${t.state} IN ('accepting','draining')`),
  ],
);
