ALTER TABLE goal_automations ADD COLUMN source_handoff jsonb;

ALTER TABLE goal_automations ADD CONSTRAINT goal_automations_source_handoff_chk CHECK (
  source_handoff IS NULL OR
  (execution_mode = 'agent_team' AND release_profile_id IS NOT NULL
    AND source_handoff = '{"version":1,"mode":"automatic"}'::jsonb) IS TRUE
);

-- Historical goals stay fixed to their original computer. Only a new request
-- may grant automatic routing; the grant cannot be added or revoked by a
-- scheduler update after creation. Normal pause/cancel and consent revocation
-- remain the supported ways to stop an existing goal.
CREATE FUNCTION artoo_automatic_source_handoff_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_handoff IS DISTINCT FROM OLD.source_handoff THEN
    RAISE EXCEPTION 'Automatic source handoff authorization is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER goal_automations_source_handoff_immutable
  BEFORE UPDATE ON goal_automations FOR EACH ROW EXECUTE FUNCTION artoo_automatic_source_handoff_immutable();
