-- Whole-supervisor clean closure is a new history. H9 surviving-Guardian records
-- and all previous lock/epoch semantics remain unchanged.
CREATE TABLE source_workspace_lineages (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), computer_id text NOT NULL REFERENCES computers(id),
  device_id text NOT NULL REFERENCES devices(id), workspace_root text NOT NULL, workspace_identity_digest text NOT NULL,
  stable jsonb NOT NULL, stable_digest text NOT NULL, initial_registration jsonb NOT NULL,
  current_registration_id text NOT NULL REFERENCES node_recovery_registrations(id), current_generation_id text NOT NULL,
  revision integer NOT NULL DEFAULT 0, state text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  CONSTRAINT source_workspace_lineage_physical_uniq UNIQUE(organization_id,computer_id,workspace_identity_digest),
  CONSTRAINT source_workspace_lineage_root_uniq UNIQUE(organization_id,computer_id,workspace_root),
  CONSTRAINT source_workspace_lineage_revision_chk CHECK(revision>=0),
  CONSTRAINT source_workspace_lineage_state_chk CHECK(state IN ('active','closing','closed','reserved','recovery')),
  CONSTRAINT source_workspace_lineage_digest_chk CHECK(stable_digest ~ '^sha256:[a-f0-9]{64}$' AND workspace_identity_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE source_clean_stops (
  id text PRIMARY KEY, lineage_id text NOT NULL REFERENCES source_workspace_lineages(id), organization_id text NOT NULL REFERENCES organizations(id),
  generation_id text NOT NULL, observer_id text NOT NULL, registration_id text NOT NULL REFERENCES node_recovery_registrations(id),
  intent_digest text NOT NULL, intent jsonb NOT NULL, closure_digest text, closure jsonb, receipt jsonb, created_at timestamptz NOT NULL, closed_at timestamptz,
  CONSTRAINT source_clean_stop_generation_uniq UNIQUE(lineage_id,generation_id), CONSTRAINT source_clean_stop_observer_uniq UNIQUE(observer_id),
  CONSTRAINT source_clean_stop_digest_chk CHECK(intent_digest ~ '^sha256:[a-f0-9]{64}$' AND (closure_digest IS NULL OR closure_digest ~ '^sha256:[a-f0-9]{64}$')),
  CONSTRAINT source_clean_stop_closure_chk CHECK((closure IS NULL AND closure_digest IS NULL AND receipt IS NULL AND closed_at IS NULL) OR
    (closure IS NOT NULL AND closure_digest IS NOT NULL AND receipt IS NOT NULL AND closed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE source_clean_generations (
  id text PRIMARY KEY, lineage_id text NOT NULL REFERENCES source_workspace_lineages(id), organization_id text NOT NULL REFERENCES organizations(id),
  predecessor_stop_id text NOT NULL REFERENCES source_clean_stops(id), claimant_observer_id text NOT NULL,
  grant_digest text NOT NULL, "grant" jsonb NOT NULL, registration_id text REFERENCES node_recovery_registrations(id), lifecycle_registration jsonb,
  checkpoint_digest text, checkpoint jsonb, receipt jsonb, created_at timestamptz NOT NULL, registered_at timestamptz, checkpointed_at timestamptz,
  settled_at timestamptz, settlement_event_id text REFERENCES event_log(id),
  CONSTRAINT source_clean_generation_predecessor_uniq UNIQUE(predecessor_stop_id), CONSTRAINT source_clean_generation_claimant_uniq UNIQUE(claimant_observer_id),
  CONSTRAINT source_clean_generation_registration_uniq UNIQUE(registration_id),
  CONSTRAINT source_clean_generation_digest_chk CHECK(grant_digest ~ '^sha256:[a-f0-9]{64}$' AND (checkpoint_digest IS NULL OR checkpoint_digest ~ '^sha256:[a-f0-9]{64}$')),
  CONSTRAINT source_clean_generation_registration_chk CHECK((registration_id IS NULL AND lifecycle_registration IS NULL AND registered_at IS NULL) OR
    (registration_id IS NOT NULL AND lifecycle_registration IS NOT NULL AND registered_at IS NOT NULL)),
  CONSTRAINT source_clean_generation_checkpoint_chk CHECK((checkpoint IS NULL AND checkpoint_digest IS NULL AND receipt IS NULL AND checkpointed_at IS NULL) OR
    (checkpoint IS NOT NULL AND checkpoint_digest IS NOT NULL AND receipt IS NOT NULL AND checkpointed_at IS NOT NULL AND registration_id IS NOT NULL)),
  CONSTRAINT source_clean_generation_settlement_chk CHECK((settled_at IS NULL AND settlement_event_id IS NULL) OR
    (settled_at IS NOT NULL AND settlement_event_id IS NOT NULL AND checkpoint IS NOT NULL))
);
--> statement-breakpoint
CREATE FUNCTION protect_source_workspace_lineage_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r node_recovery_registrations%ROWTYPE; g source_clean_generations%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Source workspace lineage occupancy cannot be removed'; END IF;
  IF NEW.stable_digest IS DISTINCT FROM artoo_release_retry_digest_v1(NEW.stable)
    OR (NEW.stable->'version'='1'::jsonb AND NEW.stable->>'node_id'=NEW.computer_id AND NEW.stable->>'device_id'=NEW.device_id
      AND NEW.stable->>'workspace_root'=NEW.workspace_root AND NEW.stable->>'workspace_identity_digest'=NEW.workspace_identity_digest) IS NOT TRUE
    THEN RAISE EXCEPTION 'Source lineage requires its exact physical stable configuration'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO r FROM node_recovery_registrations WHERE id=NEW.current_registration_id;
    IF NEW.state<>'active' OR NEW.revision<>0 OR r.id IS NULL OR r.organization_id<>NEW.organization_id OR r.computer_id<>NEW.computer_id OR r.device_id<>NEW.device_id
      OR r.workspace_root<>NEW.workspace_root OR r.workspace_identity_digest<>NEW.workspace_identity_digest
      OR NEW.initial_registration->'registration' IS DISTINCT FROM r.registration
      OR NEW.initial_registration->'launch'->'stable' IS DISTINCT FROM NEW.stable
      OR NEW.initial_registration ? 'successor_grant_digest'
      THEN RAISE EXCEPTION 'Initial source lineage has no exact original paired registration'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['state','revision','current_generation_id','current_registration_id','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['state','revision','current_generation_id','current_registration_id','updated_at'])
      OR NEW.revision<>OLD.revision+1 OR NOT ((OLD.state='active' AND NEW.state='closing') OR (OLD.state='closing' AND NEW.state='closed')
        OR (OLD.state='closed' AND NEW.state='reserved') OR (OLD.state='reserved' AND NEW.state='recovery') OR (OLD.state='recovery' AND NEW.state='closing'))
      THEN RAISE EXCEPTION 'Source lineage transition is immutable or invalid'; END IF;
    IF NEW.current_generation_id<>OLD.current_generation_id OR NEW.current_registration_id<>OLD.current_registration_id THEN
      SELECT * INTO g FROM source_clean_generations WHERE id=NEW.current_generation_id;
      IF OLD.state<>'reserved' OR NEW.state<>'recovery' OR g.id IS NULL OR g.lineage_id<>NEW.id OR g.organization_id<>NEW.organization_id
        OR g.registration_id<>NEW.current_registration_id OR g.settled_at IS NULL OR g.checkpoint IS NULL
        THEN RAISE EXCEPTION 'Only a committed GoalRunner settlement can transfer the physical lineage'; END IF;
    ELSIF OLD.state='reserved' AND NEW.state='recovery' THEN RAISE EXCEPTION 'Recovery requires a distinct registered generation'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER source_workspace_lineages_protected BEFORE INSERT OR UPDATE OR DELETE ON source_workspace_lineages FOR EACH ROW EXECUTE FUNCTION protect_source_workspace_lineage_v1();
--> statement-breakpoint
CREATE FUNCTION protect_source_clean_stop_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l source_workspace_lineages%ROWTYPE; r node_recovery_registrations%ROWTYPE; e event_log%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Clean stop history is immutable'; END IF;
  SELECT * INTO l FROM source_workspace_lineages WHERE id=NEW.lineage_id;
  SELECT * INTO r FROM node_recovery_registrations WHERE id=NEW.registration_id;
  IF l.id IS NULL OR r.id IS NULL OR l.organization_id<>NEW.organization_id OR r.organization_id<>NEW.organization_id
    OR NEW.intent_digest IS DISTINCT FROM artoo_release_retry_digest_v1(NEW.intent)
    OR (NEW.intent->'version'='1'::jsonb AND NEW.intent->>'stop_id'=NEW.id AND NEW.intent->>'lineage_id'=NEW.lineage_id
      AND NEW.intent->>'generation_id'=NEW.generation_id AND NEW.intent->'registration'=r.registration
      AND NEW.intent->'launch'->>'observer_id'=NEW.observer_id AND NEW.intent->'launch'->'stable'=l.stable) IS NOT TRUE
    THEN RAISE EXCEPTION 'Clean stop changed its exact immutable intent or lineage'; END IF;
  IF TG_OP='INSERT' THEN
    IF l.state NOT IN ('active','recovery') OR l.current_generation_id<>NEW.generation_id OR l.current_registration_id<>NEW.registration_id
      OR NEW.closure IS NOT NULL THEN RAISE EXCEPTION 'Clean stop requires the current original native generation'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['closure','closure_digest','receipt','closed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['closure','closure_digest','receipt','closed_at'])
      OR OLD.closure IS NOT NULL OR NEW.closure IS NULL OR l.state<>'closing'
      THEN RAISE EXCEPTION 'Clean closure is a write-once original-observer fact'; END IF;
    SELECT * INTO e FROM event_log WHERE id=NEW.receipt->>'committed_event_id';
    IF NEW.closure_digest IS DISTINCT FROM artoo_release_retry_digest_v1(NEW.closure)
      OR (NEW.closure->'version'='1'::jsonb AND NEW.closure->>'kind'='whole-supervisor-job-closed.v1'
        AND NEW.closure->>'stop_id'=NEW.id AND NEW.closure->>'intent_digest'=NEW.intent_digest AND NEW.closure->>'observer_id'=NEW.observer_id
        AND NEW.closure->'supervisor'=NEW.intent->'launch'->'supervisor' AND NEW.closure->>'launch_identity_digest'=NEW.intent->'launch'->>'launch_identity_digest'
        AND NEW.receipt->>'stop_id'=NEW.id AND NEW.receipt->>'lineage_id'=NEW.lineage_id AND NEW.receipt->>'generation_id'=NEW.generation_id
        AND NEW.receipt->>'intent_digest'=NEW.intent_digest AND NEW.receipt->>'closure_digest'=NEW.closure_digest) IS NOT TRUE
      OR e.id IS NULL OR e.organization_id<>NEW.organization_id OR e.type<>'node.source-clean-stop.committed'
      THEN RAISE EXCEPTION 'Clean closure lacks its exact committed observer event'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER source_clean_stops_protected BEFORE INSERT OR UPDATE OR DELETE ON source_clean_stops FOR EACH ROW EXECUTE FUNCTION protect_source_clean_stop_v1();
--> statement-breakpoint
CREATE FUNCTION protect_source_clean_generation_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s source_clean_stops%ROWTYPE; l source_workspace_lineages%ROWTYPE; r node_recovery_registrations%ROWTYPE; e event_log%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'A claimed source generation cannot be discarded'; END IF;
  SELECT * INTO s FROM source_clean_stops WHERE id=NEW.predecessor_stop_id;
  SELECT * INTO l FROM source_workspace_lineages WHERE id=NEW.lineage_id;
  IF s.id IS NULL OR l.id IS NULL OR s.closure IS NULL OR s.lineage_id<>NEW.lineage_id OR s.organization_id<>NEW.organization_id OR l.organization_id<>NEW.organization_id
    OR NEW.grant_digest IS DISTINCT FROM artoo_release_retry_digest_v1(NEW."grant")
    OR (NEW."grant"->'version'='1'::jsonb AND NEW."grant"->>'generation_id'=NEW.id AND NEW."grant"->>'lineage_id'=NEW.lineage_id
      AND NEW."grant"->>'predecessor_generation_id'=s.generation_id AND NEW."grant"->'predecessor'=s.receipt AND NEW."grant"->'stable'=l.stable
      AND NEW."grant"->>'predecessor_history_digest'=s.closure->>'retained_history_digest'
      AND NEW."grant"->>'claimant_observer_id'=NEW.claimant_observer_id AND NEW."grant"->>'scope'='unverified-h7-recovery') IS NOT TRUE
    THEN RAISE EXCEPTION 'Fresh generation lacks its exact committed predecessor closure'; END IF;
  IF TG_OP='INSERT' THEN
    IF l.state<>'closed' OR l.current_generation_id<>s.generation_id OR NEW.registration_id IS NOT NULL OR NEW.checkpoint IS NOT NULL OR NEW.settled_at IS NOT NULL
      THEN RAISE EXCEPTION 'Successor reservation requires the unclaimed closed physical lineage'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['registration_id','lifecycle_registration','registered_at','checkpoint_digest','checkpoint','receipt','checkpointed_at','settled_at','settlement_event_id']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['registration_id','lifecycle_registration','registered_at','checkpoint_digest','checkpoint','receipt','checkpointed_at','settled_at','settlement_event_id'])
      OR l.state<>'reserved' OR OLD.settled_at IS NOT NULL
      OR OLD.lifecycle_registration IS NOT NULL AND (NEW.lifecycle_registration IS DISTINCT FROM OLD.lifecycle_registration OR NEW.registration_id IS DISTINCT FROM OLD.registration_id OR NEW.registered_at IS DISTINCT FROM OLD.registered_at)
      OR OLD.checkpoint IS NOT NULL AND (NEW.checkpoint IS DISTINCT FROM OLD.checkpoint OR NEW.checkpoint_digest IS DISTINCT FROM OLD.checkpoint_digest OR NEW.receipt IS DISTINCT FROM OLD.receipt OR NEW.checkpointed_at IS DISTINCT FROM OLD.checkpointed_at)
      THEN RAISE EXCEPTION 'Source generation facts are write-once while reservation is retained'; END IF;
    IF NEW.registration_id IS NOT NULL THEN
      SELECT * INTO r FROM node_recovery_registrations WHERE id=NEW.registration_id;
      IF r.id IS NULL OR r.organization_id<>NEW.organization_id OR r.computer_id<>l.computer_id OR r.device_id<>l.device_id
        OR r.registration IS DISTINCT FROM NEW.lifecycle_registration->'registration'
        OR NEW.lifecycle_registration->>'successor_grant_digest' IS DISTINCT FROM NEW.grant_digest
        OR NEW.lifecycle_registration->'launch'->>'observer_id' IS DISTINCT FROM NEW.claimant_observer_id
        OR NEW.lifecycle_registration->'launch'->'stable' IS DISTINCT FROM l.stable
        OR r.store_identity_digest=s.intent->'registration'->'binding'->>'store_identity_digest'
        OR r.guardian_instance_id=s.intent->'registration'->'binding'->>'guardian_instance_id'
        OR r.session_id=s.intent->'registration'->'epoch'->>'session_id' OR r.epoch_id=s.intent->'registration'->'epoch'->>'epoch_id'
        THEN RAISE EXCEPTION 'Clean successor requires a distinct fresh store Guardian and paired session'; END IF;
    END IF;
    IF NEW.checkpoint IS NOT NULL THEN
      SELECT * INTO e FROM event_log WHERE id=NEW.receipt->>'committed_event_id';
      IF NEW.checkpoint_digest IS DISTINCT FROM artoo_release_retry_digest_v1(NEW.checkpoint)
        OR (NEW.checkpoint->>'generation_id'=NEW.id AND NEW.checkpoint->>'lineage_id'=NEW.lineage_id AND NEW.checkpoint->>'grant_digest'=NEW.grant_digest
          AND NEW.checkpoint->'lifecycle_registration'=NEW.lifecycle_registration AND NEW.checkpoint->>'source_state'='unverified'
          AND NEW.checkpoint->>'predecessor_history_digest'=NEW."grant"->>'predecessor_history_digest'
          AND NEW.receipt->>'generation_id'=NEW.id AND NEW.receipt->>'checkpoint_digest'=NEW.checkpoint_digest
          AND NEW.receipt->>'grant_digest'=NEW.grant_digest AND NEW.receipt->>'registration_id'=NEW.registration_id AND NEW.receipt->>'session_id'=r.session_id) IS NOT TRUE
        OR e.id IS NULL OR e.organization_id<>NEW.organization_id OR e.type<>'node.source-clean-restart.checkpointed'
        THEN RAISE EXCEPTION 'Clean checkpoint requires its exact committed unverified receipt'; END IF;
    END IF;
    IF NEW.settled_at IS NOT NULL THEN
      SELECT * INTO e FROM event_log WHERE id=NEW.settlement_event_id;
      IF e.id IS NULL OR e.organization_id<>NEW.organization_id OR e.type<>'goal.source-clean-restart.settled' OR e.actor_type<>'system' OR e.actor_id<>'goal_runner'
        OR e.payload->>'generation_id' IS DISTINCT FROM NEW.id OR e.payload->>'checkpoint_digest' IS DISTINCT FROM NEW.checkpoint_digest
        THEN RAISE EXCEPTION 'Only GoalRunner may settle a committed clean checkpoint'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER source_clean_generations_protected BEFORE INSERT OR UPDATE OR DELETE ON source_clean_generations FOR EACH ROW EXECUTE FUNCTION protect_source_clean_generation_v1();
