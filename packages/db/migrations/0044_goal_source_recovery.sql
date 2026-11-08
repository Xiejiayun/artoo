-- H9 records new facts; it never rewrites H6/H7 requests, uncertain results or old sessions.
CREATE TABLE node_recovery_registrations (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), computer_id text NOT NULL REFERENCES computers(id), device_id text NOT NULL REFERENCES devices(id),
  token_lookup text NOT NULL, session_id text NOT NULL, epoch_id text NOT NULL, generation integer NOT NULL,
  guardian_instance_id text NOT NULL, store_identity_digest text NOT NULL, configuration_digest text NOT NULL, workspace_identity_digest text NOT NULL, workspace_root text NOT NULL,
  registration_digest text NOT NULL, registration jsonb NOT NULL, created_at timestamptz NOT NULL,
  CONSTRAINT node_recovery_epoch_uniq UNIQUE(organization_id,computer_id,epoch_id),
  CONSTRAINT node_recovery_generation_uniq UNIQUE(organization_id,computer_id,guardian_instance_id,store_identity_digest,generation),
  CONSTRAINT node_recovery_registration_generation_chk CHECK(generation>=0),
  CONSTRAINT node_recovery_registration_digest_chk CHECK(registration_digest ~ '^sha256:[a-f0-9]{64}$' AND store_identity_digest ~ '^sha256:[a-f0-9]{64}$' AND configuration_digest ~ '^sha256:[a-f0-9]{64}$' AND workspace_identity_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE node_recovery_availabilities (
  id text PRIMARY KEY, registration_id text NOT NULL REFERENCES node_recovery_registrations(id), organization_id text NOT NULL REFERENCES organizations(id),
  token_lookup text NOT NULL, session_id text NOT NULL, availability_digest text NOT NULL, availability jsonb NOT NULL, created_at timestamptz NOT NULL,
  CONSTRAINT node_recovery_availability_uniq UNIQUE(registration_id,session_id,availability_digest),
  CONSTRAINT node_recovery_availability_digest_chk CHECK(availability_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_source_recoveries (
  id text PRIMARY KEY, registration_id text NOT NULL REFERENCES node_recovery_registrations(id), availability_id text NOT NULL REFERENCES node_recovery_availabilities(id),
  origin_review_id text NOT NULL REFERENCES goal_imported_execution_reviews(id), organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id),
  plan_id text NOT NULL REFERENCES plans(id), computer_id text NOT NULL REFERENCES computers(id), actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id),
  policy_version text NOT NULL, authorization_event_id text NOT NULL REFERENCES event_log(id), current_session_id text NOT NULL,
  request_digest text NOT NULL, request jsonb NOT NULL, result jsonb, result_digest text, result_delivery_id text, result_session_id text,
  stop_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL, settled_at timestamptz, settlement_event_id text REFERENCES event_log(id),
  CONSTRAINT goal_source_recovery_registration_uniq UNIQUE(registration_id),
  CONSTRAINT goal_source_recovery_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND (result_digest IS NULL OR result_digest ~ '^sha256:[a-f0-9]{64}$')),
  CONSTRAINT goal_source_recovery_result_chk CHECK(((result IS NULL AND result_digest IS NULL AND result_delivery_id IS NULL AND result_session_id IS NULL)
    OR (result IS NOT NULL AND result_digest IS NOT NULL AND result_delivery_id IS NOT NULL AND result_session_id=current_session_id
      AND result->'version'='1'::jsonb AND result->>'recovery_id'=id AND result->>'request_digest'=request_digest
      AND result->>'outcome' IN ('recovered','unknown') AND result->'closed'=to_jsonb(result->>'outcome'='recovered'))) IS TRUE),
  CONSTRAINT goal_source_recovery_settled_chk CHECK(((settled_at IS NULL AND settlement_event_id IS NULL) OR
    (settled_at IS NOT NULL AND settlement_event_id IS NOT NULL AND result->>'outcome'='recovered')) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_source_recovery_deliveries (
  id text PRIMARY KEY, recovery_id text NOT NULL REFERENCES goal_source_recoveries(id), session_id text NOT NULL, control text NOT NULL, ack jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_source_recovery_delivery_uniq UNIQUE(recovery_id,session_id,control), CONSTRAINT goal_source_recovery_delivery_control_chk CHECK(control IN ('start','stop','status'))
);
--> statement-breakpoint
ALTER TABLE goal_source_recoveries ADD CONSTRAINT goal_source_recovery_delivery_fk FOREIGN KEY(result_delivery_id) REFERENCES goal_source_recovery_deliveries(id);
--> statement-breakpoint
CREATE TABLE goal_source_recovery_checkpoints (
  recovery_id text PRIMARY KEY REFERENCES goal_source_recoveries(id), organization_id text NOT NULL REFERENCES organizations(id), registration_id text NOT NULL REFERENCES node_recovery_registrations(id),
  old_epoch_id text NOT NULL, new_epoch_id text NOT NULL, generation integer NOT NULL,
  delivery_id text NOT NULL REFERENCES goal_source_recovery_deliveries(id), session_id text NOT NULL, request_digest text NOT NULL, result_digest text NOT NULL,
  checkpoint_digest text NOT NULL, checkpoint jsonb NOT NULL, created_at timestamptz NOT NULL,
  CONSTRAINT goal_source_recovery_old_epoch_uniq UNIQUE(registration_id,old_epoch_id), CONSTRAINT goal_source_recovery_new_epoch_uniq UNIQUE(new_epoch_id),
  CONSTRAINT goal_source_recovery_checkpoint_epoch_chk CHECK(old_epoch_id<>new_epoch_id AND generation>0),
  CONSTRAINT goal_source_recovery_checkpoint_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND result_digest ~ '^sha256:[a-f0-9]{64}$' AND checkpoint_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_source_recovery_settlements (
  id text PRIMARY KEY, recovery_id text NOT NULL REFERENCES goal_source_recovery_checkpoints(recovery_id), organization_id text NOT NULL REFERENCES organizations(id),
  goal_id text NOT NULL REFERENCES goals(id), computer_id text NOT NULL REFERENCES computers(id), kind text NOT NULL, operation_id text NOT NULL, request_digest text NOT NULL,
  run_id text REFERENCES runs(id), event_id text NOT NULL REFERENCES event_log(id), created_at timestamptz NOT NULL,
  CONSTRAINT goal_source_recovery_operation_uniq UNIQUE(organization_id,kind,operation_id),
  CONSTRAINT goal_source_recovery_operation_kind_chk CHECK((kind='validation' AND run_id IS NOT NULL) OR (kind IN ('validation_review','release') AND run_id IS NULL)),
  CONSTRAINT goal_source_recovery_operation_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_source_recovery_receipts (
  recovery_id text PRIMARY KEY REFERENCES goal_source_recoveries(id), organization_id text NOT NULL REFERENCES organizations(id),
  delivery_id text NOT NULL REFERENCES goal_source_recovery_deliveries(id), session_id text NOT NULL, request_digest text NOT NULL, result_digest text NOT NULL, sent_at timestamptz NOT NULL,
  CONSTRAINT goal_source_recovery_receipt_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND result_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
-- These strict H9 wire objects also have fixed ASCII keys and safe integers, so
-- the existing canonical JSON implementation computes their exact wire digests.
CREATE FUNCTION protect_node_recovery_registration_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d devices%ROWTYPE; t device_tokens%ROWTYPE; parent goal_source_recovery_checkpoints%ROWTYPE; b jsonb; e jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Recovery registration history is immutable'; END IF;
  b:=NEW.registration->'binding'; e:=NEW.registration->'epoch';
  SELECT * INTO d FROM devices WHERE id=NEW.device_id;
  SELECT * INTO t FROM device_tokens WHERE device_id=NEW.device_id AND token_lookup=NEW.token_lookup AND kind='node';
  IF d.id IS NULL OR t.id IS NULL OR d.organization_id<>NEW.organization_id OR d.computer_id IS DISTINCT FROM NEW.computer_id OR d.trust<>'active' OR d.revoked_at IS NOT NULL
    OR t.organization_id<>NEW.organization_id OR t.status<>'active' OR t.revoked_at IS NOT NULL OR t.expires_at<=NEW.created_at
    OR NEW.registration_digest IS DISTINCT FROM artoo_release_retry_digest_v1(NEW.registration)
    OR (NEW.registration->'version'='1'::jsonb AND NEW.registration->>'registration_id'=NEW.id AND b->'version'='1'::jsonb
      AND b->>'node_id'=NEW.computer_id AND b->>'device_id'=NEW.device_id AND b->>'guardian_instance_id'=NEW.guardian_instance_id
      AND b->>'store_identity_digest'=NEW.store_identity_digest AND b->>'configuration_digest'=NEW.configuration_digest
      AND b->>'workspace_identity_digest'=NEW.workspace_identity_digest AND b->>'workspace_root'=NEW.workspace_root
      AND e->'version'='1'::jsonb AND e->>'epoch_id'=NEW.epoch_id AND e->>'session_id'=NEW.session_id AND (e->>'generation')::integer=NEW.generation
      AND (e->>'roster_revision')::integer>=0 AND e->>'roster_digest' ~ '^sha256:[a-f0-9]{64}$') IS NOT TRUE
    THEN RAISE EXCEPTION 'Recovery registration lacks its original paired epoch identity'; END IF;
  IF NEW.generation>0 THEN
    SELECT * INTO parent FROM goal_source_recovery_checkpoints WHERE new_epoch_id=NEW.epoch_id;
    IF parent.recovery_id IS NULL OR parent.organization_id<>NEW.organization_id OR parent.generation<>NEW.generation OR parent.session_id<>NEW.session_id
      OR parent.checkpoint->'binding' IS DISTINCT FROM b
      THEN RAISE EXCEPTION 'Fresh epoch registration lacks its exact previous checkpoint'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER node_recovery_registrations_protected BEFORE INSERT OR UPDATE OR DELETE ON node_recovery_registrations FOR EACH ROW EXECUTE FUNCTION protect_node_recovery_registration_v1();
--> statement-breakpoint
CREATE FUNCTION protect_node_recovery_availability_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r node_recovery_registrations%ROWTYPE; d devices%ROWTYPE; t device_tokens%ROWTYPE; e jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Recovery availability history is immutable'; END IF;
  SELECT * INTO r FROM node_recovery_registrations WHERE id=NEW.registration_id;
  SELECT * INTO d FROM devices WHERE id=r.device_id;
  SELECT * INTO t FROM device_tokens WHERE device_id=r.device_id AND token_lookup=NEW.token_lookup AND kind='node';
  e:=NEW.availability->'previous_epoch';
  IF r.id IS NULL OR d.id IS NULL OR t.id IS NULL OR r.organization_id<>NEW.organization_id OR NEW.session_id=r.session_id
    OR d.organization_id<>NEW.organization_id OR d.computer_id IS DISTINCT FROM r.computer_id OR d.trust<>'active' OR d.revoked_at IS NOT NULL
    OR t.organization_id<>NEW.organization_id OR t.status<>'active' OR t.revoked_at IS NOT NULL OR t.expires_at<=NEW.created_at
    OR NEW.availability_digest IS DISTINCT FROM artoo_release_retry_digest_v1(NEW.availability)
    OR NEW.availability->'binding' IS DISTINCT FROM r.registration->'binding'
    OR (NEW.availability->'version'='1'::jsonb AND NEW.availability->>'registration_id'=r.id AND NEW.availability->>'current_session_id'=NEW.session_id
      AND NEW.availability->>'state' IN ('recoverable','unknown') AND e->>'epoch_id'=r.epoch_id AND e->>'session_id'=r.session_id
      AND (e->>'generation')::integer=r.generation AND (e->>'roster_revision')::integer>=(r.registration->'epoch'->>'roster_revision')::integer) IS NOT TRUE
    OR (e->>'roster_revision')::integer=(r.registration->'epoch'->>'roster_revision')::integer AND e->>'roster_digest' IS DISTINCT FROM r.registration->'epoch'->>'roster_digest'
    OR EXISTS(SELECT 1 FROM node_recovery_availabilities a WHERE a.registration_id=r.id AND
      ((a.availability->'previous_epoch'->>'roster_revision')::integer>(e->>'roster_revision')::integer
       OR ((a.availability->'previous_epoch'->>'roster_revision')::integer=(e->>'roster_revision')::integer AND
         (a.availability->'previous_epoch'->>'roster_digest' IS DISTINCT FROM e->>'roster_digest'
          OR a.availability->>'state'='recoverable' AND NEW.availability->>'state'='recoverable' AND a.availability->'operations' IS DISTINCT FROM NEW.availability->'operations'))
       OR a.session_id=NEW.session_id AND a.availability->>'state'='recoverable' AND NEW.availability->>'state'='recoverable'
         AND a.availability->>'new_daemon_identity_digest' IS DISTINCT FROM NEW.availability->>'new_daemon_identity_digest'))
    THEN RAISE EXCEPTION 'Recovery availability changed its registered epoch or current paired device'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER node_recovery_availabilities_protected BEFORE INSERT OR UPDATE OR DELETE ON node_recovery_availabilities FOR EACH ROW EXECUTE FUNCTION protect_node_recovery_availability_v1();
--> statement-breakpoint
CREATE FUNCTION protect_goal_source_recovery_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r node_recovery_registrations%ROWTYPE; a node_recovery_availabilities%ROWTYPE; h goal_imported_execution_reviews%ROWTYPE; e event_log%ROWTYPE; d goal_source_recovery_deliveries%ROWTYPE; expected_operations jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Recovery requests are immutable'; END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(OLD)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','settled_at','settlement_event_id']) IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','settled_at','settlement_event_id'])
    OR OLD.stop_requested AND NOT NEW.stop_requested OR OLD.result IS NOT NULL AND (OLD.result IS DISTINCT FROM NEW.result OR OLD.result_digest IS DISTINCT FROM NEW.result_digest
      OR OLD.result_delivery_id IS DISTINCT FROM NEW.result_delivery_id OR OLD.result_session_id IS DISTINCT FROM NEW.result_session_id)
    OR OLD.settled_at IS NOT NULL AND (OLD.settled_at IS DISTINCT FROM NEW.settled_at OR OLD.settlement_event_id IS DISTINCT FROM NEW.settlement_event_id))
    THEN RAISE EXCEPTION 'Recovery history cannot be replaced'; END IF;
  SELECT * INTO r FROM node_recovery_registrations WHERE id=NEW.registration_id;
  SELECT * INTO a FROM node_recovery_availabilities WHERE id=NEW.availability_id;
  SELECT * INTO h FROM goal_imported_execution_reviews WHERE id=NEW.origin_review_id;
  SELECT * INTO e FROM event_log WHERE id=NEW.authorization_event_id;
  SELECT COALESCE(jsonb_agg(ref ORDER BY (ref->>'kind') COLLATE "C", (ref->>'operation_id') COLLATE "C"),'[]'::jsonb) INTO expected_operations FROM (
    SELECT jsonb_build_object('kind','validation','operation_id',v.id,'request_digest',v.request_digest,'run_id',v.run_id) AS ref
    FROM goal_imported_validations v WHERE v.organization_id=NEW.organization_id AND v.origin_review_id=h.id
      AND EXISTS(SELECT 1 FROM goal_imported_validation_deliveries x WHERE x.validation_id=v.id AND x.session_id=r.session_id AND x.control='start')
    UNION ALL
    SELECT jsonb_build_object('kind','validation_review','operation_id',v.id,'request_digest',v.request_digest)
    FROM goal_imported_validation_reviews v JOIN goal_imported_validations author ON author.id=v.validation_id
    WHERE v.organization_id=NEW.organization_id AND author.origin_review_id=h.id
      AND EXISTS(SELECT 1 FROM goal_imported_validation_deliveries x WHERE x.validation_id=author.id AND x.session_id=r.session_id AND x.control='start')
      AND EXISTS(SELECT 1 FROM goal_imported_validation_review_deliveries x WHERE x.review_id=v.id AND x.session_id=r.session_id AND x.control='start')
    UNION ALL
    SELECT jsonb_build_object('kind','release','operation_id',v.id,'request_digest',artoo_release_retry_digest_v1(v.request))
    FROM product_releases v JOIN goal_imported_validation_publications p ON p.release_id=v.id
    WHERE v.organization_id=NEW.organization_id AND p.origin_review_id=h.id
  ) operation_refs;
  IF r.id IS NULL OR a.id IS NULL OR h.id IS NULL OR e.id IS NULL OR r.organization_id<>NEW.organization_id OR a.organization_id<>NEW.organization_id OR h.organization_id<>NEW.organization_id
    OR a.registration_id<>r.id OR r.computer_id<>NEW.computer_id OR h.computer_id<>NEW.computer_id OR h.goal_id<>NEW.goal_id OR h.plan_id<>NEW.plan_id
    OR h.actor_user_id<>NEW.actor_user_id OR h.consent_id IS DISTINCT FROM NEW.consent_id OR h.policy_version<>NEW.policy_version OR h.acceptance_event_id IS NULL
    OR a.session_id<>NEW.current_session_id OR a.availability->>'state' IS DISTINCT FROM 'recoverable'
    OR NEW.request_digest IS DISTINCT FROM artoo_release_retry_digest_v1(NEW.request)
    OR NEW.request->'binding' IS DISTINCT FROM r.registration->'binding' OR NEW.request->'previous_epoch' IS DISTINCT FROM a.availability->'previous_epoch'
    OR NEW.request->'operations' IS DISTINCT FROM a.availability->'operations'
    OR NEW.request->'operations' IS DISTINCT FROM expected_operations
    OR NEW.request->>'new_daemon_identity_digest' IS DISTINCT FROM a.availability->>'new_daemon_identity_digest'
    OR NEW.request->'origin' IS DISTINCT FROM jsonb_build_object('version',1,'review_id',h.id,'request_digest',h.request_digest,
      'result_digest',h.result_digest,'acceptance_event_id',h.acceptance_event_id,'execution_request',h.request->'execution_request','implementation_source',h.request->'source')
    OR (NEW.request->'version'='1'::jsonb AND NEW.request->>'recovery_id'=NEW.id AND NEW.request->>'registration_id'=r.id
      AND NEW.request->>'origin_review_id'=h.id AND NEW.request->>'goal_id'=NEW.goal_id AND NEW.request->>'plan_id'=NEW.plan_id
      AND NEW.request->>'current_session_id'=NEW.current_session_id AND NEW.request->'authorization'->>'event_id'=e.id
      AND NEW.request->'authorization'->>'actor_user_id'=NEW.actor_user_id AND NEW.request->'authorization'->>'consent_id'=NEW.consent_id
      AND NEW.request->'authorization'->>'policy_version'=NEW.policy_version) IS NOT TRUE
    OR e.organization_id<>NEW.organization_id OR e.actor_type<>'system' OR e.actor_id<>'goal_runner' OR e.type<>'goal.source-recovery.authorized'
    OR e.goal_id IS DISTINCT FROM NEW.goal_id OR e.payload->>'recovery_id' IS DISTINCT FROM NEW.id OR e.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id
    OR e.payload->>'registration_id' IS DISTINCT FROM r.id OR e.payload->>'availability_digest' IS DISTINCT FROM a.availability_digest
    THEN RAISE EXCEPTION 'Recovery request lost its exact history, availability or initiating authorization'; END IF;
  IF NEW.result IS NOT NULL THEN
    SELECT * INTO d FROM goal_source_recovery_deliveries WHERE id=NEW.result_delivery_id;
    IF d.id IS NULL OR d.recovery_id<>NEW.id OR d.session_id<>NEW.result_session_id OR NEW.result_digest IS DISTINCT FROM artoo_release_retry_digest_v1(NEW.result)
      OR NOT EXISTS(SELECT 1 FROM goal_source_recovery_deliveries WHERE recovery_id=NEW.id AND session_id=NEW.current_session_id AND control='start')
      THEN RAISE EXCEPTION 'Recovery result lacks its exact issuing delivery'; END IF;
  END IF;
  IF NEW.settled_at IS NOT NULL THEN
    SELECT * INTO e FROM event_log WHERE id=NEW.settlement_event_id;
    IF e.id IS NULL OR e.organization_id<>NEW.organization_id OR e.goal_id IS DISTINCT FROM NEW.goal_id OR e.actor_type<>'system' OR e.actor_id<>'goal_runner'
      OR e.type<>'goal.source-recovery.settled' OR e.payload->>'recovery_id' IS DISTINCT FROM NEW.id OR e.payload->>'result_digest' IS DISTINCT FROM NEW.result_digest
      OR NOT EXISTS(SELECT 1 FROM goal_source_recovery_checkpoints WHERE recovery_id=NEW.id AND result_digest=NEW.result_digest)
      OR NOT EXISTS(SELECT 1 FROM goal_source_recovery_receipts WHERE recovery_id=NEW.id AND result_digest=NEW.result_digest)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.request->'operations') item WHERE NOT EXISTS(
        SELECT 1 FROM goal_source_recovery_settlements s WHERE s.recovery_id=NEW.id AND s.organization_id=NEW.organization_id
          AND s.kind=item->>'kind' AND s.operation_id=item->>'operation_id' AND s.request_digest=item->>'request_digest'
          AND s.run_id IS NOT DISTINCT FROM item->>'run_id' AND s.event_id=NEW.settlement_event_id))
      THEN RAISE EXCEPTION 'Recovery settlement requires checkpoint, delivery receipt and GoalRunner decision'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_source_recoveries_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_source_recoveries FOR EACH ROW EXECUTE FUNCTION protect_goal_source_recovery_v1();
