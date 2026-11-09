-- New-goal application authorization only. Existing manual/static goals stay SQL NULL.
ALTER TABLE goal_automations ADD COLUMN app_delivery jsonb;
--> statement-breakpoint
ALTER TABLE goal_automations ADD CONSTRAINT goal_automations_app_delivery_chk CHECK (
  app_delivery IS NULL OR (execution_mode = 'agent_team' AND status <> 'completed' AND source_handoff IS NULL AND release_profile_id IS NULL
    AND app_delivery = '{"version":1,"kind":"local-application-development"}'::jsonb) IS TRUE
);
--> statement-breakpoint
CREATE FUNCTION artoo_application_delivery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.app_delivery IS DISTINCT FROM OLD.app_delivery THEN
    RAISE EXCEPTION 'Application development authorization is immutable';
  END IF;
  IF OLD.app_delivery IS NOT NULL AND
    (NEW.goal_id, NEW.organization_id, NEW.actor_user_id, NEW.consent_id, NEW.policy_version, NEW.verification_profile_id)
    IS DISTINCT FROM
    (OLD.goal_id, OLD.organization_id, OLD.actor_user_id, OLD.consent_id, OLD.policy_version, OLD.verification_profile_id) THEN
    RAISE EXCEPTION 'Application development authorization owner is immutable';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER goal_automations_app_delivery_immutable BEFORE UPDATE ON goal_automations
  FOR EACH ROW EXECUTE FUNCTION artoo_application_delivery_immutable();
