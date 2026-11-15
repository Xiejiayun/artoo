CREATE TABLE scheduler_shadow_task_heads (
  task_id text PRIMARY KEY REFERENCES tasks(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  version integer NOT NULL DEFAULT 1,
  epoch bigint NOT NULL DEFAULT 0,
  CONSTRAINT scheduler_shadow_head_version_chk CHECK (version = 1),
  CONSTRAINT scheduler_shadow_head_epoch_chk CHECK (epoch BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE scheduler_shadow_attempts (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES scheduler_shadow_task_heads(task_id),
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  agent_id text NOT NULL REFERENCES agents(id),
  agent_instance_id text NOT NULL REFERENCES agent_instances(id),
  computer_id text NOT NULL REFERENCES computers(id),
  epoch bigint NOT NULL,
  state text NOT NULL,
  claimed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  execution_authorized boolean NOT NULL DEFAULT false,
  snapshot jsonb NOT NULL,
  ranking jsonb NOT NULL,
  CONSTRAINT scheduler_shadow_attempt_epoch_chk CHECK (epoch BETWEEN 1 AND 9007199254740991),
  CONSTRAINT scheduler_shadow_attempt_state_chk CHECK (state IN ('claimed','running','finished','expired','cancelled')),
  CONSTRAINT scheduler_shadow_attempt_authority_chk CHECK (execution_authorized = false),
  CONSTRAINT scheduler_shadow_attempt_snapshot_chk CHECK ((snapshot->'version' = '1'::jsonb AND ranking->'version' = '1'::jsonb AND ranking->'execution_authorized' = 'false'::jsonb) IS TRUE),
  CONSTRAINT scheduler_shadow_attempt_times_chk CHECK (
    expires_at > claimed_at AND
    ((state IN ('claimed','running') AND finished_at IS NULL) OR
     (state IN ('finished','expired','cancelled') AND finished_at IS NOT NULL)) AND
    (state <> 'running' OR started_at IS NOT NULL) AND
    (state <> 'finished' OR started_at IS NOT NULL)
  ),
  CONSTRAINT scheduler_shadow_attempt_task_epoch_unique UNIQUE (task_id, epoch)
);
--> statement-breakpoint
CREATE UNIQUE INDEX scheduler_shadow_active_task_idx ON scheduler_shadow_attempts (task_id) WHERE state IN ('claimed','running');
--> statement-breakpoint
CREATE INDEX scheduler_shadow_capacity_idx ON scheduler_shadow_attempts (organization_id, expires_at) WHERE state IN ('claimed','running');
--> statement-breakpoint
CREATE TABLE scheduler_shadow_observations (
  decision_id text PRIMARY KEY REFERENCES scheduler_decisions(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  task_id text NOT NULL REFERENCES tasks(id),
  collection_started_at timestamptz NOT NULL,
  collection_finished_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  ranking jsonb NOT NULL,
  occupants jsonb NOT NULL,
  revalidation jsonb NOT NULL,
  CONSTRAINT scheduler_shadow_observation_snapshot_chk CHECK ((snapshot->'version' = '1'::jsonb AND ranking->'version' = '1'::jsonb AND ranking->'execution_authorized' = 'false'::jsonb) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX scheduler_shadow_observations_scope_idx ON scheduler_shadow_observations (organization_id, project_id, recorded_at DESC);