--> statement-breakpoint
CREATE FUNCTION protect_goal_source_recovery_delivery_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r goal_source_recoveries%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' OR TG_OP='UPDATE' AND ((to_jsonb(OLD)-'ack') IS DISTINCT FROM (to_jsonb(NEW)-'ack') OR OLD.ack IS NOT NULL AND OLD.ack IS DISTINCT FROM NEW.ack)
    THEN RAISE EXCEPTION 'Recovery delivery history is immutable'; END IF;
  SELECT * INTO r FROM goal_source_recoveries WHERE id=NEW.recovery_id;
  IF r.id IS NULL OR NEW.session_id<>r.current_session_id
    OR NEW.ack IS NOT NULL AND (NEW.ack->>'kind'='product.source.recovery.ack.v1' AND NEW.ack->>'node_id'=r.computer_id AND NEW.ack->>'command_id'=NEW.id
      AND NEW.ack->'payload'->'version'='1'::jsonb AND NEW.ack->'payload'->>'recovery_id'=r.id AND NEW.ack->'payload'->>'request_digest'=r.request_digest
      AND NEW.ack->>'status' IN ('accepted','rejected')) IS NOT TRUE
    THEN RAISE EXCEPTION 'Recovery delivery changed its current session or acknowledgment'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_source_recovery_deliveries_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_source_recovery_deliveries FOR EACH ROW EXECUTE FUNCTION protect_goal_source_recovery_delivery_v1();
