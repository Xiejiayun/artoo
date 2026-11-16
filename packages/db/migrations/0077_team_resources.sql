CREATE TABLE logical_agent_configurations (
  agent_id text PRIMARY KEY REFERENCES agents(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  revision bigint NOT NULL DEFAULT 1,
  updated_by_user_id text NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL,
  create_key text,
  creation_digest text,
  configuration jsonb NOT NULL,
  CONSTRAINT logical_agent_create_key_unique UNIQUE(organization_id,create_key),
  CONSTRAINT logical_agent_configuration_revision_chk CHECK(revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT logical_agent_creation_digest_chk CHECK(((create_key IS NULL AND creation_digest IS NULL) OR (create_key IS NOT NULL AND creation_digest ~ '^sha256:[a-f0-9]{64}$')) IS TRUE),
  CONSTRAINT logical_agent_configuration_version_chk CHECK((jsonb_typeof(configuration)='object' AND configuration->'version'='1'::jsonb) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE project_squads (
  project_id text PRIMARY KEY REFERENCES projects(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  revision bigint NOT NULL DEFAULT 1,
  updated_by_user_id text NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL,
  agent_ids jsonb NOT NULL,
  CONSTRAINT project_squad_revision_chk CHECK(revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT project_squad_members_chk CHECK(jsonb_typeof(agent_ids)='array' AND jsonb_array_length(agent_ids)<=128)
);
--> statement-breakpoint
CREATE INDEX project_squad_org_idx ON project_squads(organization_id,project_id);
--> statement-breakpoint
CREATE TABLE computer_admissions (
  computer_id text PRIMARY KEY REFERENCES computers(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  revision bigint NOT NULL DEFAULT 1,
  updated_by_user_id text NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL,
  state text NOT NULL,
  CONSTRAINT computer_admission_revision_chk CHECK(revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT computer_admission_state_chk CHECK(state IN ('accepting','draining'))
);
