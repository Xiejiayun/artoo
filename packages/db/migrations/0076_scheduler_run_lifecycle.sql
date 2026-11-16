CREATE TABLE scheduler_run_credentials (
  id text PRIMARY KEY,
  lease_id text NOT NULL REFERENCES scheduler_execution_leases(id),
  secret_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT scheduler_run_credential_lease_unique UNIQUE (lease_id),
  CONSTRAINT scheduler_run_credential_hash_chk CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT scheduler_run_credential_time_chk CHECK (isfinite(created_at) AND
    (revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at >= created_at)))
);
--> statement-breakpoint
CREATE TABLE scheduler_run_stop_intents (
  lease_id text PRIMARY KEY REFERENCES scheduler_execution_leases(id),
  requested_by_user_id text NOT NULL,
  requested_at timestamptz NOT NULL CHECK (isfinite(requested_at))
);
--> statement-breakpoint
CREATE FUNCTION artoo_scheduler_run_credential_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Scheduler Run credential history cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
       (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at') THEN
      RAISE EXCEPTION 'Scheduler Run credential mutation rewrites history';
    END IF;
  ELSIF NEW.revoked_at IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM scheduler_execution_leases l JOIN scheduler_start_grants g ON g.request_id=l.request_id
    JOIN runs r ON r.id=g.run_id
    WHERE l.id=NEW.lease_id AND l.state='active' AND l.observed_at<=NEW.created_at AND l.expires_at>NEW.created_at
      AND r.status IN ('queued','starting','running','paused','awaiting_input') AND r.ended_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM scheduler_execution_leases newer WHERE newer.task_id=l.task_id AND newer.epoch>l.epoch)
    FOR SHARE OF l,r NOWAIT
  ) THEN RAISE EXCEPTION 'Scheduler Run credential requires its exact active lease'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduler_run_credential_history BEFORE INSERT OR UPDATE OR DELETE ON scheduler_run_credentials
FOR EACH ROW EXECUTE FUNCTION artoo_scheduler_run_credential_history();
--> statement-breakpoint
CREATE FUNCTION artoo_scheduler_run_credential_revoke_lease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state<>'active' THEN
    UPDATE scheduler_run_credentials SET revoked_at=greatest(created_at,NEW.observed_at)
    WHERE lease_id=NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduler_run_credential_revoke_lease AFTER UPDATE OF state ON scheduler_execution_leases
FOR EACH ROW EXECUTE FUNCTION artoo_scheduler_run_credential_revoke_lease();
--> statement-breakpoint
CREATE FUNCTION artoo_scheduler_run_credential_revoke_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revocation_time timestamptz := coalesce(NEW.ended_at,clock_timestamp());
BEGIN
  IF NEW.status IN ('completed','failed','cancelled') OR NEW.ended_at IS NOT NULL THEN
    UPDATE scheduler_run_credentials c SET revoked_at=greatest(c.created_at,revocation_time)
    FROM scheduler_execution_leases l JOIN scheduler_start_grants g ON g.request_id=l.request_id
    WHERE c.lease_id=l.id AND g.run_id=NEW.id AND c.revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduler_run_credential_revoke_run AFTER UPDATE OF status,ended_at ON runs
FOR EACH ROW EXECUTE FUNCTION artoo_scheduler_run_credential_revoke_run();
--> statement-breakpoint
CREATE FUNCTION artoo_scheduler_stop_intent_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Scheduler Stop intent history is immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM scheduler_execution_leases l JOIN scheduler_start_grants g ON g.request_id=l.request_id
    JOIN runs r ON r.id=g.run_id WHERE l.id=NEW.lease_id
    AND r.status IN ('queued','starting','running','paused','awaiting_input') AND r.ended_at IS NULL
    FOR SHARE OF l,r NOWAIT) THEN RAISE EXCEPTION 'Scheduler Stop intent requires an active Run'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduler_stop_intent_history BEFORE INSERT OR UPDATE OR DELETE ON scheduler_run_stop_intents
FOR EACH ROW EXECUTE FUNCTION artoo_scheduler_stop_intent_history();
