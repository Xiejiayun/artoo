CREATE TABLE scheduler_attempt_credentials (
  id text PRIMARY KEY,
  lease_id text NOT NULL REFERENCES scheduler_execution_leases(id),
  secret_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT scheduler_attempt_credential_lease_unique UNIQUE (lease_id),
  CONSTRAINT scheduler_attempt_credential_hash_chk CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT scheduler_attempt_credential_time_chk CHECK ((isfinite(created_at) AND isfinite(observed_at) AND isfinite(expires_at)
    AND observed_at >= created_at AND expires_at > created_at
    AND ((revoked_at IS NULL AND expires_at > observed_at) OR revoked_at = observed_at)) IS TRUE)
);
--> statement-breakpoint
CREATE FUNCTION artoo_scheduler_attempt_credential_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Attempt credential history cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.created_at <> NEW.observed_at THEN
      RAISE EXCEPTION 'Attempt credential requires a fresh observation';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - 'observed_at' - 'expires_at' - 'revoked_at') IS DISTINCT FROM
       (to_jsonb(OLD) - 'observed_at' - 'expires_at' - 'revoked_at')
       OR OLD.revoked_at IS NOT NULL OR NEW.observed_at < OLD.observed_at
       OR (NEW.revoked_at IS NOT NULL AND NEW.expires_at <> OLD.expires_at)
       OR (NEW.revoked_at IS NULL AND (NEW.observed_at >= OLD.expires_at OR NEW.expires_at < OLD.expires_at)) THEN
      RAISE EXCEPTION 'Attempt credential mutation is stale or rewrites history';
    END IF;
  END IF;
  IF NEW.revoked_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM scheduler_execution_leases l JOIN scheduler_start_grants g ON g.request_id = l.request_id
    JOIN runs r ON r.id = g.run_id
    WHERE l.id = NEW.lease_id AND l.state = 'active' AND l.observed_at <= NEW.observed_at
      AND NEW.expires_at <= l.expires_at AND NEW.observed_at < l.expires_at
      AND r.status IN ('queued','starting','running','paused','awaiting_input') AND r.ended_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM scheduler_execution_leases newer WHERE newer.task_id = l.task_id AND newer.epoch > l.epoch)
    FOR SHARE OF l,r NOWAIT
  ) THEN RAISE EXCEPTION 'Attempt credential requires its exact current execution lease'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduler_attempt_credential_history BEFORE INSERT OR UPDATE OR DELETE ON scheduler_attempt_credentials
  FOR EACH ROW EXECUTE FUNCTION artoo_scheduler_attempt_credential_history();
--> statement-breakpoint
CREATE FUNCTION artoo_scheduler_attempt_credential_revoke_lease() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'active' THEN
    UPDATE scheduler_attempt_credentials SET observed_at=greatest(observed_at,NEW.observed_at),
      revoked_at=greatest(observed_at,NEW.observed_at) WHERE lease_id=NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduler_attempt_credential_revoke_lease AFTER UPDATE OF state ON scheduler_execution_leases
  FOR EACH ROW EXECUTE FUNCTION artoo_scheduler_attempt_credential_revoke_lease();
--> statement-breakpoint
CREATE FUNCTION artoo_scheduler_attempt_credential_revoke_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revocation_time timestamptz := coalesce(NEW.ended_at,clock_timestamp());
BEGIN
  IF NEW.status IN ('completed','failed','cancelled') OR NEW.ended_at IS NOT NULL THEN
    UPDATE scheduler_attempt_credentials c SET observed_at=greatest(c.observed_at,revocation_time),
      revoked_at=greatest(c.observed_at,revocation_time)
      FROM scheduler_execution_leases l JOIN scheduler_start_grants g ON g.request_id=l.request_id
      WHERE c.lease_id=l.id AND g.run_id=NEW.id AND c.revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduler_attempt_credential_revoke_run AFTER UPDATE OF status,ended_at ON runs
  FOR EACH ROW EXECUTE FUNCTION artoo_scheduler_attempt_credential_revoke_run();
