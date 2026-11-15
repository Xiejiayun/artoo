ALTER TABLE scheduler_execution_requests
  ADD COLUMN consumed_run_id text REFERENCES runs(id),
  ADD COLUMN consumed_device_id text REFERENCES devices(id),
  ADD COLUMN consumed_session_id text,
  ADD COLUMN consumed_at timestamptz,
  ADD CONSTRAINT scheduler_execution_request_consumed_run_unique UNIQUE (consumed_run_id),
  DROP CONSTRAINT scheduler_execution_request_state_chk,
  DROP CONSTRAINT scheduler_execution_request_cancel_chk,
  ADD CONSTRAINT scheduler_execution_request_state_chk CHECK (state IN ('pending','cancelled','consumed')),
  ADD CONSTRAINT scheduler_execution_request_cancel_chk CHECK (
    (state IN ('pending','consumed') AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL) OR
    (state = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL)),
  ADD CONSTRAINT scheduler_execution_request_consumed_chk CHECK (
    (state = 'consumed' AND consumed_run_id IS NOT NULL AND consumed_device_id IS NOT NULL
      AND consumed_session_id IS NOT NULL AND length(consumed_session_id) BETWEEN 1 AND 128 AND consumed_at IS NOT NULL) OR
    (state <> 'consumed' AND consumed_run_id IS NULL AND consumed_device_id IS NULL
      AND consumed_session_id IS NULL AND consumed_at IS NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION artoo_scheduler_execution_request_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Scheduling execution request history is immutable'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN RAISE EXCEPTION 'New execution requests must be pending'; END IF;
  ELSIF (NEW.id,NEW.organization_id,NEW.project_id,NEW.task_id,NEW.agent_id,NEW.actor_user_id,
    NEW.request_key,NEW.version,NEW.snapshot,NEW.snapshot_digest,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.organization_id,OLD.project_id,OLD.task_id,OLD.agent_id,OLD.actor_user_id,
    OLD.request_key,OLD.version,OLD.snapshot,OLD.snapshot_digest,OLD.created_at)
    OR (OLD.state IN ('cancelled','consumed') AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'Scheduling execution request history is immutable';
  END IF;
  IF NEW.state = 'consumed' AND NOT EXISTS (
    SELECT 1 FROM runs r
    JOIN tasks t ON t.id = r.task_id
    JOIN agent_instances i ON i.id = r.agent_instance_id
    JOIN devices d ON d.id = NEW.consumed_device_id
    WHERE r.id = NEW.consumed_run_id AND r.organization_id = NEW.organization_id
      AND t.organization_id = NEW.organization_id AND t.project_id = NEW.project_id AND t.id = NEW.task_id
      AND i.organization_id = NEW.organization_id AND i.agent_id = NEW.agent_id AND i.computer_id = r.computer_id
      AND d.organization_id = NEW.organization_id AND d.computer_id = r.computer_id
      AND r.requested_by_user_id = NEW.actor_user_id
      AND r.created_at >= NEW.created_at AND NEW.consumed_at >= r.created_at
      AND r.runtime_id <> 'mock' AND r.workspace_root IS NOT NULL AND r.workspace_branch = 'artoo/run-' || r.id
      AND r.workspace_allocation->>'strategy' = 'per-run'
      AND r.workspace_allocation->'version' = '1'::jsonb
      AND r.ai_data_sharing_consent_id IS NOT DISTINCT FROM NEW.snapshot->'ai_sharing'->>'consent_id'
      AND r.ai_data_sharing_policy_version = NEW.snapshot->'ai_sharing'->>'policy_version'
  ) THEN RAISE EXCEPTION 'Scheduling execution consumption requires its exact isolated Run'; END IF;
  RETURN NEW;
END $$;
