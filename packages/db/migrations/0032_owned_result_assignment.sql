ALTER TABLE runs ADD COLUMN owned_result_assignment jsonb
  CONSTRAINT runs_owned_result_assignment_chk CHECK (
    owned_result_assignment IS NULL OR
    (jsonb_typeof(owned_result_assignment) = 'object' AND owned_result_assignment -> 'version' = '1'::jsonb
      AND workspace_allocation IS NOT NULL AND verification_requirement IS NULL) IS TRUE
  );
--> statement-breakpoint

-- Assignment is created with the run, before any possible exposure. Mode removal
-- or replacing the original payload must never turn a retained attempt into legacy.
CREATE FUNCTION artoo_preserve_owned_result_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owned_result_assignment IS DISTINCT FROM OLD.owned_result_assignment THEN
    RAISE EXCEPTION 'owned result assignment is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runs_owned_result_assignment_immutable
  BEFORE UPDATE OF owned_result_assignment ON runs
  FOR EACH ROW EXECUTE FUNCTION artoo_preserve_owned_result_assignment();
