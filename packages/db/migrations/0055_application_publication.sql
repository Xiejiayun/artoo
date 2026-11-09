-- Independent original-user publication consent. 0054 remains development-only.
ALTER TABLE goal_automations ADD COLUMN app_publication jsonb;
--> statement-breakpoint
ALTER TABLE goal_automations ADD COLUMN application_publication_authorization_event_id text REFERENCES event_log(id);
--> statement-breakpoint
ALTER TABLE goal_automations ADD CONSTRAINT goal_automations_app_publication_chk CHECK (
  (app_publication IS NULL AND application_publication_authorization_event_id IS NULL) OR
  (app_publication IS NOT NULL AND application_publication_authorization_event_id IS NOT NULL AND execution_mode='agent_team'
    AND app_delivery IS NULL AND source_handoff IS NULL AND release_profile_id IS NULL
    AND app_publication=jsonb_build_object('version',1,'kind','same-computer-local-application-publication',
      'publication_profile_id',app_publication->>'publication_profile_id')
    AND (app_publication->>'publication_profile_id') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') IS TRUE
);
--> statement-breakpoint
CREATE TABLE application_publications (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id),
  project_id text NOT NULL REFERENCES projects(id), computer_id text NOT NULL REFERENCES computers(id), publisher_session_id text NOT NULL,
  authorization_event_id text NOT NULL REFERENCES event_log(id), request jsonb NOT NULL, request_digest text NOT NULL,
  status text NOT NULL, receipt jsonb, receipt_digest text, receipt_event_id text REFERENCES event_log(id),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  CONSTRAINT application_publications_goal_uniq UNIQUE(goal_id),
  CONSTRAINT application_publications_status_chk CHECK(status IN ('queued','published','failed')),
  CONSTRAINT application_publications_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND (receipt_digest IS NULL OR receipt_digest ~ '^sha256:[a-f0-9]{64}$')),
  CONSTRAINT application_publications_receipt_chk CHECK(
    (status='queued' AND receipt IS NULL AND receipt_digest IS NULL AND receipt_event_id IS NULL) OR
    (status IN ('published','failed') AND receipt IS NOT NULL AND receipt_digest IS NOT NULL AND receipt_event_id IS NOT NULL AND receipt->>'outcome'=status) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE application_publication_observations (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), publication_id text NOT NULL REFERENCES application_publications(id),
  publisher_session_id text NOT NULL, sequence integer NOT NULL, generation integer NOT NULL, state text NOT NULL,
  request_digest text NOT NULL, payload jsonb NOT NULL, payload_digest text NOT NULL, event_id text NOT NULL REFERENCES event_log(id), created_at timestamptz NOT NULL,
  CONSTRAINT application_publication_observation_sequence_uniq UNIQUE(publication_id,publisher_session_id,sequence),
  CONSTRAINT application_publication_observation_sequence_chk CHECK(sequence>=1 AND generation=2),
  CONSTRAINT application_publication_observation_state_chk CHECK(state IN ('healthy','live','draining','closed-normal','closed-aborted','expired','unknown')),
  CONSTRAINT application_publication_observation_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND payload_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE application_publication_settlements (
  goal_id text PRIMARY KEY REFERENCES goals(id), organization_id text NOT NULL REFERENCES organizations(id), publication_id text NOT NULL REFERENCES application_publications(id),
  request_digest text NOT NULL, receipt_digest text NOT NULL, authorization_event_id text NOT NULL REFERENCES event_log(id),
  observation_id text NOT NULL REFERENCES application_publication_observations(id), observation_sequence integer NOT NULL,
  lease_id text NOT NULL, deadline_at timestamptz NOT NULL, scope text NOT NULL, event_id text NOT NULL REFERENCES event_log(id), created_at timestamptz NOT NULL,
  CONSTRAINT application_publication_settlement_publication_uniq UNIQUE(publication_id),
  CONSTRAINT application_publication_settlement_scope_chk CHECK(scope='bounded-local-application-publication' AND observation_sequence>=1),
  CONSTRAINT application_publication_settlement_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND receipt_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE FUNCTION artoo_application_publication_grant_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e event_log; g goals;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.app_publication IS NOT NULL THEN RAISE EXCEPTION 'Application publication authorization history is immutable'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.app_publication,NEW.application_publication_authorization_event_id) IS DISTINCT FROM
      (OLD.app_publication,OLD.application_publication_authorization_event_id) THEN RAISE EXCEPTION 'Application publication authorization is immutable'; END IF;
    IF OLD.app_publication IS NOT NULL AND ((NEW.goal_id,NEW.organization_id,NEW.actor_user_id,NEW.consent_id,NEW.policy_version,NEW.verification_profile_id,NEW.execution_mode)
      IS DISTINCT FROM (OLD.goal_id,OLD.organization_id,OLD.actor_user_id,OLD.consent_id,OLD.policy_version,OLD.verification_profile_id,OLD.execution_mode)
      OR OLD.planning_capability_snapshot IS NOT NULL AND NEW.planning_capability_snapshot IS DISTINCT FROM OLD.planning_capability_snapshot)
      THEN RAISE EXCEPTION 'Application publication authorizer and captured routing are immutable'; END IF;
  END IF;
  IF NEW.app_publication IS NOT NULL THEN
    SELECT * INTO e FROM event_log WHERE id=NEW.application_publication_authorization_event_id;
    SELECT * INTO g FROM goals WHERE id=NEW.goal_id;
    IF e.id IS NULL OR g.id IS NULL OR e.organization_id<>NEW.organization_id OR g.organization_id<>NEW.organization_id
      OR e.goal_id IS DISTINCT FROM NEW.goal_id OR e.project_id IS DISTINCT FROM g.project_id
      OR e.type<>'goal.application-publication.authorized' OR e.actor_type<>'user' OR e.actor_id<>NEW.actor_user_id
      OR e.payload->'app_publication' IS DISTINCT FROM NEW.app_publication
      OR e.payload->'authorization' IS DISTINCT FROM jsonb_build_object('version',1,'event_id',e.id,'actor_user_id',NEW.actor_user_id,
        'consent_id',NEW.consent_id,'policy_version',NEW.policy_version,'grant',NEW.app_publication)
      OR e.payload->>'verification_profile_id' IS DISTINCT FROM NEW.verification_profile_id
      OR coalesce(e.payload->>'publisher_session_id','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      OR e.payload->'capabilities'->'version' IS DISTINCT FROM '1'::jsonb
      OR e.payload->'capabilities'->'binding'->>'publication_profile_id' IS DISTINCT FROM NEW.app_publication->>'publication_profile_id'
      OR e.payload->'capabilities'->'binding'->>'project_id' IS DISTINCT FROM g.project_id
      OR e.payload->'capabilities'->'binding'->>'verification_profile_id' IS DISTINCT FROM NEW.verification_profile_id
      OR NEW.computer_id IS NOT NULL AND e.payload->'capabilities'->'binding'->>'computer_id' IS DISTINCT FROM NEW.computer_id
      THEN RAISE EXCEPTION 'Application publication requires its exact original user event, goal, consent and protected capability'; END IF;
    IF NEW.status='completed' AND NOT EXISTS(SELECT 1 FROM application_publication_settlements s
      WHERE s.goal_id=NEW.goal_id AND s.organization_id=NEW.organization_id AND s.authorization_event_id=e.id)
      THEN RAISE EXCEPTION 'Application publication completion requires its immutable publication settlement'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_automations_application_publication_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_automations
  FOR EACH ROW EXECUTE FUNCTION artoo_application_publication_grant_v1();
--> statement-breakpoint
CREATE FUNCTION artoo_application_publication_record_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a goal_automations; g goals; grant_event event_log; e event_log; source jsonb; evidence run_evidence; r runs; instance agent_instances; context context_packs;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Application publication history is immutable'; END IF;
  IF TG_OP='INSERT' AND NEW.status<>'queued' THEN RAISE EXCEPTION 'Application publication starts from its immutable queued request'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.organization_id,NEW.goal_id,NEW.project_id,NEW.computer_id,NEW.publisher_session_id,NEW.authorization_event_id,NEW.request,NEW.request_digest,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.goal_id,OLD.project_id,OLD.computer_id,OLD.publisher_session_id,OLD.authorization_event_id,OLD.request,OLD.request_digest,OLD.created_at)
      THEN RAISE EXCEPTION 'Application publication request and original publisher lineage are immutable'; END IF;
    IF OLD.receipt IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Terminal application publication receipt is immutable'; END IF;
  END IF;
  SELECT * INTO a FROM goal_automations WHERE goal_id=NEW.goal_id;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id;
  SELECT * INTO grant_event FROM event_log WHERE id=NEW.authorization_event_id;
  IF a.goal_id IS NULL OR g.id IS NULL OR grant_event.id IS NULL OR a.app_publication IS NULL
    OR a.organization_id<>NEW.organization_id OR g.organization_id<>NEW.organization_id OR g.project_id<>NEW.project_id
    OR a.application_publication_authorization_event_id IS DISTINCT FROM NEW.authorization_event_id
    OR NEW.request_digest IS DISTINCT FROM artoo_release_retry_digest_v1(NEW.request)
    OR NEW.request->'version' IS DISTINCT FROM '1'::jsonb OR NEW.request->>'publication_id' IS DISTINCT FROM NEW.id
    OR NEW.request->>'goal_id' IS DISTINCT FROM NEW.goal_id OR NEW.request->>'project_id' IS DISTINCT FROM NEW.project_id
    OR NEW.request->>'computer_id' IS DISTINCT FROM NEW.computer_id OR NEW.request->>'publisher_session_id' IS DISTINCT FROM NEW.publisher_session_id
    OR NEW.request->'authorization' IS DISTINCT FROM grant_event.payload->'authorization'
    OR NEW.publisher_session_id IS DISTINCT FROM grant_event.payload->>'publisher_session_id'
    OR NEW.request->'capabilities' IS DISTINCT FROM grant_event.payload->'capabilities'
    THEN RAISE EXCEPTION 'Application publication request differs from its original authorized goal and publisher'; END IF;
  IF TG_OP='INSERT' THEN
    FOREACH source IN ARRAY ARRAY[NEW.request->'author',NEW.request->'reviewer'] LOOP
      SELECT * INTO evidence FROM run_evidence WHERE id=source->>'evidence_id';
      SELECT * INTO r FROM runs WHERE id=source->>'run_id';
      SELECT * INTO instance FROM agent_instances WHERE id=r.agent_instance_id;
      SELECT * INTO context FROM context_packs WHERE id=r.context_pack_id;
      IF evidence.id IS NULL OR r.id IS NULL OR instance.id IS NULL OR context.id IS NULL OR evidence.organization_id<>NEW.organization_id
        OR context.organization_id<>NEW.organization_id OR context.run_id<>r.id OR context.task_id<>r.task_id
        OR context.payload->'application_publication'->>'publisher_session_id' IS DISTINCT FROM NEW.publisher_session_id
        OR context.payload->'application_publication'->'authorization' IS DISTINCT FROM grant_event.payload->'authorization'
        OR context.payload->'application_publication'->'capabilities' IS DISTINCT FROM grant_event.payload->'capabilities'
        OR r.organization_id<>NEW.organization_id OR r.computer_id<>NEW.computer_id OR r.status<>'completed'
        OR evidence.run_id<>r.id OR evidence.request_id IS DISTINCT FROM source->>'request_id'
        OR r.agent_instance_id IS DISTINCT FROM source->>'agent_instance_id' OR instance.agent_id IS DISTINCT FROM source->>'agent_id'
        OR evidence.payload->'application'->'candidate' IS DISTINCT FROM source->'candidate'
        OR evidence.payload->'application'->>'stage' IS DISTINCT FROM 'validation'
        OR evidence.payload->'application'->'publication'->>'authorization_event_id' IS DISTINCT FROM NEW.authorization_event_id
        OR evidence.payload->'application'->'publication'->>'research_digest' IS DISTINCT FROM NEW.request->'acceptance'->>'research_digest'
        OR evidence.payload->'application'->'publication'->>'design_digest' IS DISTINCT FROM NEW.request->'acceptance'->>'design_digest'
        OR evidence.payload->'application'->'publication'->>'measurement_plan_digest' IS DISTINCT FROM NEW.request->'acceptance'->>'measurement_plan_digest'
        OR evidence.payload->'application'->'publication'->>'application_definition_digest' IS DISTINCT FROM NEW.request->>'application_definition_digest'
        OR evidence.payload->'application'->'publication'->'development_criteria' IS DISTINCT FROM NEW.request->'acceptance'->'development_criteria'
        OR evidence.payload->'application'->'publication'->'publication_criteria' IS DISTINCT FROM NEW.request->'acceptance'->'publication_criteria'
        THEN RAISE EXCEPTION 'Application publication lacks its original committed author/reviewer measurement'; END IF;
    END LOOP;
  END IF;
  IF NEW.receipt IS NOT NULL THEN
    SELECT * INTO e FROM event_log WHERE id=NEW.receipt_event_id;
    IF e.id IS NULL OR e.organization_id<>NEW.organization_id OR e.goal_id IS DISTINCT FROM NEW.goal_id
      OR e.type<>'goal.application-publication.receipt' OR e.actor_type<>'system' OR e.actor_id<>'goal_runner'
      OR e.payload->>'publication_id' IS DISTINCT FROM NEW.id OR e.payload->>'request_digest' IS DISTINCT FROM NEW.request_digest
      OR e.payload->>'receipt_digest' IS DISTINCT FROM NEW.receipt_digest OR e.payload->>'outcome' IS DISTINCT FROM NEW.status
      OR NEW.receipt_digest IS DISTINCT FROM artoo_release_retry_digest_v1(NEW.receipt)
      OR NEW.receipt->'request' IS DISTINCT FROM NEW.request OR NEW.receipt->>'request_digest' IS DISTINCT FROM NEW.request_digest
      OR NEW.receipt->>'scope' IS DISTINCT FROM 'bounded-local-application-publication'
      THEN RAISE EXCEPTION 'Application publication receipt lacks its exact committed system event and immutable request'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER application_publications_protected BEFORE INSERT OR UPDATE OR DELETE ON application_publications
  FOR EACH ROW EXECUTE FUNCTION artoo_application_publication_record_v1();
--> statement-breakpoint
CREATE FUNCTION artoo_application_publication_observation_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p application_publications; previous application_publication_observations; last_live application_publication_observations; e event_log; original_service jsonb; original_native jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Application publication observations are append-only'; END IF;
  SELECT * INTO p FROM application_publications WHERE id=NEW.publication_id FOR UPDATE;
  SELECT * INTO previous FROM application_publication_observations WHERE publication_id=NEW.publication_id ORDER BY sequence DESC LIMIT 1;
  SELECT * INTO last_live FROM application_publication_observations WHERE publication_id=NEW.publication_id
    AND payload->'live' IS NOT NULL AND payload->'live'<>'null'::jsonb ORDER BY sequence DESC LIMIT 1;
  SELECT * INTO e FROM event_log WHERE id=NEW.event_id;
  original_service=p.receipt->'second_service'->'live'->'service';
  original_native=p.receipt->'second_service'->'live'->'native';
  IF p.id IS NULL OR e.id IS NULL OR p.organization_id<>NEW.organization_id OR p.publisher_session_id<>NEW.publisher_session_id
    OR p.status<>'published' OR p.receipt->>'outcome' IS DISTINCT FROM 'published'
    OR original_service IS NULL OR original_service='null'::jsonb OR original_native IS NULL OR original_native='null'::jsonb
    OR NEW.sequence<>COALESCE(previous.sequence,0)+1 OR NEW.request_digest<>p.request_digest
    OR NEW.payload_digest IS DISTINCT FROM artoo_release_retry_digest_v1(NEW.payload)
    OR NEW.payload->'request' IS DISTINCT FROM p.request OR NEW.payload->>'request_digest' IS DISTINCT FROM p.request_digest
    OR NEW.payload->>'event_id' IS DISTINCT FROM NEW.id OR NEW.payload->'sequence' IS DISTINCT FROM to_jsonb(NEW.sequence)
    OR NEW.payload->'generation' IS DISTINCT FROM '2'::jsonb OR NEW.payload->>'state' IS DISTINCT FROM NEW.state
    OR NEW.payload->'lease'->>'publisher_session_id' IS DISTINCT FROM p.publisher_session_id
    OR NEW.payload->'lease'->>'publication_id' IS DISTINCT FROM p.id OR NEW.payload->'lease'->>'request_digest' IS DISTINCT FROM p.request_digest
    OR p.receipt->'lease' IS NOT NULL AND p.receipt->'lease'<>'null'::jsonb AND NEW.payload->'lease' IS DISTINCT FROM p.receipt->'lease'
    OR p.receipt->'deployment' IS NOT NULL AND p.receipt->'deployment'<>'null'::jsonb AND NEW.payload->'deployment' IS DISTINCT FROM p.receipt->'deployment'
    OR previous.id IS NOT NULL AND (NEW.payload->'lease' IS DISTINCT FROM previous.payload->'lease' OR NEW.payload->'deployment' IS DISTINCT FROM previous.payload->'deployment')
    OR previous.state IN ('closed-normal','closed-aborted','expired','unknown') AND NEW.state IN ('healthy','live','draining')
    OR NEW.payload->'health' IS NOT NULL AND NEW.payload->'health'<>'null'::jsonb
      AND NEW.payload->'health'->'service' IS DISTINCT FROM original_service
    OR NEW.payload->'live' IS NOT NULL AND NEW.payload->'live'<>'null'::jsonb AND (
      NEW.payload->'live'->'service' IS DISTINCT FROM original_service
      OR NEW.payload->'live'->'native'->'root_pid' IS DISTINCT FROM original_native->'root_pid'
      OR NEW.payload->'live'->'native'->'root_creation_time' IS DISTINCT FROM original_native->'root_creation_time'
      OR NEW.payload->'live'->>'requests_used' IS NULL OR NEW.payload->'live'->>'counters_observed_at' IS NULL
      OR (NEW.payload->'live'->>'requests_used')::integer < COALESCE((last_live.payload->'live'->>'requests_used')::integer,(p.receipt->'second_service'->'live'->>'requests_used')::integer)
      OR (NEW.payload->'live'->>'counters_observed_at')::timestamptz < COALESCE((last_live.payload->'live'->>'counters_observed_at')::timestamptz,(p.receipt->'second_service'->'live'->>'counters_observed_at')::timestamptz))
    OR NEW.payload->'closure' IS NOT NULL AND NEW.payload->'closure'<>'null'::jsonb AND (
      NEW.payload->'closure'->'service' IS DISTINCT FROM original_service
      OR NEW.payload->'closure'->>'kind'='normal-drain' AND (
        NEW.payload->'closure'->'counters'->>'accepted_transports' IS NULL
        OR (NEW.payload->'closure'->'counters'->>'accepted_transports')::integer < COALESCE((last_live.payload->'live'->>'requests_used')::integer,(p.receipt->'second_service'->'live'->>'requests_used')::integer)))
    OR e.organization_id<>NEW.organization_id OR e.goal_id IS DISTINCT FROM p.goal_id
    OR e.type<>'goal.application-publication.observation' OR e.actor_type<>'system' OR e.actor_id<>'goal_runner'
    OR e.payload->>'publication_id' IS DISTINCT FROM p.id OR e.payload->>'request_digest' IS DISTINCT FROM p.request_digest
    OR e.payload->>'event_id' IS DISTINCT FROM NEW.id OR e.payload->'sequence' IS DISTINCT FROM to_jsonb(NEW.sequence)
    OR e.payload->>'observation_digest' IS DISTINCT FROM NEW.payload_digest OR e.payload->>'state' IS DISTINCT FROM NEW.state
    THEN RAISE EXCEPTION 'Application publication observation lacks original session, ordered request and committed event binding'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER application_publication_observations_protected BEFORE INSERT OR UPDATE OR DELETE ON application_publication_observations
  FOR EACH ROW EXECUTE FUNCTION artoo_application_publication_observation_v1();
--> statement-breakpoint
CREATE FUNCTION artoo_application_publication_settlement_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p application_publications; o application_publication_observations; e event_log; binding jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Application publication completion settlements are immutable'; END IF;
  SELECT * INTO p FROM application_publications WHERE id=NEW.publication_id FOR UPDATE;
  SELECT * INTO o FROM application_publication_observations WHERE id=NEW.observation_id;
  SELECT * INTO e FROM event_log WHERE id=NEW.event_id;
  binding=jsonb_build_object('version',1,'publication_id',NEW.publication_id,'request_digest',NEW.request_digest,'receipt_digest',NEW.receipt_digest,
    'authorization_event_id',NEW.authorization_event_id,'observation_id',NEW.observation_id,'observation_sequence',NEW.observation_sequence,
    'lease_id',NEW.lease_id,'deadline_at',to_char(NEW.deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'scope',NEW.scope);
  IF p.id IS NULL OR o.id IS NULL OR e.id IS NULL OR p.status<>'published' OR p.goal_id<>NEW.goal_id OR p.organization_id<>NEW.organization_id
    OR p.request_digest<>NEW.request_digest OR p.receipt_digest IS DISTINCT FROM NEW.receipt_digest OR p.authorization_event_id<>NEW.authorization_event_id
    OR o.organization_id<>NEW.organization_id OR o.publication_id<>p.id OR o.publisher_session_id<>p.publisher_session_id
    OR o.sequence<>NEW.observation_sequence OR o.state<>'healthy' OR o.payload->'health' IS NULL OR o.payload->'health'='null'::jsonb
    OR o.payload->'live' IS NULL OR o.payload->'live'='null'::jsonb OR o.payload->'closure' IS DISTINCT FROM 'null'::jsonb
    OR o.payload->'lease' IS DISTINCT FROM p.receipt->'lease' OR o.payload->'deployment' IS DISTINCT FROM p.receipt->'deployment'
    OR o.payload->'lease'->>'lease_id' IS DISTINCT FROM NEW.lease_id OR (o.payload->'lease'->>'deadline_at')::timestamptz IS DISTINCT FROM NEW.deadline_at
    OR NEW.created_at>=NEW.deadline_at OR NEW.created_at<(o.payload->>'observed_at')::timestamptz
    OR NEW.created_at<(p.receipt->>'recorded_at')::timestamptz
    OR NEW.created_at-(o.payload->'health'->>'checked_at')::timestamptz > ((p.request->'capabilities'->'contract'->'limits'->>'health_freshness_ms')::integer * interval '1 millisecond')
    OR NEW.created_at-(o.payload->'live'->>'observed_at')::timestamptz > ((p.request->'capabilities'->'contract'->'limits'->>'health_freshness_ms')::integer * interval '1 millisecond')
    OR o.payload->'live'->>'counters_observed_at' IS NULL
    OR NEW.created_at-(o.payload->'live'->>'counters_observed_at')::timestamptz > ((p.request->'capabilities'->'contract'->'limits'->>'health_freshness_ms')::integer * interval '1 millisecond')
    OR EXISTS(SELECT 1 FROM application_publication_observations newer WHERE newer.publication_id=p.id AND newer.sequence>o.sequence)
    OR e.organization_id<>NEW.organization_id OR e.goal_id IS DISTINCT FROM NEW.goal_id OR e.type<>'goal.completed' OR e.actor_type<>'system' OR e.actor_id<>'goal_runner'
    OR e.payload->'application_publication' IS DISTINCT FROM binding OR e.occurred_at IS DISTINCT FROM NEW.created_at
    THEN RAISE EXCEPTION 'Application completion requires its exact immutable receipt and latest fresh original-session healthy/live observation'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER application_publication_settlements_protected BEFORE INSERT OR UPDATE OR DELETE ON application_publication_settlements
  FOR EACH ROW EXECUTE FUNCTION artoo_application_publication_settlement_v1();
--> statement-breakpoint
CREATE FUNCTION artoo_application_publication_goal_completion_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='completed' AND EXISTS(SELECT 1 FROM goal_automations a WHERE a.goal_id=NEW.id AND a.app_publication IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM application_publication_settlements s WHERE s.goal_id=NEW.id AND s.organization_id=NEW.organization_id)
    THEN RAISE EXCEPTION 'Application publication goal cannot complete from task status alone'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goals_application_publication_completion BEFORE UPDATE ON goals
  FOR EACH ROW EXECUTE FUNCTION artoo_application_publication_goal_completion_v1();
--> statement-breakpoint
CREATE FUNCTION artoo_application_publication_event_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.type IN ('goal.application-publication.authorized','goal.application-publication.receipt','goal.application-publication.observation')
    OR EXISTS(SELECT 1 FROM application_publication_settlements s WHERE s.event_id=OLD.id)
    THEN RAISE EXCEPTION 'Application publication event history is immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER event_log_application_publication_immutable BEFORE UPDATE OR DELETE ON event_log
  FOR EACH ROW EXECUTE FUNCTION artoo_application_publication_event_immutable_v1();
