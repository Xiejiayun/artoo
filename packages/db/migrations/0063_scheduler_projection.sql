CREATE TABLE scheduler_project_policies (
  project_id text PRIMARY KEY REFERENCES projects(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  policy jsonb NOT NULL,
  updated_by_user_id text NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL,
  CONSTRAINT scheduler_project_policy_v1_chk CHECK ((jsonb_typeof(policy) = 'object' AND policy->'version' = '1'::jsonb) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE scheduler_agent_policies (
  agent_id text PRIMARY KEY REFERENCES agents(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  policy jsonb NOT NULL,
  updated_by_user_id text NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL,
  CONSTRAINT scheduler_agent_policy_v1_chk CHECK ((jsonb_typeof(policy) = 'object' AND policy->'version' = '1'::jsonb) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE scheduler_computer_policies (
  computer_id text PRIMARY KEY REFERENCES computers(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  policy jsonb NOT NULL,
  updated_by_user_id text NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL,
  CONSTRAINT scheduler_computer_policy_v1_chk CHECK ((jsonb_typeof(policy) = 'object' AND policy->'version' = '1'::jsonb) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE scheduler_task_projections (
  task_id text PRIMARY KEY REFERENCES tasks(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  version integer NOT NULL DEFAULT 1,
  legacy_status text NOT NULL,
  attempt_count integer NOT NULL,
  lease_epoch bigint NOT NULL DEFAULT 0,
  source_updated_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL,
  CONSTRAINT scheduler_task_projection_v1_chk CHECK (version = 1),
  CONSTRAINT scheduler_task_projection_status_chk CHECK (legacy_status IN ('backlog','ready','assigned','running','awaiting_approval','blocked','review','done','cancelled')),
  CONSTRAINT scheduler_task_projection_attempt_chk CHECK (attempt_count >= 0),
  CONSTRAINT scheduler_task_projection_epoch_chk CHECK (lease_epoch BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX scheduler_task_projection_scope_idx ON scheduler_task_projections (organization_id, project_id);
--> statement-breakpoint
CREATE TABLE scheduler_reconciliations (
  id bigserial PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  observed_at timestamptz NOT NULL,
  source_count integer NOT NULL,
  projection_count integer NOT NULL,
  mismatches_before integer NOT NULL,
  mismatches_after integer NOT NULL,
  repaired integer NOT NULL,
  repair_requested boolean NOT NULL,
  CONSTRAINT scheduler_reconciliation_counts_chk CHECK (source_count >= 0 AND projection_count >= 0 AND mismatches_before >= 0 AND mismatches_after >= 0 AND repaired >= 0)
);
--> statement-breakpoint
CREATE INDEX scheduler_reconciliation_history_idx ON scheduler_reconciliations (organization_id, project_id, id DESC);