--> statement-breakpoint
CREATE FUNCTION protect_goal_source_recovery_checkpoint_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r goal_source_recoveries%ROWTYPE; registration node_recovery_registrations%ROWTYPE; c jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Recovery checkpoint history is immutable'; END IF;
  SELECT * INTO r FROM goal_source_recoveries WHERE id=NEW.recovery_id;
  SELECT * INTO registration FROM node_recovery_registrations WHERE id=NEW.registration_id;
  c:=NEW.checkpoint;
  IF r.id IS NULL OR registration.id IS NULL OR r.organization_id<>NEW.organization_id OR r.registration_id<>registration.id
    OR r.result->>'outcome' IS DISTINCT FROM 'recovered' OR r.result->'closed' IS DISTINCT FROM 'true'::jsonb OR r.result->'checkpoint' IS DISTINCT FROM c
    OR r.request_digest<>NEW.request_digest OR r.result_digest IS DISTINCT FROM NEW.result_digest OR r.result_delivery_id IS DISTINCT FROM NEW.delivery_id OR r.result_session_id IS DISTINCT FROM NEW.session_id
    OR NEW.checkpoint_digest IS DISTINCT FROM artoo_release_retry_digest_v1(c) OR c->'binding' IS DISTINCT FROM r.request->'binding' OR c->'operations' IS DISTINCT FROM r.request->'operations'
    OR (c->'version'='1'::jsonb AND c->>'recovery_id'=r.id AND c->>'request_digest'=r.request_digest
      AND c->>'old_epoch_id'=registration.epoch_id AND c->>'old_epoch_id'=NEW.old_epoch_id AND c->>'new_epoch_id'=NEW.new_epoch_id
      AND (c->>'generation')::integer=NEW.generation AND NEW.generation=registration.generation+1 AND c->>'current_session_id'=NEW.session_id
      AND c->>'new_daemon_identity_digest'=r.request->>'new_daemon_identity_digest' AND c->>'challenge_id'=r.request->>'challenge_id'
      AND c->'roster_revision'=r.request->'previous_epoch'->'roster_revision' AND c->>'roster_digest'=r.request->'previous_epoch'->>'roster_digest'
      AND c->>'closure_set_digest' ~ '^sha256:[a-f0-9]{64}$' AND c->>'source_state'='unverified' AND c->>'subject_digest'=c->'baseline'->>'subject_digest'
      AND c->'baseline'->>'manifest_digest'=artoo_release_retry_digest_v1(jsonb_build_object('directories',c->'baseline'->'directories','files',c->'baseline'->'files'))) IS NOT TRUE
    THEN RAISE EXCEPTION 'Recovery checkpoint lost exact epoch, closure, request or unverified baseline'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_source_recovery_checkpoints_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_source_recovery_checkpoints FOR EACH ROW EXECUTE FUNCTION protect_goal_source_recovery_checkpoint_v1();
--> statement-breakpoint
CREATE FUNCTION protect_goal_source_recovery_receipt_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r goal_source_recoveries%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Recovery receipt history is immutable'; END IF;
  SELECT * INTO r FROM goal_source_recoveries WHERE id=NEW.recovery_id;
  IF r.id IS NULL OR r.organization_id<>NEW.organization_id OR r.request_digest<>NEW.request_digest OR r.result_digest IS DISTINCT FROM NEW.result_digest
    OR r.result_delivery_id IS DISTINCT FROM NEW.delivery_id OR r.result_session_id IS DISTINCT FROM NEW.session_id
    THEN RAISE EXCEPTION 'Recovery receipt lacks its original committed result and delivery'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_source_recovery_receipts_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_source_recovery_receipts FOR EACH ROW EXECUTE FUNCTION protect_goal_source_recovery_receipt_v1();
--> statement-breakpoint
CREATE FUNCTION protect_goal_source_recovery_settlement_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r goal_source_recoveries%ROWTYPE; c goal_source_recovery_checkpoints%ROWTYPE; e event_log%ROWTYPE; operation jsonb; reference jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Recovery operation settlement is immutable'; END IF;
  SELECT * INTO r FROM goal_source_recoveries WHERE id=NEW.recovery_id;
  SELECT * INTO c FROM goal_source_recovery_checkpoints WHERE recovery_id=NEW.recovery_id;
  SELECT * INTO e FROM event_log WHERE id=NEW.event_id;
  SELECT item INTO reference FROM jsonb_array_elements(c.checkpoint->'operations') item WHERE item->>'kind'=NEW.kind AND item->>'operation_id'=NEW.operation_id;
  IF NEW.kind='validation' THEN SELECT to_jsonb(v) INTO operation FROM goal_imported_validations v WHERE id=NEW.operation_id;
  ELSIF NEW.kind='validation_review' THEN SELECT to_jsonb(v) INTO operation FROM goal_imported_validation_reviews v WHERE id=NEW.operation_id;
  ELSE SELECT to_jsonb(v) INTO operation FROM product_releases v WHERE id=NEW.operation_id; END IF;
  IF r.id IS NULL OR c.recovery_id IS NULL OR e.id IS NULL OR operation IS NULL OR reference IS NULL OR r.organization_id<>NEW.organization_id OR r.goal_id<>NEW.goal_id OR r.computer_id<>NEW.computer_id
    OR operation->>'organization_id' IS DISTINCT FROM NEW.organization_id OR operation->>'goal_id' IS DISTINCT FROM NEW.goal_id OR operation->>'computer_id' IS DISTINCT FROM NEW.computer_id
    OR reference->>'request_digest' IS DISTINCT FROM NEW.request_digest OR reference->>'run_id' IS DISTINCT FROM NEW.run_id
    OR (CASE WHEN NEW.kind='release' THEN artoo_release_retry_digest_v1(operation->'request') ELSE operation->>'request_digest' END) IS DISTINCT FROM NEW.request_digest
    OR NEW.kind='validation' AND operation->>'run_id' IS DISTINCT FROM NEW.run_id
    OR e.organization_id<>NEW.organization_id OR e.goal_id IS DISTINCT FROM NEW.goal_id OR e.actor_type<>'system' OR e.actor_id<>'goal_runner'
    OR e.type<>'goal.source-recovery.settled' OR e.payload->>'recovery_id' IS DISTINCT FROM r.id OR e.payload->>'result_digest' IS DISTINCT FROM r.result_digest
    OR NOT EXISTS(SELECT 1 FROM goal_source_recovery_receipts WHERE recovery_id=r.id AND result_digest=r.result_digest)
    THEN RAISE EXCEPTION 'Recovery settlement cannot invent a run or replace an unrelated operation'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_source_recovery_settlements_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_source_recovery_settlements FOR EACH ROW EXECUTE FUNCTION protect_goal_source_recovery_settlement_v1();

