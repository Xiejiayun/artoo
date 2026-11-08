ALTER TABLE runs ADD COLUMN verification_requirement jsonb;
--> statement-breakpoint
CREATE TABLE goal_automations (
  goal_id text PRIMARY KEY REFERENCES goals(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  actor_user_id text NOT NULL REFERENCES users(id),
  consent_id text REFERENCES ai_data_sharing_consents(id),
  policy_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('planning','executing','waiting','completed','failed','cancelled')),
  discussion_id text REFERENCES discussions(id),
  plan_id text REFERENCES plans(id),
  agent_instance_id text REFERENCES agent_instances(id),
  computer_id text REFERENCES computers(id),
  workspace_root text,
  verification_profile_id text NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX goal_automations_status_idx ON goal_automations (organization_id, status, created_at);
--> statement-breakpoint
CREATE TABLE run_evidence (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  run_id text NOT NULL REFERENCES runs(id),
  request_id text NOT NULL,
  payload jsonb NOT NULL,
  event_id text NOT NULL REFERENCES event_log(id),
  created_at timestamptz NOT NULL,
  CONSTRAINT run_evidence_request_uniq UNIQUE (organization_id, run_id, request_id)
);
