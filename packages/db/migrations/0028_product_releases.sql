CREATE TABLE product_releases (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  goal_id text NOT NULL REFERENCES goals(id),
  project_id text NOT NULL REFERENCES projects(id),
  computer_id text NOT NULL REFERENCES computers(id),
  run_id text NOT NULL REFERENCES runs(id),
  evidence_id text NOT NULL REFERENCES run_evidence(id),
  status text NOT NULL CHECK (status IN ('queued','published','rolled_back','failed')),
  request jsonb NOT NULL,
  receipt jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT product_releases_goal_uniq UNIQUE (organization_id, goal_id)
);
--> statement-breakpoint
CREATE INDEX product_releases_dispatch_idx ON product_releases (organization_id, status, created_at);
