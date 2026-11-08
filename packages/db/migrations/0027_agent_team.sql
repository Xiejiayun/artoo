ALTER TABLE goal_automations ADD COLUMN execution_mode text NOT NULL DEFAULT 'single_agent' CONSTRAINT goal_automations_mode_chk CHECK (execution_mode IN ('single_agent','agent_team'));
--> statement-breakpoint
ALTER TABLE goal_automations ADD COLUMN team jsonb;
--> statement-breakpoint
ALTER TABLE goal_automations ADD COLUMN release_profile_id text;
--> statement-breakpoint
CREATE TABLE autonomous_reviews (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  goal_id text NOT NULL REFERENCES goals(id),
  task_id text NOT NULL REFERENCES tasks(id),
  subject_run_id text NOT NULL REFERENCES runs(id),
  evidence_id text NOT NULL REFERENCES run_evidence(id),
  subject_digest text NOT NULL,
  reviewer_instance_id text NOT NULL REFERENCES agent_instances(id),
  review_task_id text NOT NULL REFERENCES tasks(id),
  turn_id text NOT NULL REFERENCES assistant_turns(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','changes_requested','failed','cancelled')),
  verdict jsonb,
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT autonomous_reviews_subject_uniq UNIQUE (organization_id, subject_run_id),
  CONSTRAINT autonomous_reviews_task_uniq UNIQUE (review_task_id)
);
--> statement-breakpoint
CREATE INDEX autonomous_reviews_goal_idx ON autonomous_reviews (organization_id, goal_id);
