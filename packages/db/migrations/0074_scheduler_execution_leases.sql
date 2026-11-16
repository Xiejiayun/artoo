CREATE TABLE scheduler_execution_leases (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES scheduler_start_grants(request_id),
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  task_id text NOT NULL REFERENCES tasks(id),
  epoch bigint NOT NULL,
  binding jsonb NOT NULL,
  state text NOT NULL,
  claimed_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  CONSTRAINT scheduler_execution_lease_request_unique UNIQUE (request_id),
  CONSTRAINT scheduler_execution_lease_epoch_unique UNIQUE (task_id,epoch),
  CONSTRAINT scheduler_execution_lease_epoch_chk CHECK (epoch BETWEEN 1 AND 9007199254740991),
  CONSTRAINT scheduler_execution_lease_binding_chk CHECK ((binding->'version' = '1'::jsonb
    AND binding->>'scope' = 'scheduler.execution-lease.v1' AND binding->>'lease_id' = id
    AND binding->>'request_id' = request_id AND binding->>'organization_id' = organization_id
    AND binding->>'project_id' = project_id AND binding->>'task_id' = task_id
    AND binding->'epoch' = to_jsonb(epoch)) IS TRUE),
  CONSTRAINT scheduler_execution_lease_time_chk CHECK (isfinite(claimed_at) AND isfinite(observed_at) AND isfinite(expires_at)
    AND observed_at >= claimed_at AND expires_at > claimed_at AND expires_at <= observed_at + interval '5 minutes'
    AND ((state = 'active' AND closed_at IS NULL AND observed_at < expires_at)
      OR (state IN ('expired','revoked') AND closed_at = observed_at
        AND (state <> 'expired' OR observed_at >= expires_at))) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX scheduler_execution_lease_active_task_idx ON scheduler_execution_leases(task_id) WHERE state = 'active';
--> statement-breakpoint
CREATE INDEX scheduler_execution_lease_expiry_idx ON scheduler_execution_leases(organization_id,expires_at) WHERE state = 'active';
--> statement-breakpoint
CREATE FUNCTION artoo_scheduler_execution_lease_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_epoch bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Execution lease history cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    -- Same Task serialization as the admission owner; never invert a waiting lock.
    PERFORM 1 FROM tasks WHERE id = NEW.task_id AND organization_id = NEW.organization_id
      AND project_id = NEW.project_id FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'Execution lease Task scope mismatch'; END IF;
    SELECT coalesce(max(epoch),0) INTO last_epoch FROM scheduler_execution_leases WHERE task_id = NEW.task_id;
    IF NEW.epoch <> last_epoch + 1 OR NEW.state <> 'active' OR NEW.observed_at <> NEW.claimed_at OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Execution lease requires the next epoch and fresh observation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM scheduler_start_grants g
      JOIN scheduler_execution_requests q ON q.id = g.request_id
      JOIN runs r ON r.id = g.run_id
      WHERE g.request_id = NEW.request_id AND g.organization_id = NEW.organization_id
        AND q.state = 'consumed' AND q.consumed_run_id = r.id
        AND r.status = 'queued' AND r.started_at IS NULL AND r.ended_at IS NULL
        AND NEW.claimed_at >= g.issued_at AND NEW.claimed_at < g.expires_at
        AND NEW.binding - 'version' - 'scope' - 'lease_id' - 'epoch' =
          g.snapshot - 'version' - 'scope' - 'ready_id' - 'proposal_digest' - 'issued_at' - 'expires_at'
    ) THEN RAISE EXCEPTION 'Execution lease requires its exact current start grant'; END IF;
  ELSE
    IF (to_jsonb(NEW) - 'state' - 'observed_at' - 'expires_at' - 'closed_at') IS DISTINCT FROM
       (to_jsonb(OLD) - 'state' - 'observed_at' - 'expires_at' - 'closed_at')
       OR OLD.state <> 'active' OR NEW.observed_at < OLD.observed_at
       OR (NEW.state = 'active' AND (NEW.observed_at >= OLD.expires_at OR NEW.expires_at < OLD.expires_at))
       OR (NEW.state <> 'active' AND NEW.expires_at <> OLD.expires_at)
       OR EXISTS (SELECT 1 FROM scheduler_execution_leases WHERE task_id = OLD.task_id AND epoch > OLD.epoch) THEN
      RAISE EXCEPTION 'Execution lease mutation is stale or rewrites history';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduler_execution_lease_history BEFORE INSERT OR UPDATE OR DELETE ON scheduler_execution_leases
  FOR EACH ROW EXECUTE FUNCTION artoo_scheduler_execution_lease_history();
