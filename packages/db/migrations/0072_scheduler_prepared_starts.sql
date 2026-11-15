CREATE TABLE scheduler_prepared_starts (
  request_id text PRIMARY KEY REFERENCES scheduler_execution_requests(id),
  run_id text NOT NULL REFERENCES runs(id),
  snapshot jsonb NOT NULL,
  snapshot_digest text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT scheduler_prepared_start_run_unique UNIQUE (run_id),
  CONSTRAINT scheduler_prepared_start_snapshot_chk CHECK ((snapshot->'version' = '1'::jsonb
    AND snapshot->>'request_id' = request_id AND snapshot->>'run_id' = run_id
    AND snapshot->'execution_authorized' = 'false'::jsonb) IS TRUE),
  CONSTRAINT scheduler_prepared_start_digest_chk CHECK (snapshot_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE FUNCTION artoo_scheduler_prepared_start_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Prepared scheduling start history is immutable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM scheduler_execution_requests q
    JOIN runs r ON r.id = q.consumed_run_id
    JOIN tasks t ON t.id = q.task_id
    JOIN agent_instances i ON i.id = r.agent_instance_id
    JOIN devices d ON d.id = q.consumed_device_id
    WHERE q.id = NEW.request_id AND q.state = 'consumed' AND r.id = NEW.run_id
      AND r.organization_id = q.organization_id AND r.task_id = q.task_id
      AND t.organization_id = q.organization_id AND t.project_id = q.project_id
      AND i.organization_id = q.organization_id AND i.agent_id = q.agent_id AND i.computer_id = r.computer_id
      AND d.organization_id = q.organization_id AND d.computer_id = r.computer_id
      AND r.requested_by_user_id = q.actor_user_id
      AND r.ai_data_sharing_consent_id IS NOT DISTINCT FROM q.snapshot->'ai_sharing'->>'consent_id'
      AND r.ai_data_sharing_policy_version = q.snapshot->'ai_sharing'->>'policy_version'
      AND r.runtime_id <> 'mock' AND r.workspace_root IS NOT NULL AND r.workspace_branch = 'artoo/run-' || r.id
      AND r.workspace_allocation->>'strategy' = 'per-run' AND r.workspace_allocation->'version' = '1'::jsonb
      AND r.status = 'queued' AND r.started_at IS NULL AND r.ended_at IS NULL
      AND t.status = 'assigned' AND t.assignee_type = 'agent' AND t.assignee_id = q.agent_id
      AND NEW.created_at >= q.consumed_at
      AND NEW.snapshot->>'request_snapshot_digest' = q.snapshot_digest
      AND NEW.snapshot->>'organization_id' = q.organization_id
      AND NEW.snapshot->>'project_id' = q.project_id AND NEW.snapshot->>'task_id' = q.task_id
      AND NEW.snapshot->>'actor_user_id' = q.actor_user_id
      AND NEW.snapshot->>'agent_instance_id' = r.agent_instance_id
      AND NEW.snapshot->>'computer_id' = r.computer_id
      AND NEW.snapshot->>'device_id' = q.consumed_device_id
      AND NEW.snapshot->>'session_id' = q.consumed_session_id
  ) THEN RAISE EXCEPTION 'Prepared scheduling start requires its exact consumed assignment'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduler_prepared_start_history BEFORE INSERT OR UPDATE OR DELETE ON scheduler_prepared_starts
  FOR EACH ROW EXECUTE FUNCTION artoo_scheduler_prepared_start_history();
