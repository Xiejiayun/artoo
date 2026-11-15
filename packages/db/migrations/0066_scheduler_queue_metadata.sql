CREATE TABLE scheduler_task_queue_metadata (
  task_id text PRIMARY KEY REFERENCES tasks(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  version integer NOT NULL DEFAULT 1,
  revision bigint NOT NULL,
  not_before_ms bigint NOT NULL,
  preferred_computer_id text REFERENCES computers(id),
  prefer_until_ms bigint,
  updated_by_user_id text NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL,
  CONSTRAINT scheduler_task_queue_version_chk CHECK (version = 1),
  CONSTRAINT scheduler_task_queue_revision_chk CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT scheduler_task_queue_time_chk CHECK (not_before_ms BETWEEN 0 AND 8640000000000000 AND
    (prefer_until_ms IS NULL OR prefer_until_ms BETWEEN 0 AND 8640000000000000)),
  CONSTRAINT scheduler_task_queue_affinity_chk CHECK ((preferred_computer_id IS NULL) = (prefer_until_ms IS NULL))
);
