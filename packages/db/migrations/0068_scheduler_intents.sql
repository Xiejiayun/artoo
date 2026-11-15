CREATE TABLE scheduler_intents (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  task_id text NOT NULL REFERENCES tasks(id),
  agent_id text NOT NULL REFERENCES agents(id),
  actor_user_id text NOT NULL REFERENCES users(id),
  request_key text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'pending',
  snapshot jsonb NOT NULL,
  snapshot_digest text NOT NULL,
  execution_authorized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  cancelled_by_user_id text REFERENCES users(id),
  CONSTRAINT scheduler_intent_version_chk CHECK (version = 1),
  CONSTRAINT scheduler_intent_state_chk CHECK (state IN ('pending','cancelled')),
  CONSTRAINT scheduler_intent_authority_chk CHECK (execution_authorized = false),
  CONSTRAINT scheduler_intent_snapshot_chk CHECK ((snapshot->'version' = '1'::jsonb AND snapshot->'execution_authorized' = 'false'::jsonb) IS TRUE),
  CONSTRAINT scheduler_intent_digest_chk CHECK (snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT scheduler_intent_cancel_chk CHECK (
    (state = 'pending' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL) OR
    (state = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL)),
  CONSTRAINT scheduler_intent_request_unique UNIQUE (task_id, request_key)
);
--> statement-breakpoint
CREATE UNIQUE INDEX scheduler_intent_pending_task_idx ON scheduler_intents(task_id) WHERE state = 'pending';
--> statement-breakpoint
CREATE INDEX scheduler_intent_scope_idx ON scheduler_intents(organization_id,project_id,created_at DESC);
