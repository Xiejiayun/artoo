CREATE TABLE task_enqueue_sources (
  id text PRIMARY KEY,
  version integer NOT NULL DEFAULT 1,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  actor_user_id text NOT NULL,
  kind text NOT NULL,
  source_key text NOT NULL,
  target_key text NOT NULL,
  active_task_id text REFERENCES tasks(id),
  intent_digest text,
  created_at timestamptz NOT NULL,
  CONSTRAINT task_enqueue_head_chk CHECK ((active_task_id IS NULL) = (intent_digest IS NULL)),
  CONSTRAINT task_enqueue_source_v1_chk CHECK (version = 1)
);
--> statement-breakpoint
CREATE TABLE task_enqueue_events (
  version integer NOT NULL DEFAULT 1,
  source_id text NOT NULL REFERENCES task_enqueue_sources(id),
  event_key text NOT NULL,
  position bigserial NOT NULL,
  task_id text NOT NULL REFERENCES tasks(id),
  request_digest text NOT NULL,
  message_id text REFERENCES messages(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (source_id, event_key),
  CONSTRAINT task_enqueue_event_v1_chk CHECK (version = 1)
);
--> statement-breakpoint
CREATE INDEX task_enqueue_events_task_idx ON task_enqueue_events (task_id, position);
