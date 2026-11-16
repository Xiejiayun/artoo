CREATE TABLE scheduler_start_grants (
  request_id text PRIMARY KEY REFERENCES scheduler_prepared_starts(request_id),
  run_id text NOT NULL REFERENCES runs(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  journal_namespace text NOT NULL,
  node_attempt_id text NOT NULL,
  grant_id text NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_digest text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT scheduler_start_grant_run_unique UNIQUE (run_id),
  CONSTRAINT scheduler_start_grant_id_unique UNIQUE (grant_id),
  CONSTRAINT scheduler_start_grant_attempt_unique UNIQUE (organization_id,journal_namespace,node_attempt_id),
  CONSTRAINT scheduler_start_grant_lifetime_chk CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 seconds'),
  CONSTRAINT scheduler_start_grant_snapshot_chk CHECK ((snapshot->'version' = '1'::jsonb
    AND snapshot->>'scope' = 'scheduler-start.once.v1'
    AND snapshot->>'request_id' = request_id AND snapshot->>'run_id' = run_id
    AND snapshot->>'organization_id' = organization_id AND snapshot->>'journal_namespace' = journal_namespace
    AND snapshot->>'node_attempt_id' = node_attempt_id AND snapshot->>'grant_id' = grant_id
    AND (snapshot->>'issued_at')::timestamptz = issued_at AND (snapshot->>'expires_at')::timestamptz = expires_at) IS TRUE),
  CONSTRAINT scheduler_start_grant_digest_chk CHECK (snapshot_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE FUNCTION artoo_scheduler_start_grant_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Scheduler start grant history is immutable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM scheduler_prepared_starts p
    JOIN scheduler_execution_requests q ON q.id = p.request_id
    JOIN runs r ON r.id = p.run_id
    WHERE p.request_id = NEW.request_id AND p.run_id = NEW.run_id
      AND q.state = 'consumed' AND q.consumed_run_id = r.id
      AND r.status = 'queued' AND r.started_at IS NULL AND r.ended_at IS NULL
      AND NEW.issued_at >= p.created_at
      AND NEW.snapshot->>'organization_id' = p.snapshot->>'organization_id'
      AND NEW.snapshot->>'project_id' = p.snapshot->>'project_id'
      AND NEW.snapshot->>'task_id' = p.snapshot->>'task_id'
      AND NEW.snapshot->>'actor_user_id' = p.snapshot->>'actor_user_id'
      AND NEW.snapshot->>'agent_instance_id' = p.snapshot->>'agent_instance_id'
      AND NEW.snapshot->>'computer_id' = p.snapshot->>'computer_id'
      AND NEW.snapshot->>'device_id' = p.snapshot->>'device_id'
      AND NEW.snapshot->>'session_id' = p.snapshot->>'session_id'
  ) THEN RAISE EXCEPTION 'Scheduler start grant requires its exact prepared assignment'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduler_start_grant_history BEFORE INSERT OR UPDATE OR DELETE ON scheduler_start_grants
  FOR EACH ROW EXECUTE FUNCTION artoo_scheduler_start_grant_history();
