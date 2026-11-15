CREATE TABLE scheduler_execution_requests (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  task_id text NOT NULL REFERENCES tasks(id),
  agent_id text NOT NULL REFERENCES agents(id),
  actor_user_id text NOT NULL REFERENCES users(id),
  request_key text NOT NULL,
  version integer NOT NULL DEFAULT 2,
  state text NOT NULL DEFAULT 'pending',
  snapshot jsonb NOT NULL,
  snapshot_digest text NOT NULL,
  created_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  cancelled_by_user_id text REFERENCES users(id),
  CONSTRAINT scheduler_execution_request_version_chk CHECK (version = 2),
  CONSTRAINT scheduler_execution_request_state_chk CHECK (state IN ('pending','cancelled')),
  CONSTRAINT scheduler_execution_request_snapshot_chk CHECK ((
    snapshot->'version' = '2'::jsonb AND snapshot->'request'->'version' = '2'::jsonb
    AND snapshot->'request'->>'permission' = 'execute_once'
    AND snapshot->>'organization_id' = organization_id AND snapshot->>'project_id' = project_id
    AND snapshot->>'task_id' = task_id AND snapshot->>'actor_user_id' = actor_user_id
    AND snapshot->'request'->>'agent_id' = agent_id AND snapshot->'request'->>'request_key' = request_key
  ) IS TRUE),
  CONSTRAINT scheduler_execution_request_digest_chk CHECK (snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT scheduler_execution_request_cancel_chk CHECK (
    (state = 'pending' AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL) OR
    (state = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL)),
  CONSTRAINT scheduler_execution_request_key_unique UNIQUE (task_id, request_key)
);
--> statement-breakpoint
CREATE UNIQUE INDEX scheduler_execution_request_pending_task_idx ON scheduler_execution_requests(task_id) WHERE state = 'pending';
--> statement-breakpoint
CREATE INDEX scheduler_execution_request_scope_idx ON scheduler_execution_requests(organization_id,project_id,created_at DESC);
--> statement-breakpoint
CREATE FUNCTION artoo_scheduler_execution_request_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Scheduling execution request history is immutable'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN RAISE EXCEPTION 'New execution requests must be pending'; END IF;
  ELSIF (NEW.id,NEW.organization_id,NEW.project_id,NEW.task_id,NEW.agent_id,NEW.actor_user_id,
    NEW.request_key,NEW.version,NEW.snapshot,NEW.snapshot_digest,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.organization_id,OLD.project_id,OLD.task_id,OLD.agent_id,OLD.actor_user_id,
    OLD.request_key,OLD.version,OLD.snapshot,OLD.snapshot_digest,OLD.created_at)
    OR (OLD.state = 'cancelled' AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'Scheduling execution request history is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduler_execution_request_history BEFORE INSERT OR UPDATE OR DELETE ON scheduler_execution_requests
FOR EACH ROW EXECUTE FUNCTION artoo_scheduler_execution_request_history();