-- Independent H9 validation/review tables retain H7 closure and evidence invariants.
-- H9 owns a new validation lineage. Earlier H6 records and functions remain unchanged.
CREATE TABLE goal_recovery_validations (
  recovery_id text NOT NULL REFERENCES goal_source_recovery_checkpoints(recovery_id),
  id text PRIMARY KEY, root_validation_id text NOT NULL REFERENCES goal_recovery_validations(id),
  origin_review_id text NOT NULL REFERENCES goal_imported_execution_reviews(id), parent_validation_id text REFERENCES goal_recovery_validations(id),
  kind text NOT NULL, generation integer NOT NULL, predecessor_kind text NOT NULL, predecessor_id text NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id), task_id text NOT NULL REFERENCES tasks(id),
  run_id text NOT NULL REFERENCES runs(id), context_pack_id text NOT NULL REFERENCES context_packs(id),
  writer_instance_id text NOT NULL REFERENCES agent_instances(id), writer_agent_id text NOT NULL REFERENCES agents(id),
  computer_id text NOT NULL REFERENCES computers(id), workspace_root text NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL,
  authorization_event_id text NOT NULL REFERENCES event_log(id), attempt_index integer NOT NULL,
  session_bindings jsonb NOT NULL, initial_source_digest text NOT NULL, request_digest text NOT NULL, request jsonb NOT NULL,
  result jsonb, result_digest text, result_delivery_id text, result_session_id text,
  stop_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL,
  ready_at timestamptz, ready_event_id text REFERENCES event_log(id), ready_kind text,
  CONSTRAINT goal_recovery_validations_generation_uniq UNIQUE(root_validation_id,generation),
  CONSTRAINT goal_recovery_validations_predecessor_uniq UNIQUE(organization_id,predecessor_kind,predecessor_id),
  CONSTRAINT goal_recovery_validations_parent_uniq UNIQUE(parent_validation_id),
  CONSTRAINT goal_recovery_validations_run_uniq UNIQUE(run_id),
  CONSTRAINT goal_recovery_validations_task_generation_uniq UNIQUE(task_id,generation),
  CONSTRAINT goal_recovery_validations_lineage_chk CHECK((kind='initial' AND generation=0 AND root_validation_id=id AND parent_validation_id IS NULL AND predecessor_kind='initial' AND predecessor_id=recovery_id)
    OR (kind='repair' AND generation>0 AND root_validation_id<>id AND parent_validation_id IS NOT NULL AND predecessor_kind IN ('review','failure'))),
  CONSTRAINT goal_recovery_validations_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND initial_source_digest ~ '^sha256:[a-f0-9]{64}$' AND (result_digest IS NULL OR result_digest ~ '^sha256:[a-f0-9]{64}$')),
  CONSTRAINT goal_recovery_validations_request_chk CHECK((request->'version'='1'::jsonb AND request->>'validation_id'=id AND request->>'root_validation_id'=root_validation_id
    AND (request->>'generation')::integer=generation AND request->>'kind'=kind AND request->'origin'->>'review_id'=origin_review_id
    AND request->'run_start'->>'run_id'=run_id AND request->'run_start'->>'task_id'=task_id AND request->'run_start'->'context_pack'->>'id'=context_pack_id
    AND request->'run_start'->>'agent_instance_id'=writer_instance_id AND request->'run_start'->'workspace'->>'root'=workspace_root
    AND request->'authorization'->>'event_id'=authorization_event_id AND request->'authorization'->>'goal_id'=goal_id
    AND (request->'authorization'->>'attempt_index')::integer=attempt_index AND attempt_index>=0) IS TRUE),
  CONSTRAINT goal_recovery_validations_result_chk CHECK((result IS NULL AND result_digest IS NULL AND result_delivery_id IS NULL AND result_session_id IS NULL)
    OR (result IS NOT NULL AND result_digest IS NOT NULL AND result_delivery_id IS NOT NULL AND result_session_id IS NOT NULL
      AND result->'version'='1'::jsonb AND result->>'validation_id'=id AND result->>'request_digest'=request_digest AND result->>'run_id'=run_id
      AND result->>'outcome' IN ('finished','failed','uncertain','cancelled_before_start') AND result->'closed'=to_jsonb(result->>'outcome'<>'uncertain')) IS TRUE),
  CONSTRAINT goal_recovery_validations_ready_chk CHECK((ready_at IS NULL AND ready_event_id IS NULL AND ready_kind IS NULL)
    OR (ready_at IS NOT NULL AND ready_event_id IS NOT NULL AND (ready_kind='review' AND result->>'outcome'='finished' AND result->'verified_validation'->'verification'->>'outcome'='passed'
      OR ready_kind='repair' AND result->>'outcome'='failed' AND result->'closed_failure' IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_recovery_validation_deliveries (
  id text PRIMARY KEY, validation_id text NOT NULL REFERENCES goal_recovery_validations(id), session_id text NOT NULL, control text NOT NULL, ack jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_recovery_validation_delivery_session_uniq UNIQUE(validation_id,session_id,control),
  CONSTRAINT goal_recovery_validation_delivery_control_chk CHECK(control IN ('start','stop','status'))
);
--> statement-breakpoint
ALTER TABLE goal_recovery_validations ADD CONSTRAINT goal_recovery_validations_delivery_fk FOREIGN KEY(result_delivery_id) REFERENCES goal_recovery_validation_deliveries(id);
--> statement-breakpoint
CREATE TABLE goal_recovery_validation_completions (
  validation_id text PRIMARY KEY REFERENCES goal_recovery_validations(id), organization_id text NOT NULL REFERENCES organizations(id),
  run_id text NOT NULL REFERENCES runs(id), context_pack_id text NOT NULL REFERENCES context_packs(id), evidence_id text REFERENCES run_evidence(id),
  delivery_id text NOT NULL REFERENCES goal_recovery_validation_deliveries(id), session_id text NOT NULL, outcome text NOT NULL,
  result_digest text NOT NULL, completion_digest text NOT NULL, completion jsonb NOT NULL, source_digest text NOT NULL, source jsonb NOT NULL, created_at timestamptz NOT NULL,
  CONSTRAINT goal_recovery_validation_completion_outcome_chk CHECK(outcome IN ('verified','closed-failure') AND (outcome<>'verified' OR evidence_id IS NOT NULL)),
  CONSTRAINT goal_recovery_validation_completion_digest_chk CHECK(result_digest ~ '^sha256:[a-f0-9]{64}$' AND completion_digest ~ '^sha256:[a-f0-9]{64}$' AND source_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_recovery_validation_receipts (
  validation_id text PRIMARY KEY REFERENCES goal_recovery_validations(id), organization_id text NOT NULL REFERENCES organizations(id),
  delivery_id text NOT NULL REFERENCES goal_recovery_validation_deliveries(id), session_id text NOT NULL, session_bindings jsonb NOT NULL,
  request_digest text NOT NULL, result_digest text NOT NULL, sent_at timestamptz NOT NULL,
  CONSTRAINT goal_recovery_validation_receipt_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND result_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_recovery_validation_reviews (
  recovery_id text NOT NULL REFERENCES goal_source_recovery_checkpoints(recovery_id),
  id text PRIMARY KEY, validation_id text NOT NULL REFERENCES goal_recovery_validation_completions(validation_id), retry_of text REFERENCES goal_recovery_validation_reviews(id), sequence integer NOT NULL,
  source_digest text NOT NULL, organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id), task_id text NOT NULL REFERENCES tasks(id),
  author_instance_id text NOT NULL REFERENCES agent_instances(id), author_agent_id text NOT NULL REFERENCES agents(id), reviewer_instance_id text NOT NULL REFERENCES agent_instances(id), reviewer_agent_id text NOT NULL REFERENCES agents(id),
  computer_id text NOT NULL REFERENCES computers(id), workspace_root text NOT NULL, actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL,
  authorization_event_id text NOT NULL REFERENCES event_log(id), attempt_index integer NOT NULL, session_bindings jsonb NOT NULL, request_digest text NOT NULL, request jsonb NOT NULL,
  result jsonb, result_digest text, result_delivery_id text, result_session_id text, stop_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL,
  accepted_at timestamptz, acceptance_event_id text REFERENCES event_log(id),
  CONSTRAINT goal_recovery_validation_review_sequence_uniq UNIQUE(validation_id,sequence),
  CONSTRAINT goal_recovery_validation_review_retry_uniq UNIQUE(retry_of),
  CONSTRAINT goal_recovery_validation_review_independent_chk CHECK(author_instance_id<>reviewer_instance_id AND author_agent_id<>reviewer_agent_id),
  CONSTRAINT goal_recovery_validation_review_sequence_chk CHECK(attempt_index>=0 AND ((sequence=0 AND retry_of IS NULL) OR (sequence>0 AND retry_of IS NOT NULL))),
  CONSTRAINT goal_recovery_validation_review_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND source_digest ~ '^sha256:[a-f0-9]{64}$' AND (result_digest IS NULL OR result_digest ~ '^sha256:[a-f0-9]{64}$')),
  CONSTRAINT goal_recovery_validation_review_result_chk CHECK((result IS NULL AND result_digest IS NULL AND result_delivery_id IS NULL AND result_session_id IS NULL)
    OR (result IS NOT NULL AND result_digest IS NOT NULL AND result_delivery_id IS NOT NULL AND result_session_id IS NOT NULL AND result->'version'='1'::jsonb
      AND result->>'review_id'=id AND result->>'request_digest'=request_digest AND result->'execution_authorized'='false'::jsonb
      AND result->>'outcome' IN ('reviewed','failed','uncertain','cancelled_before_start') AND result->'closed'=to_jsonb(result->>'outcome'<>'uncertain')) IS TRUE),
  CONSTRAINT goal_recovery_validation_review_accepted_chk CHECK((accepted_at IS NULL AND acceptance_event_id IS NULL) OR (accepted_at IS NOT NULL AND acceptance_event_id IS NOT NULL
    AND result->>'outcome'='reviewed' AND result->'verdict'->>'outcome'='accepted') IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_recovery_validation_review_deliveries (
  id text PRIMARY KEY, review_id text NOT NULL REFERENCES goal_recovery_validation_reviews(id), session_id text NOT NULL, control text NOT NULL, ack jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_recovery_validation_review_delivery_session_uniq UNIQUE(review_id,session_id,control),
  CONSTRAINT goal_recovery_validation_review_delivery_control_chk CHECK(control IN ('start','stop','status'))
);
--> statement-breakpoint
ALTER TABLE goal_recovery_validation_reviews ADD CONSTRAINT goal_recovery_validation_reviews_delivery_fk FOREIGN KEY(result_delivery_id) REFERENCES goal_recovery_validation_review_deliveries(id);
--> statement-breakpoint
CREATE TABLE goal_recovery_validation_review_receipts (
  review_id text PRIMARY KEY REFERENCES goal_recovery_validation_reviews(id), organization_id text NOT NULL REFERENCES organizations(id),
  delivery_id text NOT NULL REFERENCES goal_recovery_validation_review_deliveries(id), session_id text NOT NULL, session_bindings jsonb NOT NULL,
  request_digest text NOT NULL, result_digest text NOT NULL, sent_at timestamptz NOT NULL,
  CONSTRAINT goal_recovery_validation_review_receipt_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND result_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_recovery_validation_publications (
  recovery_id text NOT NULL REFERENCES goal_source_recovery_checkpoints(recovery_id),
  release_id text PRIMARY KEY REFERENCES product_releases(id), organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id),
  validation_id text NOT NULL REFERENCES goal_recovery_validation_completions(validation_id), review_id text NOT NULL REFERENCES goal_recovery_validation_reviews(id),
  origin_review_id text NOT NULL REFERENCES goal_imported_execution_reviews(id), acceptance_event_id text NOT NULL REFERENCES event_log(id),
  run_id text NOT NULL REFERENCES runs(id), evidence_id text NOT NULL REFERENCES run_evidence(id), computer_id text NOT NULL REFERENCES computers(id),
  source_digest text NOT NULL, origin jsonb NOT NULL, capabilities jsonb NOT NULL, created_at timestamptz NOT NULL,

  CONSTRAINT goal_recovery_validation_publication_digest_chk CHECK(source_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
-- A delivery identity is permanent; only its first exact acknowledgment can be added.
CREATE FUNCTION protect_recovery_validation_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x jsonb; operation_id text; payload_key text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'H9 delivery history is immutable'; END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'ack') IS DISTINCT FROM (to_jsonb(OLD)-'ack') OR OLD.ack IS NOT NULL AND NEW.ack IS DISTINCT FROM OLD.ack)
    THEN RAISE EXCEPTION 'H9 delivery identity or acknowledgment is immutable'; END IF;
  IF TG_TABLE_NAME='goal_recovery_validation_deliveries' THEN
    operation_id:=NEW.validation_id; payload_key:='validation_id'; SELECT to_jsonb(v) INTO x FROM goal_recovery_validations v WHERE id=operation_id;
  ELSE
    operation_id:=NEW.review_id; payload_key:='review_id'; SELECT to_jsonb(v) INTO x FROM goal_recovery_validation_reviews v WHERE id=operation_id;
  END IF;
  IF x IS NULL OR TG_OP='INSERT' AND NEW.control='start' AND (NEW.session_id IS DISTINCT FROM x->'session_bindings'->'destination'->>'sessionId' OR x->'stop_requested'='true'::jsonb OR x->'result'<>'null'::jsonb)
    THEN RAISE EXCEPTION 'H9 start delivery lacks its original live operation'; END IF;
  IF NEW.ack IS NOT NULL AND (NEW.ack->>'command_id'=NEW.id AND NEW.ack->>'node_id'=x->>'computer_id'
    AND NEW.ack->'payload'->>payload_key=operation_id AND NEW.ack->'payload'->>'request_digest'=x->>'request_digest'
    AND NEW.ack->>'status' IN ('accepted','rejected')) IS NOT TRUE THEN RAISE EXCEPTION 'H9 acknowledgment differs from issuing delivery'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_recovery_validation_deliveries_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_recovery_validation_deliveries FOR EACH ROW EXECUTE FUNCTION protect_recovery_validation_delivery();
--> statement-breakpoint
CREATE TRIGGER goal_recovery_validation_review_deliveries_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_recovery_validation_review_deliveries FOR EACH ROW EXECUTE FUNCTION protect_recovery_validation_delivery();
--> statement-breakpoint
CREATE FUNCTION protect_recovery_validation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x jsonb; d jsonb; operation_id text; payload_key text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'H9 receipt history is immutable'; END IF;
  IF TG_TABLE_NAME='goal_recovery_validation_receipts' THEN
    operation_id:=NEW.validation_id; payload_key:='validation_id'; SELECT to_jsonb(v) INTO x FROM goal_recovery_validations v WHERE id=operation_id;
    SELECT to_jsonb(v) INTO d FROM goal_recovery_validation_deliveries v WHERE id=NEW.delivery_id;
    IF NOT EXISTS(SELECT 1 FROM goal_recovery_validation_completions WHERE validation_id=operation_id AND organization_id=NEW.organization_id AND result_digest=NEW.result_digest)
      THEN RAISE EXCEPTION 'H9 author receipt requires original completion provenance'; END IF;
  ELSE
    operation_id:=NEW.review_id; payload_key:='review_id'; SELECT to_jsonb(v) INTO x FROM goal_recovery_validation_reviews v WHERE id=operation_id;
    SELECT to_jsonb(v) INTO d FROM goal_recovery_validation_review_deliveries v WHERE id=NEW.delivery_id;
    IF (x->'result'->'closed'='true'::jsonb AND x->'result'->>'outcome' IN ('reviewed','failed')) IS NOT TRUE
      THEN RAISE EXCEPTION 'H9 review receipt requires a closed review result'; END IF;
  END IF;
  IF x IS NULL OR d IS NULL OR x->>'organization_id' IS DISTINCT FROM NEW.organization_id OR d->>payload_key IS DISTINCT FROM operation_id
    OR d->>'session_id' IS DISTINCT FROM NEW.session_id OR x->>'result_delivery_id' IS DISTINCT FROM NEW.delivery_id OR x->>'result_session_id' IS DISTINCT FROM NEW.session_id
    OR x->>'request_digest' IS DISTINCT FROM NEW.request_digest OR x->>'result_digest' IS DISTINCT FROM NEW.result_digest
    OR x->'session_bindings' IS DISTINCT FROM NEW.session_bindings OR x->'session_bindings'->'destination'->>'sessionId' IS DISTINCT FROM NEW.session_id
    THEN RAISE EXCEPTION 'H9 receipt differs from original result, delivery or session'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_recovery_validation_receipts_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_recovery_validation_receipts FOR EACH ROW EXECUTE FUNCTION protect_recovery_validation_receipt();
--> statement-breakpoint
CREATE TRIGGER goal_recovery_validation_review_receipts_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_recovery_validation_review_receipts FOR EACH ROW EXECUTE FUNCTION protect_recovery_validation_receipt();
--> statement-breakpoint
CREATE FUNCTION protect_recovery_validation_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x goal_recovery_validations; r runs; p context_packs; d goal_recovery_validation_deliveries; e run_evidence; v event_log; c jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'H9 completion provenance is immutable'; END IF;
  SELECT * INTO x FROM goal_recovery_validations WHERE id=NEW.validation_id; SELECT * INTO r FROM runs WHERE id=NEW.run_id;
  SELECT * INTO p FROM context_packs WHERE id=NEW.context_pack_id; SELECT * INTO d FROM goal_recovery_validation_deliveries WHERE id=NEW.delivery_id;
  c:=CASE WHEN NEW.outcome='verified' THEN x.result->'verified_validation' ELSE x.result->'closed_failure' END;
  IF x.id IS NULL OR r.id IS NULL OR p.id IS NULL OR d.id IS NULL OR c IS NULL OR c='null'::jsonb
    OR x.organization_id<>NEW.organization_id OR x.run_id<>r.id OR x.context_pack_id<>p.id OR x.result_digest IS DISTINCT FROM NEW.result_digest
    OR x.result->'closed' IS DISTINCT FROM 'true'::jsonb OR c IS DISTINCT FROM NEW.completion
    OR r.organization_id<>NEW.organization_id OR r.task_id<>x.task_id OR r.context_pack_id IS DISTINCT FROM p.id OR r.agent_instance_id<>x.writer_instance_id OR r.computer_id<>x.computer_id
    OR r.workspace_root IS DISTINCT FROM x.workspace_root OR r.workspace_branch IS NOT NULL OR r.workspace_allocation IS NOT NULL
    OR r.requested_by_user_id IS DISTINCT FROM x.actor_user_id OR r.ai_data_sharing_consent_id IS DISTINCT FROM x.consent_id OR r.ai_data_sharing_policy_version IS DISTINCT FROM x.policy_version
    OR r.verification_requirement IS DISTINCT FROM x.request->'run_start'->'verification'
    OR p.organization_id<>NEW.organization_id OR p.task_id<>x.task_id OR p.run_id IS DISTINCT FROM r.id OR p.payload IS DISTINCT FROM x.request->'run_start'->'context_pack'->'payload'
    OR d.validation_id<>x.id OR d.session_id<>NEW.session_id OR x.result_delivery_id IS DISTINCT FROM d.id OR x.result_session_id IS DISTINCT FROM NEW.session_id
    OR NEW.session_id IS DISTINCT FROM x.session_bindings->'destination'->>'sessionId'
    OR NOT EXISTS(SELECT 1 FROM goal_recovery_validation_deliveries WHERE validation_id=x.id AND session_id=NEW.session_id AND control='start')
    OR (c->>'validation_id'=x.id AND c->>'request_digest'=x.request_digest AND c->>'run_id'=r.id AND c->>'root_validation_id'=x.root_validation_id
      AND c->>'authorization_event_id'=x.authorization_event_id AND (c->>'attempt_index')::integer=x.attempt_index AND (c->>'generation')::integer=x.generation
      AND c->'author'->>'instance_id'=x.writer_instance_id AND c->'author'->>'agent_id'=x.writer_agent_id AND c->>'closure'='windows-job-and-tools-closed.v1') IS NOT TRUE
    THEN RAISE EXCEPTION 'H9 completion lacks exact original author, context and delivery'; END IF;
  IF NEW.outcome='verified' THEN
    IF r.status<>'completed' OR x.result->>'outcome'<>'finished' OR c->>'stage' IS DISTINCT FROM 'validation' OR c->>'scope' IS DISTINCT FROM 'all-declared-workspace-validation-cases'
      THEN RAISE EXCEPTION 'H9 verified completion requires actual successful author'; END IF;
  ELSE
    IF r.status<>'failed' OR r.failure_reason='daemon_disconnect' OR x.result->>'outcome'<>'failed' OR (c->>'failure_kind' IN ('author-failed','verification-failed')) IS NOT TRUE
      OR NOT EXISTS(SELECT 1 FROM event_log WHERE organization_id=x.organization_id AND run_id=r.id AND task_id=x.task_id AND type='run.failed' AND actor_type='agent' AND actor_id=x.writer_instance_id)
      THEN RAISE EXCEPTION 'H9 repairable failure requires original failed terminal facts'; END IF;
  END IF;
  IF NEW.outcome='verified' OR c->>'failure_kind'='verification-failed' THEN
    SELECT * INTO e FROM run_evidence WHERE id=NEW.evidence_id; SELECT * INTO v FROM event_log WHERE id=e.event_id;
    IF e.id IS NULL OR v.id IS NULL OR e.organization_id<>NEW.organization_id OR e.run_id<>r.id OR e.payload IS DISTINCT FROM c->'verification'
      OR e.request_id IS DISTINCT FROM r.verification_requirement->>'request_id'
      OR e.payload->>'profile_id' IS DISTINCT FROM r.verification_requirement->>'profile_id'
      OR e.payload->>'profile_digest' IS DISTINCT FROM r.verification_requirement->'capability_binding'->>'profile_digest'
      OR e.payload->>'subject_digest' IS DISTINCT FROM c->>'subject_digest'
      OR e.payload->>'outcome' IS DISTINCT FROM (CASE WHEN NEW.outcome='verified' THEN 'passed' ELSE 'failed' END)
      OR v.organization_id<>NEW.organization_id OR v.type<>'run.verification' OR v.run_id IS DISTINCT FROM r.id OR v.task_id IS DISTINCT FROM x.task_id
      OR v.actor_type<>'system' OR v.actor_id<>x.computer_id OR v.payload IS DISTINCT FROM e.payload
      THEN RAISE EXCEPTION 'H9 completion lacks original committed verifier evidence'; END IF;
  ELSIF NEW.evidence_id IS NOT NULL OR c ? 'verification' OR EXISTS(SELECT 1 FROM run_evidence WHERE run_id=r.id AND organization_id=x.organization_id)
    THEN RAISE EXCEPTION 'H9 author failure cannot borrow verifier evidence'; END IF;
  IF (NEW.source->>'version'='1' AND NEW.source->>'kind'='recovery-validation' AND NEW.source->>'outcome'=NEW.outcome
    AND NEW.source->>'validation_id'=x.id AND NEW.source->>'request_digest'=x.request_digest AND NEW.source->>'result_digest'=NEW.result_digest
    AND NEW.source->>'root_validation_id'=x.root_validation_id AND (NEW.source->>'generation')::integer=x.generation
    AND NEW.source->'run_start'=x.request->'run_start' AND NEW.source->'author'=x.request->'writer'
    AND NEW.source->>'origin_digest'=c->>'origin_digest' AND NEW.source->>'initial_subject_digest'=c->>'initial_subject_digest'
    AND NEW.source->>'subject_digest'=c->>'subject_digest' AND NEW.source->'baseline'=c->'baseline') IS NOT TRUE
    OR NEW.source->'verification' IS DISTINCT FROM c->'verification'
    OR NEW.outcome='closed-failure' AND (NEW.source->>'failure_kind' IS DISTINCT FROM c->>'failure_kind' OR NEW.source->>'failure_reason' IS DISTINCT FROM c->>'reason')
    THEN RAISE EXCEPTION 'H9 source projection differs from original completion'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_recovery_validation_completions_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_recovery_validation_completions FOR EACH ROW EXECUTE FUNCTION protect_recovery_validation_completion();
--> statement-breakpoint
-- This getter belongs to H9. It never changes the historical H5/H6 source getter.
CREATE FUNCTION recovery_validation_source(operation_id text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE x goal_recovery_validations; c goal_recovery_validation_completions; p goal_recovery_validation_receipts;
BEGIN
  SELECT * INTO x FROM goal_recovery_validations WHERE id=operation_id;
  SELECT * INTO c FROM goal_recovery_validation_completions WHERE validation_id=operation_id;
  SELECT * INTO p FROM goal_recovery_validation_receipts WHERE validation_id=operation_id;
  IF x.id IS NULL OR c.validation_id IS NULL OR p.validation_id IS NULL OR x.stop_requested OR x.ready_at IS NULL
    OR EXISTS(SELECT 1 FROM goal_recovery_validations WHERE root_validation_id=x.root_validation_id AND generation>x.generation)
    OR c.organization_id<>x.organization_id OR c.run_id<>x.run_id OR c.context_pack_id<>x.context_pack_id
    OR c.result_digest IS DISTINCT FROM x.result_digest OR p.result_digest IS DISTINCT FROM x.result_digest OR p.request_digest<>x.request_digest
    OR p.organization_id<>x.organization_id OR p.session_bindings IS DISTINCT FROM x.session_bindings
    OR p.delivery_id IS DISTINCT FROM x.result_delivery_id OR p.session_id IS DISTINCT FROM x.result_session_id
    OR c.delivery_id<>p.delivery_id OR c.session_id<>p.session_id
    THEN RAISE EXCEPTION 'H9 source lacks current original completion and receipt'; END IF;
  RETURN c.source;
END $$;
--> statement-breakpoint
CREATE FUNCTION protect_recovery_validation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h goal_imported_execution_reviews; hp goal_imported_execution_review_receipts; hv event_log;
  parent goal_recovery_validations; review goal_recovery_validation_reviews; rp goal_recovery_validation_review_receipts;
  g goals; t tasks; r runs; pack context_packs; a agent_instances; v event_log;
  d goal_recovery_validation_deliveries; c goal_recovery_validation_completions; p goal_recovery_validation_receipts;
  source jsonb; expected_predecessor jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'H9 author history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','ready_at','ready_event_id','ready_kind'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','ready_at','ready_event_id','ready_kind'])
      OR OLD.stop_requested AND NOT NEW.stop_requested
      OR OLD.result IS NOT NULL AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.result_digest IS DISTINCT FROM OLD.result_digest
        OR NEW.result_delivery_id IS DISTINCT FROM OLD.result_delivery_id OR NEW.result_session_id IS DISTINCT FROM OLD.result_session_id)
      OR OLD.ready_at IS NOT NULL AND (NEW.ready_at IS DISTINCT FROM OLD.ready_at OR NEW.ready_event_id IS DISTINCT FROM OLD.ready_event_id OR NEW.ready_kind IS DISTINCT FROM OLD.ready_kind)
      THEN RAISE EXCEPTION 'H9 author identity, result and readiness are immutable'; END IF;
    IF OLD.result IS NULL AND NEW.result IS NOT NULL THEN
      SELECT * INTO d FROM goal_recovery_validation_deliveries WHERE id=NEW.result_delivery_id;
      IF d.id IS NULL OR d.validation_id<>NEW.id OR d.session_id<>NEW.result_session_id THEN RAISE EXCEPTION 'H9 author result lacks issuing delivery'; END IF;
      IF (NEW.result ? 'verified_validation' OR NEW.result ? 'closed_failure') AND
        (NEW.result_session_id IS DISTINCT FROM NEW.session_bindings->'destination'->>'sessionId'
          OR NOT EXISTS(SELECT 1 FROM goal_recovery_validation_deliveries WHERE validation_id=NEW.id AND session_id=NEW.result_session_id AND control='start'))
        THEN RAISE EXCEPTION 'H9 author completion requires original session and start'; END IF;
    END IF;
    IF OLD.ready_at IS NULL AND NEW.ready_at IS NOT NULL THEN
      SELECT * INTO c FROM goal_recovery_validation_completions WHERE validation_id=NEW.id;
      SELECT * INTO p FROM goal_recovery_validation_receipts WHERE validation_id=NEW.id;
      SELECT * INTO v FROM event_log WHERE id=NEW.ready_event_id;
      SELECT * INTO t FROM tasks WHERE id=NEW.task_id; SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE;
      IF c.validation_id IS NULL OR p.validation_id IS NULL OR v.id IS NULL OR t.id IS NULL OR g.id IS NULL OR NEW.stop_requested
        OR c.result_digest IS DISTINCT FROM NEW.result_digest OR p.result_digest IS DISTINCT FROM NEW.result_digest
        OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id
        OR (NEW.ready_kind='review' AND t.status='review' AND c.outcome='verified'
          OR NEW.ready_kind='repair' AND t.status IN ('blocked','ready') AND c.outcome='closed-failure') IS NOT TRUE
        OR EXISTS(SELECT 1 FROM goal_recovery_validations WHERE root_validation_id=NEW.root_validation_id AND generation>NEW.generation)
        OR v.organization_id<>NEW.organization_id OR v.type<>'goal.recovery-validation.ready' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
        OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.run_id IS DISTINCT FROM NEW.run_id
        OR v.payload->>'validation_id' IS DISTINCT FROM NEW.id OR v.payload->>'result_digest' IS DISTINCT FROM NEW.result_digest
        OR v.payload->>'source_digest' IS DISTINCT FROM c.source_digest OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id
        OR v.payload->>'ready_kind' IS DISTINCT FROM NEW.ready_kind OR v.payload->>'verification_evidence_id' IS DISTINCT FROM c.evidence_id
        OR v.payload->'publication_authorized' IS DISTINCT FROM 'false'::jsonb
        THEN RAISE EXCEPTION 'H9 readiness requires current original completion, receipt and goal'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO h FROM goal_imported_execution_reviews WHERE id=NEW.origin_review_id;
  SELECT * INTO hp FROM goal_imported_execution_review_receipts WHERE review_id=h.id;
  SELECT * INTO hv FROM event_log WHERE id=h.acceptance_event_id;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE; SELECT * INTO t FROM tasks WHERE id=NEW.task_id;
  SELECT * INTO r FROM runs WHERE id=NEW.run_id; SELECT * INTO pack FROM context_packs WHERE id=NEW.context_pack_id;
  SELECT * INTO a FROM agent_instances WHERE id=NEW.writer_instance_id; SELECT * INTO v FROM event_log WHERE id=NEW.authorization_event_id;
  IF h.id IS NULL OR hp.review_id IS NULL OR hv.id IS NULL OR g.id IS NULL OR t.id IS NULL OR r.id IS NULL OR pack.id IS NULL OR a.id IS NULL OR v.id IS NULL
    OR h.stop_requested OR h.accepted_at IS NULL OR (h.result->>'outcome'='reviewed' AND h.result->'verdict'->>'outcome'='accepted') IS NOT TRUE
    OR h.organization_id<>NEW.organization_id OR h.goal_id<>NEW.goal_id OR h.plan_id<>NEW.plan_id
    OR h.computer_id<>NEW.computer_id OR h.workspace_root<>NEW.workspace_root OR h.actor_user_id<>NEW.actor_user_id
    OR h.consent_id IS DISTINCT FROM NEW.consent_id OR h.policy_version<>NEW.policy_version
    OR hp.organization_id<>NEW.organization_id OR hp.request_digest<>h.request_digest OR hp.result_digest IS DISTINCT FROM h.result_digest
    OR hp.delivery_id IS DISTINCT FROM h.result_delivery_id OR hp.session_id IS DISTINCT FROM h.result_session_id OR hp.session_bindings IS DISTINCT FROM h.session_bindings
    OR NEW.request->'origin' IS DISTINCT FROM jsonb_build_object('version',1,'review_id',h.id,'request_digest',h.request_digest,'result_digest',h.result_digest,
      'acceptance_event_id',h.acceptance_event_id,'execution_request',h.request->'execution_request','implementation_source',h.request->'source')
    OR hv.organization_id<>NEW.organization_id OR hv.type<>'goal.imported-execution-review.accepted' OR hv.actor_type<>'system' OR hv.actor_id<>'goal_runner'
    OR hv.goal_id IS DISTINCT FROM NEW.goal_id OR hv.task_id IS DISTINCT FROM h.task_id OR hv.run_id IS DISTINCT FROM h.request->'source'->'run_start'->>'run_id'
    OR hv.payload->>'review_id' IS DISTINCT FROM h.id OR hv.payload->>'result_digest' IS DISTINCT FROM h.result_digest
    OR hv.payload->>'source_digest' IS DISTINCT FROM h.source_digest OR hv.payload->>'actor_user_id' IS DISTINCT FROM h.actor_user_id
    OR hv.payload->'subsequent_stage_authorized' IS DISTINCT FROM 'false'::jsonb
    OR EXISTS(SELECT 1 FROM product_releases WHERE organization_id=NEW.organization_id AND goal_id=NEW.goal_id AND status='queued')
    OR g.organization_id<>NEW.organization_id OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id OR g.retry_count<>NEW.attempt_index
    OR ((g.budgets->>'max_retries')::integer IS NOT NULL AND NEW.attempt_index>(g.budgets->>'max_retries')::integer)
    OR v.organization_id<>NEW.organization_id OR v.type<>'goal.recovery-validation.authorized' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
    OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.run_id IS DISTINCT FROM NEW.run_id
    OR v.payload->>'validation_id' IS DISTINCT FROM NEW.id OR v.payload->>'root_validation_id' IS DISTINCT FROM NEW.root_validation_id
    OR (v.payload->>'generation')::integer IS DISTINCT FROM NEW.generation OR v.payload->>'kind' IS DISTINCT FROM NEW.kind
    OR v.payload->>'origin_review_id' IS DISTINCT FROM h.id OR v.payload->>'source_digest' IS DISTINCT FROM NEW.initial_source_digest
    OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id OR (v.payload->>'attempt_index')::integer IS DISTINCT FROM NEW.attempt_index
    OR (v.payload->>'previous_retry_count')::integer IS DISTINCT FROM NEW.attempt_index-1
    OR v.payload->'publication_authorized' IS DISTINCT FROM 'false'::jsonb
    OR t.organization_id<>NEW.organization_id OR t.goal_id IS DISTINCT FROM NEW.goal_id OR t.source_plan_id IS DISTINCT FROM NEW.plan_id OR t.status<>'assigned'
    OR r.organization_id<>NEW.organization_id OR r.task_id<>t.id OR r.context_pack_id IS DISTINCT FROM pack.id OR r.agent_instance_id<>a.id OR r.computer_id<>NEW.computer_id
    OR r.requested_by_user_id IS DISTINCT FROM NEW.actor_user_id OR r.ai_data_sharing_consent_id IS DISTINCT FROM NEW.consent_id OR r.ai_data_sharing_policy_version IS DISTINCT FROM NEW.policy_version
    OR r.workspace_root IS DISTINCT FROM NEW.workspace_root OR r.workspace_branch IS NOT NULL OR r.workspace_allocation IS NOT NULL OR r.status<>'queued'
    OR pack.organization_id<>NEW.organization_id OR pack.run_id IS DISTINCT FROM r.id OR pack.task_id IS DISTINCT FROM t.id OR pack.payload IS DISTINCT FROM NEW.request->'run_start'->'context_pack'->'payload'
    OR r.verification_requirement IS DISTINCT FROM NEW.request->'run_start'->'verification' OR r.runtime_id IS DISTINCT FROM NEW.request->'run_start'->>'runtime'
    OR a.organization_id<>NEW.organization_id OR a.agent_id<>NEW.writer_agent_id OR a.computer_id<>NEW.computer_id
    OR (NEW.request->'writer'->>'instance_id'=a.id AND NEW.request->'writer'->>'agent_id'=a.agent_id) IS NOT TRUE
    OR NEW.result IS NOT NULL OR NEW.ready_at IS NOT NULL OR NEW.stop_requested
    THEN RAISE EXCEPTION 'H9 author differs from original accepted H6, goal authorization or real writer assignment'; END IF;
  IF NEW.kind='initial' THEN
    SELECT checkpoint INTO source FROM goal_source_recovery_checkpoints WHERE recovery_id=NEW.recovery_id;
    IF source IS NULL OR NEW.request->'checkpoint' IS DISTINCT FROM source OR NEW.request ? 'previous_source' OR NEW.request ? 'predecessor' OR v.payload->'predecessor' IS DISTINCT FROM 'null'::jsonb
      THEN RAISE EXCEPTION 'Initial H9 author must claim its original accepted implementation once'; END IF;
  ELSE
    SELECT * INTO parent FROM goal_recovery_validations WHERE id=NEW.parent_validation_id;
    source:=recovery_validation_source(parent.id);
    IF parent.id IS NULL OR parent.root_validation_id<>NEW.root_validation_id OR parent.generation+1<>NEW.generation
      OR parent.origin_review_id<>NEW.origin_review_id OR parent.organization_id<>NEW.organization_id OR parent.goal_id<>NEW.goal_id OR parent.plan_id<>NEW.plan_id
      OR parent.task_id<>NEW.task_id OR parent.writer_instance_id<>NEW.writer_instance_id OR parent.writer_agent_id<>NEW.writer_agent_id
      OR parent.attempt_index>=NEW.attempt_index OR parent.request->'origin' IS DISTINCT FROM NEW.request->'origin'
      THEN RAISE EXCEPTION 'H9 repair changed its current original author lineage'; END IF;
    IF NEW.predecessor_kind='review' THEN
      SELECT * INTO review FROM goal_recovery_validation_reviews WHERE id=NEW.predecessor_id;
      SELECT * INTO rp FROM goal_recovery_validation_review_receipts WHERE review_id=review.id;
      IF review.id IS NULL OR rp.review_id IS NULL OR review.validation_id<>parent.id OR review.stop_requested OR review.accepted_at IS NOT NULL
        OR review.source_digest IS DISTINCT FROM (SELECT source_digest FROM goal_recovery_validation_completions WHERE validation_id=parent.id)
        OR (review.result->>'outcome'='reviewed' AND review.result->'closed'='true'::jsonb AND review.result->'verdict'->>'outcome'='rejected') IS NOT TRUE
        OR rp.result_digest IS DISTINCT FROM review.result_digest OR rp.request_digest<>review.request_digest
        OR EXISTS(SELECT 1 FROM goal_recovery_validation_reviews WHERE validation_id=parent.id AND sequence>review.sequence)
        OR parent.ready_kind<>'review' OR source->>'outcome' IS DISTINCT FROM 'verified'
        THEN RAISE EXCEPTION 'H9 repair requires the current original rejected final-product review'; END IF;
      expected_predecessor:=jsonb_build_object('kind','review','review_id',review.id,'request_digest',review.request_digest,'result_digest',review.result_digest);
    ELSE
      IF NEW.predecessor_id<>parent.id OR parent.ready_kind<>'repair' OR source->>'outcome' IS DISTINCT FROM 'closed-failure'
        THEN RAISE EXCEPTION 'H9 repair requires an original typed closed failure'; END IF;
      expected_predecessor:=jsonb_build_object('kind','failure','validation_id',parent.id,'request_digest',parent.request_digest,'result_digest',parent.result_digest);
    END IF;
    IF NEW.request->'predecessor' IS DISTINCT FROM expected_predecessor OR v.payload->'predecessor' IS DISTINCT FROM expected_predecessor
      THEN RAISE EXCEPTION 'H9 repair authorization changed its consumed predecessor'; END IF;
  END IF;
  IF COALESCE(NEW.request->'previous_source',NEW.request->'checkpoint') IS DISTINCT FROM source THEN RAISE EXCEPTION 'H9 author changed its exact initial source'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_recovery_validations_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_recovery_validations FOR EACH ROW EXECUTE FUNCTION protect_recovery_validation();
--> statement-breakpoint
CREATE FUNCTION protect_recovery_validation_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x goal_recovery_validations; c goal_recovery_validation_completions; previous goal_recovery_validation_reviews;
  p goal_recovery_validation_review_receipts; d goal_recovery_validation_review_deliveries;
  g goals; t tasks; a agent_instances; v event_log; source jsonb; retry jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'H9 review history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','accepted_at','acceptance_event_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','accepted_at','acceptance_event_id'])
      OR OLD.stop_requested AND NOT NEW.stop_requested
      OR OLD.result IS NOT NULL AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.result_digest IS DISTINCT FROM OLD.result_digest
        OR NEW.result_delivery_id IS DISTINCT FROM OLD.result_delivery_id OR NEW.result_session_id IS DISTINCT FROM OLD.result_session_id)
      OR OLD.accepted_at IS NOT NULL AND (NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NEW.acceptance_event_id IS DISTINCT FROM OLD.acceptance_event_id)
      THEN RAISE EXCEPTION 'H9 reviewer identity, result and acceptance are immutable'; END IF;
    IF OLD.result IS NULL AND NEW.result IS NOT NULL THEN
      SELECT * INTO d FROM goal_recovery_validation_review_deliveries WHERE id=NEW.result_delivery_id;
      IF d.id IS NULL OR d.review_id<>NEW.id OR d.session_id<>NEW.result_session_id THEN RAISE EXCEPTION 'H9 review result lacks issuing delivery'; END IF;
      IF NEW.result->>'outcome' IN ('reviewed','failed') AND (NEW.result_session_id IS DISTINCT FROM NEW.session_bindings->'destination'->>'sessionId'
        OR NOT EXISTS(SELECT 1 FROM goal_recovery_validation_review_deliveries WHERE review_id=NEW.id AND session_id=NEW.result_session_id AND control='start'))
        THEN RAISE EXCEPTION 'H9 closed review requires original session and start'; END IF;
    END IF;
    IF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN
      SELECT * INTO x FROM goal_recovery_validations WHERE id=NEW.validation_id;
      SELECT * INTO c FROM goal_recovery_validation_completions WHERE validation_id=x.id;
      SELECT * INTO p FROM goal_recovery_validation_review_receipts WHERE review_id=NEW.id;
      SELECT * INTO v FROM event_log WHERE id=NEW.acceptance_event_id;
      SELECT * INTO t FROM tasks WHERE id=NEW.task_id; SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE;
      source:=recovery_validation_source(x.id);
      IF x.id IS NULL OR c.validation_id IS NULL OR p.review_id IS NULL OR v.id IS NULL OR t.id IS NULL OR g.id IS NULL OR NEW.stop_requested
        OR x.ready_kind<>'review' OR c.outcome<>'verified' OR c.evidence_id IS NULL OR source IS DISTINCT FROM NEW.request->'source'
        OR p.result_digest IS DISTINCT FROM NEW.result_digest OR c.source_digest<>NEW.source_digest
        OR EXISTS(SELECT 1 FROM goal_recovery_validation_reviews WHERE validation_id=x.id AND sequence>NEW.sequence)
        OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id OR t.status<>'done'
        OR v.organization_id<>NEW.organization_id OR v.type<>'goal.recovery-validation-review.accepted' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
        OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.run_id IS DISTINCT FROM x.run_id
        OR v.payload->>'review_id' IS DISTINCT FROM NEW.id OR v.payload->>'validation_id' IS DISTINCT FROM x.id
        OR v.payload->>'result_digest' IS DISTINCT FROM NEW.result_digest OR v.payload->>'source_digest' IS DISTINCT FROM NEW.source_digest
        OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id OR v.payload->>'subject_digest' IS DISTINCT FROM source->>'subject_digest'
        OR v.payload->>'verification_evidence_id' IS DISTINCT FROM c.evidence_id OR v.payload->'publication_authorized' IS DISTINCT FROM 'false'::jsonb
        THEN RAISE EXCEPTION 'H9 acceptance lacks the current complete product, original receipt and goal'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO x FROM goal_recovery_validations WHERE id=NEW.validation_id;
  SELECT * INTO c FROM goal_recovery_validation_completions WHERE validation_id=x.id;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE; SELECT * INTO t FROM tasks WHERE id=NEW.task_id;
  SELECT * INTO a FROM agent_instances WHERE id=NEW.reviewer_instance_id; SELECT * INTO v FROM event_log WHERE id=NEW.authorization_event_id;
  source:=recovery_validation_source(x.id);
  IF x.id IS NULL OR c.validation_id IS NULL OR g.id IS NULL OR t.id IS NULL OR a.id IS NULL OR v.id IS NULL
    OR x.ready_kind<>'review' OR c.outcome<>'verified' OR c.source_digest<>NEW.source_digest
    OR x.organization_id<>NEW.organization_id OR x.goal_id<>NEW.goal_id OR x.plan_id<>NEW.plan_id OR x.task_id<>NEW.task_id
    OR x.computer_id<>NEW.computer_id OR x.workspace_root<>NEW.workspace_root OR x.actor_user_id<>NEW.actor_user_id
    OR x.consent_id IS DISTINCT FROM NEW.consent_id OR x.policy_version<>NEW.policy_version OR x.session_bindings IS DISTINCT FROM NEW.session_bindings
    OR x.writer_instance_id<>NEW.author_instance_id OR x.writer_agent_id<>NEW.author_agent_id
    OR a.organization_id<>NEW.organization_id OR a.agent_id<>NEW.reviewer_agent_id OR a.computer_id<>NEW.computer_id
    OR g.organization_id<>NEW.organization_id OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id OR g.retry_count<>NEW.attempt_index
    OR ((g.budgets->>'max_retries')::integer IS NOT NULL AND NEW.attempt_index>(g.budgets->>'max_retries')::integer)
    OR t.organization_id<>NEW.organization_id OR t.goal_id IS DISTINCT FROM NEW.goal_id OR t.source_plan_id IS DISTINCT FROM NEW.plan_id OR t.status<>'review'
    OR NEW.request->'version' IS DISTINCT FROM '1'::jsonb OR NEW.request->>'review_id' IS DISTINCT FROM NEW.id
    OR NEW.request->'source' IS DISTINCT FROM source OR NEW.request->'origin' IS DISTINCT FROM x.request->'origin'
    OR NEW.request->'reviewer' IS DISTINCT FROM jsonb_build_object('instance_id',a.id,'agent_id',a.agent_id)
    OR NEW.request->'authorization' IS DISTINCT FROM jsonb_build_object('event_id',v.id,'goal_id',g.id,'attempt_index',NEW.attempt_index)
    OR v.organization_id<>NEW.organization_id OR v.type<>'goal.recovery-validation-review.authorized' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
    OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.run_id IS DISTINCT FROM x.run_id
    OR v.payload->>'review_id' IS DISTINCT FROM NEW.id OR v.payload->>'validation_id' IS DISTINCT FROM x.id
    OR v.payload->>'source_digest' IS DISTINCT FROM NEW.source_digest OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id
    OR (v.payload->>'attempt_index')::integer IS DISTINCT FROM NEW.attempt_index
    OR (v.payload->>'previous_retry_count')::integer IS DISTINCT FROM NEW.attempt_index-(CASE WHEN NEW.retry_of IS NULL THEN 0 ELSE 1 END)
    OR v.payload->'execution_authorized' IS DISTINCT FROM 'false'::jsonb
    OR NEW.result IS NOT NULL OR NEW.accepted_at IS NOT NULL OR NEW.stop_requested
    OR EXISTS(SELECT 1 FROM product_releases WHERE organization_id=NEW.organization_id AND goal_id=NEW.goal_id AND status='queued')
    THEN RAISE EXCEPTION 'H9 review differs from its current verified product, independent reviewer or original goal authorization'; END IF;
  IF NEW.retry_of IS NULL THEN
    IF NEW.request ? 'retry_of' OR v.payload->'retry_of' IS DISTINCT FROM 'null'::jsonb
      THEN RAISE EXCEPTION 'Initial H9 review cannot borrow retry authority'; END IF;
  ELSE
    SELECT * INTO previous FROM goal_recovery_validation_reviews WHERE id=NEW.retry_of;
    SELECT * INTO p FROM goal_recovery_validation_review_receipts WHERE review_id=NEW.retry_of;
    retry:=jsonb_build_object('review_id',previous.id,'request_digest',previous.request_digest,'result_digest',previous.result_digest);
    IF previous.id IS NULL OR p.review_id IS NULL OR previous.validation_id<>x.id OR previous.sequence+1<>NEW.sequence OR previous.attempt_index>=NEW.attempt_index
      OR previous.stop_requested OR previous.accepted_at IS NOT NULL OR (previous.result->>'outcome'='failed' AND previous.result->'closed'='true'::jsonb) IS NOT TRUE
      OR previous.reviewer_instance_id<>NEW.reviewer_instance_id OR previous.reviewer_agent_id<>NEW.reviewer_agent_id
      OR previous.source_digest<>NEW.source_digest OR p.result_digest IS DISTINCT FROM previous.result_digest OR p.request_digest<>previous.request_digest
      OR EXISTS(SELECT 1 FROM goal_recovery_validation_reviews WHERE validation_id=x.id AND sequence>previous.sequence)
      OR NEW.request->'retry_of' IS DISTINCT FROM retry OR v.payload->'retry_of' IS DISTINCT FROM retry
      THEN RAISE EXCEPTION 'H9 review retry requires the exact latest closed failure and original retry budget'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_recovery_validation_reviews_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_recovery_validation_reviews FOR EACH ROW EXECUTE FUNCTION protect_recovery_validation_review();
--> statement-breakpoint
CREATE INDEX goal_recovery_validation_publication_goal_idx ON goal_recovery_validation_publications(organization_id,goal_id);
--> statement-breakpoint
-- Extra H9 bindings compose with the independent H7-equivalent invariant functions.
CREATE FUNCTION protect_recovery_validation_checkpoint_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recovery goal_source_recoveries%ROWTYPE; c goal_source_recovery_checkpoints%ROWTYPE; registered node_recovery_registrations%ROWTYPE;
  parent goal_recovery_validations%ROWTYPE; descriptor jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RETURN NEW; END IF;
  SELECT * INTO recovery FROM goal_source_recoveries WHERE id=NEW.recovery_id;
  SELECT * INTO c FROM goal_source_recovery_checkpoints WHERE recovery_id=NEW.recovery_id;
  SELECT * INTO registered FROM node_recovery_registrations WHERE epoch_id=c.new_epoch_id AND organization_id=NEW.organization_id;
  IF recovery.id IS NULL OR c.recovery_id IS NULL OR registered.id IS NULL OR recovery.settled_at IS NULL OR recovery.stop_requested
    OR recovery.organization_id<>NEW.organization_id OR recovery.goal_id<>NEW.goal_id OR recovery.plan_id<>NEW.plan_id OR recovery.computer_id<>NEW.computer_id
    OR recovery.actor_user_id<>NEW.actor_user_id OR recovery.consent_id IS DISTINCT FROM NEW.consent_id OR recovery.policy_version<>NEW.policy_version
    OR registered.computer_id<>NEW.computer_id OR registered.session_id<>c.session_id OR registered.registration->'binding' IS DISTINCT FROM c.checkpoint->'binding'
    OR NEW.session_bindings->'destination' IS DISTINCT FROM jsonb_build_object('computerId',registered.computer_id,'deviceId',registered.device_id,'tokenLookup',registered.token_lookup,'sessionId',registered.session_id)
    OR NEW.request->>'recovery_id' IS DISTINCT FROM recovery.id OR NEW.request->'checkpoint' IS DISTINCT FROM c.checkpoint
    OR NOT EXISTS(SELECT 1 FROM goal_source_recovery_receipts WHERE recovery_id=recovery.id AND result_digest=recovery.result_digest)
    THEN RAISE EXCEPTION 'Fresh H9 work lacks settled old epoch, exact unverified checkpoint and registered new epoch'; END IF;
  IF TG_TABLE_NAME='goal_recovery_validations' THEN
    descriptor:=NEW.request->'run_start'->'context_pack'->'payload'->'imported_recovery_validation';
    IF NEW.origin_review_id<>recovery.origin_review_id OR NEW.attempt_index<1
      OR (descriptor->'version'='1'::jsonb AND descriptor->>'recovery_id'=recovery.id AND descriptor->>'checkpoint_digest'=c.checkpoint_digest
        AND descriptor->>'epoch_id'=c.new_epoch_id AND descriptor->>'validation_id'=NEW.id AND descriptor->>'authorization_event_id'=NEW.authorization_event_id
        AND (descriptor->>'attempt_index')::integer=NEW.attempt_index) IS NOT TRUE
      THEN RAISE EXCEPTION 'Fresh recovery author changed checkpoint, epoch or original retry consumption'; END IF;
    IF NEW.parent_validation_id IS NOT NULL THEN
      SELECT * INTO parent FROM goal_recovery_validations WHERE id=NEW.parent_validation_id;
      IF parent.recovery_id<>NEW.recovery_id THEN RAISE EXCEPTION 'Recovery repair cannot cross checkpoint lineage'; END IF;
    END IF;
  ELSE
    SELECT * INTO parent FROM goal_recovery_validations WHERE id=NEW.validation_id;
    descriptor:=NEW.request->'review_start'->'context_pack'->'payload'->'imported_recovery_validation_review_subject';
    IF parent.id IS NULL OR parent.recovery_id<>NEW.recovery_id
      OR (descriptor->'version'='1'::jsonb AND descriptor->>'recovery_id'=recovery.id AND descriptor->>'checkpoint_digest'=c.checkpoint_digest
        AND descriptor->>'epoch_id'=c.new_epoch_id AND descriptor->>'validation_id'=parent.id AND descriptor->>'review_id'=NEW.id
        AND descriptor->>'source_digest'=NEW.source_digest AND descriptor->>'authorization_event_id'=NEW.authorization_event_id) IS NOT TRUE
      THEN RAISE EXCEPTION 'Recovery independent review changed its exact checkpoint or new author'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_recovery_validations_checkpoint BEFORE INSERT ON goal_recovery_validations FOR EACH ROW EXECUTE FUNCTION protect_recovery_validation_checkpoint_v1();
--> statement-breakpoint
CREATE TRIGGER goal_recovery_validation_reviews_checkpoint BEFORE INSERT ON goal_recovery_validation_reviews FOR EACH ROW EXECUTE FUNCTION protect_recovery_validation_checkpoint_v1();
--> statement-breakpoint
CREATE FUNCTION protect_recovery_completion_checkpoint_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE author goal_recovery_validations%ROWTYPE; c goal_source_recovery_checkpoints%ROWTYPE;
BEGIN
  SELECT * INTO author FROM goal_recovery_validations WHERE id=NEW.validation_id;
  SELECT * INTO c FROM goal_source_recovery_checkpoints WHERE recovery_id=author.recovery_id;
  IF author.id IS NULL OR c.recovery_id IS NULL OR NEW.completion->>'recovery_id' IS DISTINCT FROM author.recovery_id
    OR NEW.completion->>'checkpoint_digest' IS DISTINCT FROM c.checkpoint_digest OR NEW.source->>'recovery_id' IS DISTINCT FROM author.recovery_id
    OR NEW.source->>'checkpoint_digest' IS DISTINCT FROM c.checkpoint_digest
    THEN RAISE EXCEPTION 'Recovery completion cannot borrow another checkpoint'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_recovery_validation_completions_checkpoint BEFORE INSERT ON goal_recovery_validation_completions FOR EACH ROW EXECUTE FUNCTION protect_recovery_completion_checkpoint_v1();
