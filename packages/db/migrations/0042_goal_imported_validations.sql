-- H7 owns a new validation lineage. Earlier H6 records and functions remain unchanged.
CREATE TABLE goal_imported_validations (
  id text PRIMARY KEY, root_validation_id text NOT NULL REFERENCES goal_imported_validations(id),
  origin_review_id text NOT NULL REFERENCES goal_imported_execution_reviews(id), parent_validation_id text REFERENCES goal_imported_validations(id),
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
  CONSTRAINT goal_imported_validations_generation_uniq UNIQUE(root_validation_id,generation),
  CONSTRAINT goal_imported_validations_predecessor_uniq UNIQUE(organization_id,predecessor_kind,predecessor_id),
  CONSTRAINT goal_imported_validations_parent_uniq UNIQUE(parent_validation_id),
  CONSTRAINT goal_imported_validations_run_uniq UNIQUE(run_id),
  CONSTRAINT goal_imported_validations_task_generation_uniq UNIQUE(task_id,generation),
  CONSTRAINT goal_imported_validations_lineage_chk CHECK((kind='initial' AND generation=0 AND root_validation_id=id AND parent_validation_id IS NULL AND predecessor_kind='initial' AND predecessor_id=origin_review_id)
    OR (kind='repair' AND generation>0 AND root_validation_id<>id AND parent_validation_id IS NOT NULL AND predecessor_kind IN ('review','failure'))),
  CONSTRAINT goal_imported_validations_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND initial_source_digest ~ '^sha256:[a-f0-9]{64}$' AND (result_digest IS NULL OR result_digest ~ '^sha256:[a-f0-9]{64}$')),
  CONSTRAINT goal_imported_validations_request_chk CHECK((request->'version'='1'::jsonb AND request->>'validation_id'=id AND request->>'root_validation_id'=root_validation_id
    AND (request->>'generation')::integer=generation AND request->>'kind'=kind AND request->'origin'->>'review_id'=origin_review_id
    AND request->'run_start'->>'run_id'=run_id AND request->'run_start'->>'task_id'=task_id AND request->'run_start'->'context_pack'->>'id'=context_pack_id
    AND request->'run_start'->>'agent_instance_id'=writer_instance_id AND request->'run_start'->'workspace'->>'root'=workspace_root
    AND request->'authorization'->>'event_id'=authorization_event_id AND request->'authorization'->>'goal_id'=goal_id
    AND (request->'authorization'->>'attempt_index')::integer=attempt_index AND attempt_index>=0) IS TRUE),
  CONSTRAINT goal_imported_validations_result_chk CHECK((result IS NULL AND result_digest IS NULL AND result_delivery_id IS NULL AND result_session_id IS NULL)
    OR (result IS NOT NULL AND result_digest IS NOT NULL AND result_delivery_id IS NOT NULL AND result_session_id IS NOT NULL
      AND result->'version'='1'::jsonb AND result->>'validation_id'=id AND result->>'request_digest'=request_digest AND result->>'run_id'=run_id
      AND result->>'outcome' IN ('finished','failed','uncertain','cancelled_before_start') AND result->'closed'=to_jsonb(result->>'outcome'<>'uncertain')) IS TRUE),
  CONSTRAINT goal_imported_validations_ready_chk CHECK((ready_at IS NULL AND ready_event_id IS NULL AND ready_kind IS NULL)
    OR (ready_at IS NOT NULL AND ready_event_id IS NOT NULL AND (ready_kind='review' AND result->>'outcome'='finished' AND result->'verified_validation'->'verification'->>'outcome'='passed'
      OR ready_kind='repair' AND result->>'outcome'='failed' AND result->'closed_failure' IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_imported_validation_deliveries (
  id text PRIMARY KEY, validation_id text NOT NULL REFERENCES goal_imported_validations(id), session_id text NOT NULL, control text NOT NULL, ack jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_validation_delivery_session_uniq UNIQUE(validation_id,session_id,control),
  CONSTRAINT goal_imported_validation_delivery_control_chk CHECK(control IN ('start','stop','status'))
);
--> statement-breakpoint
ALTER TABLE goal_imported_validations ADD CONSTRAINT goal_imported_validations_delivery_fk FOREIGN KEY(result_delivery_id) REFERENCES goal_imported_validation_deliveries(id);
--> statement-breakpoint
CREATE TABLE goal_imported_validation_completions (
  validation_id text PRIMARY KEY REFERENCES goal_imported_validations(id), organization_id text NOT NULL REFERENCES organizations(id),
  run_id text NOT NULL REFERENCES runs(id), context_pack_id text NOT NULL REFERENCES context_packs(id), evidence_id text REFERENCES run_evidence(id),
  delivery_id text NOT NULL REFERENCES goal_imported_validation_deliveries(id), session_id text NOT NULL, outcome text NOT NULL,
  result_digest text NOT NULL, completion_digest text NOT NULL, completion jsonb NOT NULL, source_digest text NOT NULL, source jsonb NOT NULL, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_validation_completion_outcome_chk CHECK(outcome IN ('verified','closed-failure') AND (outcome<>'verified' OR evidence_id IS NOT NULL)),
  CONSTRAINT goal_imported_validation_completion_digest_chk CHECK(result_digest ~ '^sha256:[a-f0-9]{64}$' AND completion_digest ~ '^sha256:[a-f0-9]{64}$' AND source_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_imported_validation_receipts (
  validation_id text PRIMARY KEY REFERENCES goal_imported_validations(id), organization_id text NOT NULL REFERENCES organizations(id),
  delivery_id text NOT NULL REFERENCES goal_imported_validation_deliveries(id), session_id text NOT NULL, session_bindings jsonb NOT NULL,
  request_digest text NOT NULL, result_digest text NOT NULL, sent_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_validation_receipt_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND result_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_imported_validation_reviews (
  id text PRIMARY KEY, validation_id text NOT NULL REFERENCES goal_imported_validation_completions(validation_id), retry_of text REFERENCES goal_imported_validation_reviews(id), sequence integer NOT NULL,
  source_digest text NOT NULL, organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id), task_id text NOT NULL REFERENCES tasks(id),
  author_instance_id text NOT NULL REFERENCES agent_instances(id), author_agent_id text NOT NULL REFERENCES agents(id), reviewer_instance_id text NOT NULL REFERENCES agent_instances(id), reviewer_agent_id text NOT NULL REFERENCES agents(id),
  computer_id text NOT NULL REFERENCES computers(id), workspace_root text NOT NULL, actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL,
  authorization_event_id text NOT NULL REFERENCES event_log(id), attempt_index integer NOT NULL, session_bindings jsonb NOT NULL, request_digest text NOT NULL, request jsonb NOT NULL,
  result jsonb, result_digest text, result_delivery_id text, result_session_id text, stop_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL,
  accepted_at timestamptz, acceptance_event_id text REFERENCES event_log(id),
  CONSTRAINT goal_imported_validation_review_sequence_uniq UNIQUE(validation_id,sequence),
  CONSTRAINT goal_imported_validation_review_retry_uniq UNIQUE(retry_of),
  CONSTRAINT goal_imported_validation_review_independent_chk CHECK(author_instance_id<>reviewer_instance_id AND author_agent_id<>reviewer_agent_id),
  CONSTRAINT goal_imported_validation_review_sequence_chk CHECK(attempt_index>=0 AND ((sequence=0 AND retry_of IS NULL) OR (sequence>0 AND retry_of IS NOT NULL))),
  CONSTRAINT goal_imported_validation_review_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND source_digest ~ '^sha256:[a-f0-9]{64}$' AND (result_digest IS NULL OR result_digest ~ '^sha256:[a-f0-9]{64}$')),
  CONSTRAINT goal_imported_validation_review_result_chk CHECK((result IS NULL AND result_digest IS NULL AND result_delivery_id IS NULL AND result_session_id IS NULL)
    OR (result IS NOT NULL AND result_digest IS NOT NULL AND result_delivery_id IS NOT NULL AND result_session_id IS NOT NULL AND result->'version'='1'::jsonb
      AND result->>'review_id'=id AND result->>'request_digest'=request_digest AND result->'execution_authorized'='false'::jsonb
      AND result->>'outcome' IN ('reviewed','failed','uncertain','cancelled_before_start') AND result->'closed'=to_jsonb(result->>'outcome'<>'uncertain')) IS TRUE),
  CONSTRAINT goal_imported_validation_review_accepted_chk CHECK((accepted_at IS NULL AND acceptance_event_id IS NULL) OR (accepted_at IS NOT NULL AND acceptance_event_id IS NOT NULL
    AND result->>'outcome'='reviewed' AND result->'verdict'->>'outcome'='accepted') IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_imported_validation_review_deliveries (
  id text PRIMARY KEY, review_id text NOT NULL REFERENCES goal_imported_validation_reviews(id), session_id text NOT NULL, control text NOT NULL, ack jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_validation_review_delivery_session_uniq UNIQUE(review_id,session_id,control),
  CONSTRAINT goal_imported_validation_review_delivery_control_chk CHECK(control IN ('start','stop','status'))
);
--> statement-breakpoint
ALTER TABLE goal_imported_validation_reviews ADD CONSTRAINT goal_imported_validation_reviews_delivery_fk FOREIGN KEY(result_delivery_id) REFERENCES goal_imported_validation_review_deliveries(id);
--> statement-breakpoint
CREATE TABLE goal_imported_validation_review_receipts (
  review_id text PRIMARY KEY REFERENCES goal_imported_validation_reviews(id), organization_id text NOT NULL REFERENCES organizations(id),
  delivery_id text NOT NULL REFERENCES goal_imported_validation_review_deliveries(id), session_id text NOT NULL, session_bindings jsonb NOT NULL,
  request_digest text NOT NULL, result_digest text NOT NULL, sent_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_validation_review_receipt_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND result_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_imported_validation_publications (
  release_id text PRIMARY KEY REFERENCES product_releases(id), organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id),
  validation_id text NOT NULL REFERENCES goal_imported_validation_completions(validation_id), review_id text NOT NULL REFERENCES goal_imported_validation_reviews(id),
  origin_review_id text NOT NULL REFERENCES goal_imported_execution_reviews(id), acceptance_event_id text NOT NULL REFERENCES event_log(id),
  run_id text NOT NULL REFERENCES runs(id), evidence_id text NOT NULL REFERENCES run_evidence(id), computer_id text NOT NULL REFERENCES computers(id),
  source_digest text NOT NULL, origin jsonb NOT NULL, capabilities jsonb NOT NULL, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_validation_publication_goal_uniq UNIQUE(organization_id,goal_id),
  CONSTRAINT goal_imported_validation_publication_digest_chk CHECK(source_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
-- A delivery identity is permanent; only its first exact acknowledgment can be added.
CREATE FUNCTION protect_imported_validation_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x jsonb; operation_id text; payload_key text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'H7 delivery history is immutable'; END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'ack') IS DISTINCT FROM (to_jsonb(OLD)-'ack') OR OLD.ack IS NOT NULL AND NEW.ack IS DISTINCT FROM OLD.ack)
    THEN RAISE EXCEPTION 'H7 delivery identity or acknowledgment is immutable'; END IF;
  IF TG_TABLE_NAME='goal_imported_validation_deliveries' THEN
    operation_id:=NEW.validation_id; payload_key:='validation_id'; SELECT to_jsonb(v) INTO x FROM goal_imported_validations v WHERE id=operation_id;
  ELSE
    operation_id:=NEW.review_id; payload_key:='review_id'; SELECT to_jsonb(v) INTO x FROM goal_imported_validation_reviews v WHERE id=operation_id;
  END IF;
  IF x IS NULL OR TG_OP='INSERT' AND NEW.control='start' AND (NEW.session_id IS DISTINCT FROM x->'session_bindings'->'destination'->>'sessionId' OR x->'stop_requested'='true'::jsonb OR x->'result'<>'null'::jsonb)
    THEN RAISE EXCEPTION 'H7 start delivery lacks its original live operation'; END IF;
  IF NEW.ack IS NOT NULL AND (NEW.ack->>'command_id'=NEW.id AND NEW.ack->>'node_id'=x->>'computer_id'
    AND NEW.ack->'payload'->>payload_key=operation_id AND NEW.ack->'payload'->>'request_digest'=x->>'request_digest'
    AND NEW.ack->>'status' IN ('accepted','rejected')) IS NOT TRUE THEN RAISE EXCEPTION 'H7 acknowledgment differs from issuing delivery'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_validation_deliveries_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_validation_deliveries FOR EACH ROW EXECUTE FUNCTION protect_imported_validation_delivery();
--> statement-breakpoint
CREATE TRIGGER goal_imported_validation_review_deliveries_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_validation_review_deliveries FOR EACH ROW EXECUTE FUNCTION protect_imported_validation_delivery();
--> statement-breakpoint
CREATE FUNCTION protect_imported_validation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x jsonb; d jsonb; operation_id text; payload_key text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'H7 receipt history is immutable'; END IF;
  IF TG_TABLE_NAME='goal_imported_validation_receipts' THEN
    operation_id:=NEW.validation_id; payload_key:='validation_id'; SELECT to_jsonb(v) INTO x FROM goal_imported_validations v WHERE id=operation_id;
    SELECT to_jsonb(v) INTO d FROM goal_imported_validation_deliveries v WHERE id=NEW.delivery_id;
    IF NOT EXISTS(SELECT 1 FROM goal_imported_validation_completions WHERE validation_id=operation_id AND organization_id=NEW.organization_id AND result_digest=NEW.result_digest)
      THEN RAISE EXCEPTION 'H7 author receipt requires original completion provenance'; END IF;
  ELSE
    operation_id:=NEW.review_id; payload_key:='review_id'; SELECT to_jsonb(v) INTO x FROM goal_imported_validation_reviews v WHERE id=operation_id;
    SELECT to_jsonb(v) INTO d FROM goal_imported_validation_review_deliveries v WHERE id=NEW.delivery_id;
    IF (x->'result'->'closed'='true'::jsonb AND x->'result'->>'outcome' IN ('reviewed','failed')) IS NOT TRUE
      THEN RAISE EXCEPTION 'H7 review receipt requires a closed review result'; END IF;
  END IF;
  IF x IS NULL OR d IS NULL OR x->>'organization_id' IS DISTINCT FROM NEW.organization_id OR d->>payload_key IS DISTINCT FROM operation_id
    OR d->>'session_id' IS DISTINCT FROM NEW.session_id OR x->>'result_delivery_id' IS DISTINCT FROM NEW.delivery_id OR x->>'result_session_id' IS DISTINCT FROM NEW.session_id
    OR x->>'request_digest' IS DISTINCT FROM NEW.request_digest OR x->>'result_digest' IS DISTINCT FROM NEW.result_digest
    OR x->'session_bindings' IS DISTINCT FROM NEW.session_bindings OR x->'session_bindings'->'destination'->>'sessionId' IS DISTINCT FROM NEW.session_id
    THEN RAISE EXCEPTION 'H7 receipt differs from original result, delivery or session'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_validation_receipts_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_validation_receipts FOR EACH ROW EXECUTE FUNCTION protect_imported_validation_receipt();
--> statement-breakpoint
CREATE TRIGGER goal_imported_validation_review_receipts_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_validation_review_receipts FOR EACH ROW EXECUTE FUNCTION protect_imported_validation_receipt();
--> statement-breakpoint
CREATE FUNCTION protect_imported_validation_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x goal_imported_validations; r runs; p context_packs; d goal_imported_validation_deliveries; e run_evidence; v event_log; c jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'H7 completion provenance is immutable'; END IF;
  SELECT * INTO x FROM goal_imported_validations WHERE id=NEW.validation_id; SELECT * INTO r FROM runs WHERE id=NEW.run_id;
  SELECT * INTO p FROM context_packs WHERE id=NEW.context_pack_id; SELECT * INTO d FROM goal_imported_validation_deliveries WHERE id=NEW.delivery_id;
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
    OR NOT EXISTS(SELECT 1 FROM goal_imported_validation_deliveries WHERE validation_id=x.id AND session_id=NEW.session_id AND control='start')
    OR (c->>'validation_id'=x.id AND c->>'request_digest'=x.request_digest AND c->>'run_id'=r.id AND c->>'root_validation_id'=x.root_validation_id
      AND c->>'authorization_event_id'=x.authorization_event_id AND (c->>'attempt_index')::integer=x.attempt_index AND (c->>'generation')::integer=x.generation
      AND c->'author'->>'instance_id'=x.writer_instance_id AND c->'author'->>'agent_id'=x.writer_agent_id AND c->>'closure'='windows-job-and-tools-closed.v1') IS NOT TRUE
    THEN RAISE EXCEPTION 'H7 completion lacks exact original author, context and delivery'; END IF;
  IF NEW.outcome='verified' THEN
    IF r.status<>'completed' OR x.result->>'outcome'<>'finished' OR c->>'stage' IS DISTINCT FROM 'validation' OR c->>'scope' IS DISTINCT FROM 'all-declared-workspace-validation-cases'
      THEN RAISE EXCEPTION 'H7 verified completion requires actual successful author'; END IF;
  ELSE
    IF r.status<>'failed' OR r.failure_reason='daemon_disconnect' OR x.result->>'outcome'<>'failed' OR (c->>'failure_kind' IN ('author-failed','verification-failed')) IS NOT TRUE
      OR NOT EXISTS(SELECT 1 FROM event_log WHERE organization_id=x.organization_id AND run_id=r.id AND task_id=x.task_id AND type='run.failed' AND actor_type='agent' AND actor_id=x.writer_instance_id)
      THEN RAISE EXCEPTION 'H7 repairable failure requires original failed terminal facts'; END IF;
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
      THEN RAISE EXCEPTION 'H7 completion lacks original committed verifier evidence'; END IF;
  ELSIF NEW.evidence_id IS NOT NULL OR c ? 'verification' OR EXISTS(SELECT 1 FROM run_evidence WHERE run_id=r.id AND organization_id=x.organization_id)
    THEN RAISE EXCEPTION 'H7 author failure cannot borrow verifier evidence'; END IF;
  IF (NEW.source->>'version'='1' AND NEW.source->>'kind'='validation' AND NEW.source->>'outcome'=NEW.outcome
    AND NEW.source->>'validation_id'=x.id AND NEW.source->>'request_digest'=x.request_digest AND NEW.source->>'result_digest'=NEW.result_digest
    AND NEW.source->>'root_validation_id'=x.root_validation_id AND (NEW.source->>'generation')::integer=x.generation
    AND NEW.source->'run_start'=x.request->'run_start' AND NEW.source->'author'=x.request->'writer'
    AND NEW.source->>'origin_digest'=c->>'origin_digest' AND NEW.source->>'initial_subject_digest'=c->>'initial_subject_digest'
    AND NEW.source->>'subject_digest'=c->>'subject_digest' AND NEW.source->'baseline'=c->'baseline') IS NOT TRUE
    OR NEW.source->'verification' IS DISTINCT FROM c->'verification'
    OR NEW.outcome='closed-failure' AND (NEW.source->>'failure_kind' IS DISTINCT FROM c->>'failure_kind' OR NEW.source->>'failure_reason' IS DISTINCT FROM c->>'reason')
    THEN RAISE EXCEPTION 'H7 source projection differs from original completion'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_validation_completions_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_validation_completions FOR EACH ROW EXECUTE FUNCTION protect_imported_validation_completion();
--> statement-breakpoint
-- This getter belongs to H7. It never changes the historical H5/H6 source getter.
CREATE FUNCTION imported_validation_source(operation_id text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE x goal_imported_validations; c goal_imported_validation_completions; p goal_imported_validation_receipts;
BEGIN
  SELECT * INTO x FROM goal_imported_validations WHERE id=operation_id;
  SELECT * INTO c FROM goal_imported_validation_completions WHERE validation_id=operation_id;
  SELECT * INTO p FROM goal_imported_validation_receipts WHERE validation_id=operation_id;
  IF x.id IS NULL OR c.validation_id IS NULL OR p.validation_id IS NULL OR x.stop_requested OR x.ready_at IS NULL
    OR EXISTS(SELECT 1 FROM goal_imported_validations WHERE root_validation_id=x.root_validation_id AND generation>x.generation)
    OR c.organization_id<>x.organization_id OR c.run_id<>x.run_id OR c.context_pack_id<>x.context_pack_id
    OR c.result_digest IS DISTINCT FROM x.result_digest OR p.result_digest IS DISTINCT FROM x.result_digest OR p.request_digest<>x.request_digest
    OR p.organization_id<>x.organization_id OR p.session_bindings IS DISTINCT FROM x.session_bindings
    OR p.delivery_id IS DISTINCT FROM x.result_delivery_id OR p.session_id IS DISTINCT FROM x.result_session_id
    OR c.delivery_id<>p.delivery_id OR c.session_id<>p.session_id
    THEN RAISE EXCEPTION 'H7 source lacks current original completion and receipt'; END IF;
  RETURN c.source;
END $$;
--> statement-breakpoint
CREATE FUNCTION protect_imported_validation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h goal_imported_execution_reviews; hp goal_imported_execution_review_receipts; hv event_log;
  parent goal_imported_validations; review goal_imported_validation_reviews; rp goal_imported_validation_review_receipts;
  g goals; t tasks; r runs; pack context_packs; a agent_instances; v event_log;
  d goal_imported_validation_deliveries; c goal_imported_validation_completions; p goal_imported_validation_receipts;
  source jsonb; expected_predecessor jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'H7 author history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','ready_at','ready_event_id','ready_kind'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','ready_at','ready_event_id','ready_kind'])
      OR OLD.stop_requested AND NOT NEW.stop_requested
      OR OLD.result IS NOT NULL AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.result_digest IS DISTINCT FROM OLD.result_digest
        OR NEW.result_delivery_id IS DISTINCT FROM OLD.result_delivery_id OR NEW.result_session_id IS DISTINCT FROM OLD.result_session_id)
      OR OLD.ready_at IS NOT NULL AND (NEW.ready_at IS DISTINCT FROM OLD.ready_at OR NEW.ready_event_id IS DISTINCT FROM OLD.ready_event_id OR NEW.ready_kind IS DISTINCT FROM OLD.ready_kind)
      THEN RAISE EXCEPTION 'H7 author identity, result and readiness are immutable'; END IF;
    IF OLD.result IS NULL AND NEW.result IS NOT NULL THEN
      SELECT * INTO d FROM goal_imported_validation_deliveries WHERE id=NEW.result_delivery_id;
      IF d.id IS NULL OR d.validation_id<>NEW.id OR d.session_id<>NEW.result_session_id THEN RAISE EXCEPTION 'H7 author result lacks issuing delivery'; END IF;
      IF (NEW.result ? 'verified_validation' OR NEW.result ? 'closed_failure') AND
        (NEW.result_session_id IS DISTINCT FROM NEW.session_bindings->'destination'->>'sessionId'
          OR NOT EXISTS(SELECT 1 FROM goal_imported_validation_deliveries WHERE validation_id=NEW.id AND session_id=NEW.result_session_id AND control='start'))
        THEN RAISE EXCEPTION 'H7 author completion requires original session and start'; END IF;
    END IF;
    IF OLD.ready_at IS NULL AND NEW.ready_at IS NOT NULL THEN
      SELECT * INTO c FROM goal_imported_validation_completions WHERE validation_id=NEW.id;
      SELECT * INTO p FROM goal_imported_validation_receipts WHERE validation_id=NEW.id;
      SELECT * INTO v FROM event_log WHERE id=NEW.ready_event_id;
      SELECT * INTO t FROM tasks WHERE id=NEW.task_id; SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE;
      IF c.validation_id IS NULL OR p.validation_id IS NULL OR v.id IS NULL OR t.id IS NULL OR g.id IS NULL OR NEW.stop_requested
        OR c.result_digest IS DISTINCT FROM NEW.result_digest OR p.result_digest IS DISTINCT FROM NEW.result_digest
        OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id
        OR (NEW.ready_kind='review' AND t.status='review' AND c.outcome='verified'
          OR NEW.ready_kind='repair' AND t.status IN ('blocked','ready') AND c.outcome='closed-failure') IS NOT TRUE
        OR EXISTS(SELECT 1 FROM goal_imported_validations WHERE root_validation_id=NEW.root_validation_id AND generation>NEW.generation)
        OR v.organization_id<>NEW.organization_id OR v.type<>'goal.imported-validation.ready' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
        OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.run_id IS DISTINCT FROM NEW.run_id
        OR v.payload->>'validation_id' IS DISTINCT FROM NEW.id OR v.payload->>'result_digest' IS DISTINCT FROM NEW.result_digest
        OR v.payload->>'source_digest' IS DISTINCT FROM c.source_digest OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id
        OR v.payload->>'ready_kind' IS DISTINCT FROM NEW.ready_kind OR v.payload->>'verification_evidence_id' IS DISTINCT FROM c.evidence_id
        OR v.payload->'publication_authorized' IS DISTINCT FROM 'false'::jsonb
        THEN RAISE EXCEPTION 'H7 readiness requires current original completion, receipt and goal'; END IF;
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
    OR h.consent_id IS DISTINCT FROM NEW.consent_id OR h.policy_version<>NEW.policy_version OR h.session_bindings IS DISTINCT FROM NEW.session_bindings
    OR hp.organization_id<>NEW.organization_id OR hp.request_digest<>h.request_digest OR hp.result_digest IS DISTINCT FROM h.result_digest
    OR hp.delivery_id IS DISTINCT FROM h.result_delivery_id OR hp.session_id IS DISTINCT FROM h.result_session_id OR hp.session_bindings IS DISTINCT FROM NEW.session_bindings
    OR NEW.request->'origin' IS DISTINCT FROM jsonb_build_object('version',1,'review_id',h.id,'request_digest',h.request_digest,'result_digest',h.result_digest,
      'acceptance_event_id',h.acceptance_event_id,'execution_request',h.request->'execution_request','implementation_source',h.request->'source')
    OR hv.organization_id<>NEW.organization_id OR hv.type<>'goal.imported-execution-review.accepted' OR hv.actor_type<>'system' OR hv.actor_id<>'goal_runner'
    OR hv.goal_id IS DISTINCT FROM NEW.goal_id OR hv.task_id IS DISTINCT FROM h.task_id OR hv.run_id IS DISTINCT FROM h.request->'source'->'run_start'->>'run_id'
    OR hv.payload->>'review_id' IS DISTINCT FROM h.id OR hv.payload->>'result_digest' IS DISTINCT FROM h.result_digest
    OR hv.payload->>'source_digest' IS DISTINCT FROM h.source_digest OR hv.payload->>'actor_user_id' IS DISTINCT FROM h.actor_user_id
    OR hv.payload->'subsequent_stage_authorized' IS DISTINCT FROM 'false'::jsonb
    OR EXISTS(SELECT 1 FROM product_releases WHERE organization_id=NEW.organization_id AND goal_id=NEW.goal_id)
    OR g.organization_id<>NEW.organization_id OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id OR g.retry_count<>NEW.attempt_index
    OR ((g.budgets->>'max_retries')::integer IS NOT NULL AND NEW.attempt_index>(g.budgets->>'max_retries')::integer)
    OR v.organization_id<>NEW.organization_id OR v.type<>'goal.imported-validation.authorized' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
    OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.run_id IS DISTINCT FROM NEW.run_id
    OR v.payload->>'validation_id' IS DISTINCT FROM NEW.id OR v.payload->>'root_validation_id' IS DISTINCT FROM NEW.root_validation_id
    OR (v.payload->>'generation')::integer IS DISTINCT FROM NEW.generation OR v.payload->>'kind' IS DISTINCT FROM NEW.kind
    OR v.payload->>'origin_review_id' IS DISTINCT FROM h.id OR v.payload->>'source_digest' IS DISTINCT FROM NEW.initial_source_digest
    OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id OR (v.payload->>'attempt_index')::integer IS DISTINCT FROM NEW.attempt_index
    OR (v.payload->>'previous_retry_count')::integer IS DISTINCT FROM NEW.attempt_index-(CASE WHEN NEW.kind='repair' THEN 1 ELSE 0 END)
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
    THEN RAISE EXCEPTION 'H7 author differs from original accepted H6, goal authorization or real writer assignment'; END IF;
  IF NEW.kind='initial' THEN
    source:=imported_implementation_source(h.base_execution_id,h.source_kind,h.source_operation_id);
    IF source IS DISTINCT FROM h.request->'source' OR NEW.request ? 'predecessor' OR v.payload->'predecessor' IS DISTINCT FROM 'null'::jsonb
      THEN RAISE EXCEPTION 'Initial H7 author must claim its original accepted implementation once'; END IF;
  ELSE
    SELECT * INTO parent FROM goal_imported_validations WHERE id=NEW.parent_validation_id;
    source:=imported_validation_source(parent.id);
    IF parent.id IS NULL OR parent.root_validation_id<>NEW.root_validation_id OR parent.generation+1<>NEW.generation
      OR parent.origin_review_id<>NEW.origin_review_id OR parent.organization_id<>NEW.organization_id OR parent.goal_id<>NEW.goal_id OR parent.plan_id<>NEW.plan_id
      OR parent.task_id<>NEW.task_id OR parent.writer_instance_id<>NEW.writer_instance_id OR parent.writer_agent_id<>NEW.writer_agent_id
      OR parent.attempt_index>=NEW.attempt_index OR parent.request->'origin' IS DISTINCT FROM NEW.request->'origin'
      THEN RAISE EXCEPTION 'H7 repair changed its current original author lineage'; END IF;
    IF NEW.predecessor_kind='review' THEN
      SELECT * INTO review FROM goal_imported_validation_reviews WHERE id=NEW.predecessor_id;
      SELECT * INTO rp FROM goal_imported_validation_review_receipts WHERE review_id=review.id;
      IF review.id IS NULL OR rp.review_id IS NULL OR review.validation_id<>parent.id OR review.stop_requested OR review.accepted_at IS NOT NULL
        OR review.source_digest IS DISTINCT FROM (SELECT source_digest FROM goal_imported_validation_completions WHERE validation_id=parent.id)
        OR (review.result->>'outcome'='reviewed' AND review.result->'closed'='true'::jsonb AND review.result->'verdict'->>'outcome'='rejected') IS NOT TRUE
        OR rp.result_digest IS DISTINCT FROM review.result_digest OR rp.request_digest<>review.request_digest
        OR EXISTS(SELECT 1 FROM goal_imported_validation_reviews WHERE validation_id=parent.id AND sequence>review.sequence)
        OR parent.ready_kind<>'review' OR source->>'outcome' IS DISTINCT FROM 'verified'
        THEN RAISE EXCEPTION 'H7 repair requires the current original rejected final-product review'; END IF;
      expected_predecessor:=jsonb_build_object('kind','review','review',jsonb_build_object('review_id',review.id,'request_digest',review.request_digest,'result_digest',review.result_digest));
    ELSE
      IF NEW.predecessor_id<>parent.id OR parent.ready_kind<>'repair' OR source->>'outcome' IS DISTINCT FROM 'closed-failure'
        THEN RAISE EXCEPTION 'H7 repair requires an original typed closed failure'; END IF;
      expected_predecessor:=jsonb_build_object('kind','failure','validation',jsonb_build_object('validation_id',parent.id,'request_digest',parent.request_digest,'result_digest',parent.result_digest));
    END IF;
    IF NEW.request->'predecessor' IS DISTINCT FROM expected_predecessor OR v.payload->'predecessor' IS DISTINCT FROM expected_predecessor
      THEN RAISE EXCEPTION 'H7 repair authorization changed its consumed predecessor'; END IF;
  END IF;
  IF NEW.request->'source' IS DISTINCT FROM source THEN RAISE EXCEPTION 'H7 author changed its exact initial source'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_validations_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_validations FOR EACH ROW EXECUTE FUNCTION protect_imported_validation();
--> statement-breakpoint
CREATE FUNCTION protect_imported_validation_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x goal_imported_validations; c goal_imported_validation_completions; previous goal_imported_validation_reviews;
  p goal_imported_validation_review_receipts; d goal_imported_validation_review_deliveries;
  g goals; t tasks; a agent_instances; v event_log; source jsonb; retry jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'H7 review history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','accepted_at','acceptance_event_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','accepted_at','acceptance_event_id'])
      OR OLD.stop_requested AND NOT NEW.stop_requested
      OR OLD.result IS NOT NULL AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.result_digest IS DISTINCT FROM OLD.result_digest
        OR NEW.result_delivery_id IS DISTINCT FROM OLD.result_delivery_id OR NEW.result_session_id IS DISTINCT FROM OLD.result_session_id)
      OR OLD.accepted_at IS NOT NULL AND (NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NEW.acceptance_event_id IS DISTINCT FROM OLD.acceptance_event_id)
      THEN RAISE EXCEPTION 'H7 reviewer identity, result and acceptance are immutable'; END IF;
    IF OLD.result IS NULL AND NEW.result IS NOT NULL THEN
      SELECT * INTO d FROM goal_imported_validation_review_deliveries WHERE id=NEW.result_delivery_id;
      IF d.id IS NULL OR d.review_id<>NEW.id OR d.session_id<>NEW.result_session_id THEN RAISE EXCEPTION 'H7 review result lacks issuing delivery'; END IF;
      IF NEW.result->>'outcome' IN ('reviewed','failed') AND (NEW.result_session_id IS DISTINCT FROM NEW.session_bindings->'destination'->>'sessionId'
        OR NOT EXISTS(SELECT 1 FROM goal_imported_validation_review_deliveries WHERE review_id=NEW.id AND session_id=NEW.result_session_id AND control='start'))
        THEN RAISE EXCEPTION 'H7 closed review requires original session and start'; END IF;
    END IF;
    IF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN
      SELECT * INTO x FROM goal_imported_validations WHERE id=NEW.validation_id;
      SELECT * INTO c FROM goal_imported_validation_completions WHERE validation_id=x.id;
      SELECT * INTO p FROM goal_imported_validation_review_receipts WHERE review_id=NEW.id;
      SELECT * INTO v FROM event_log WHERE id=NEW.acceptance_event_id;
      SELECT * INTO t FROM tasks WHERE id=NEW.task_id; SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE;
      source:=imported_validation_source(x.id);
      IF x.id IS NULL OR c.validation_id IS NULL OR p.review_id IS NULL OR v.id IS NULL OR t.id IS NULL OR g.id IS NULL OR NEW.stop_requested
        OR x.ready_kind<>'review' OR c.outcome<>'verified' OR c.evidence_id IS NULL OR source IS DISTINCT FROM NEW.request->'source'
        OR p.result_digest IS DISTINCT FROM NEW.result_digest OR c.source_digest<>NEW.source_digest
        OR EXISTS(SELECT 1 FROM goal_imported_validation_reviews WHERE validation_id=x.id AND sequence>NEW.sequence)
        OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id OR t.status<>'done'
        OR v.organization_id<>NEW.organization_id OR v.type<>'goal.imported-validation-review.accepted' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
        OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.run_id IS DISTINCT FROM x.run_id
        OR v.payload->>'review_id' IS DISTINCT FROM NEW.id OR v.payload->>'validation_id' IS DISTINCT FROM x.id
        OR v.payload->>'result_digest' IS DISTINCT FROM NEW.result_digest OR v.payload->>'source_digest' IS DISTINCT FROM NEW.source_digest
        OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id OR v.payload->>'subject_digest' IS DISTINCT FROM source->>'subject_digest'
        OR v.payload->>'verification_evidence_id' IS DISTINCT FROM c.evidence_id OR v.payload->'publication_authorized' IS DISTINCT FROM 'false'::jsonb
        THEN RAISE EXCEPTION 'H7 acceptance lacks the current complete product, original receipt and goal'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO x FROM goal_imported_validations WHERE id=NEW.validation_id;
  SELECT * INTO c FROM goal_imported_validation_completions WHERE validation_id=x.id;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE; SELECT * INTO t FROM tasks WHERE id=NEW.task_id;
  SELECT * INTO a FROM agent_instances WHERE id=NEW.reviewer_instance_id; SELECT * INTO v FROM event_log WHERE id=NEW.authorization_event_id;
  source:=imported_validation_source(x.id);
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
    OR v.organization_id<>NEW.organization_id OR v.type<>'goal.imported-validation-review.authorized' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
    OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.run_id IS DISTINCT FROM x.run_id
    OR v.payload->>'review_id' IS DISTINCT FROM NEW.id OR v.payload->>'validation_id' IS DISTINCT FROM x.id
    OR v.payload->>'source_digest' IS DISTINCT FROM NEW.source_digest OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id
    OR (v.payload->>'attempt_index')::integer IS DISTINCT FROM NEW.attempt_index
    OR (v.payload->>'previous_retry_count')::integer IS DISTINCT FROM NEW.attempt_index-(CASE WHEN NEW.retry_of IS NULL THEN 0 ELSE 1 END)
    OR v.payload->'execution_authorized' IS DISTINCT FROM 'false'::jsonb
    OR NEW.result IS NOT NULL OR NEW.accepted_at IS NOT NULL OR NEW.stop_requested
    OR EXISTS(SELECT 1 FROM product_releases WHERE organization_id=NEW.organization_id AND goal_id=NEW.goal_id)
    THEN RAISE EXCEPTION 'H7 review differs from its current verified product, independent reviewer or original goal authorization'; END IF;
  IF NEW.retry_of IS NULL THEN
    IF NEW.request ? 'retry_of' OR v.payload->'retry_of' IS DISTINCT FROM 'null'::jsonb
      THEN RAISE EXCEPTION 'Initial H7 review cannot borrow retry authority'; END IF;
  ELSE
    SELECT * INTO previous FROM goal_imported_validation_reviews WHERE id=NEW.retry_of;
    SELECT * INTO p FROM goal_imported_validation_review_receipts WHERE review_id=NEW.retry_of;
    retry:=jsonb_build_object('review_id',previous.id,'request_digest',previous.request_digest,'result_digest',previous.result_digest);
    IF previous.id IS NULL OR p.review_id IS NULL OR previous.validation_id<>x.id OR previous.sequence+1<>NEW.sequence OR previous.attempt_index>=NEW.attempt_index
      OR previous.stop_requested OR previous.accepted_at IS NOT NULL OR (previous.result->>'outcome'='failed' AND previous.result->'closed'='true'::jsonb) IS NOT TRUE
      OR previous.reviewer_instance_id<>NEW.reviewer_instance_id OR previous.reviewer_agent_id<>NEW.reviewer_agent_id
      OR previous.source_digest<>NEW.source_digest OR p.result_digest IS DISTINCT FROM previous.result_digest OR p.request_digest<>previous.request_digest
      OR EXISTS(SELECT 1 FROM goal_imported_validation_reviews WHERE validation_id=x.id AND sequence>previous.sequence)
      OR NEW.request->'retry_of' IS DISTINCT FROM retry OR v.payload->'retry_of' IS DISTINCT FROM retry
      THEN RAISE EXCEPTION 'H7 review retry requires the exact latest closed failure and original retry budget'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_validation_reviews_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_validation_reviews FOR EACH ROW EXECUTE FUNCTION protect_imported_validation_review();
--> statement-breakpoint
CREATE FUNCTION protect_imported_validation_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x goal_imported_validations; h goal_imported_validation_reviews; c goal_imported_validation_completions;
  p goal_imported_validation_review_receipts; rel product_releases; r runs; e run_evidence; v event_log; g goals; plan plans;
  source jsonb; caps jsonb; summary jsonb; criteria jsonb; expected_origin jsonb; expected_binding jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'H7 publication origin is immutable'; END IF;
  SELECT * INTO x FROM goal_imported_validations WHERE id=NEW.validation_id;
  SELECT * INTO h FROM goal_imported_validation_reviews WHERE id=NEW.review_id;
  SELECT * INTO c FROM goal_imported_validation_completions WHERE validation_id=x.id;
  SELECT * INTO p FROM goal_imported_validation_review_receipts WHERE review_id=h.id;
  SELECT * INTO rel FROM product_releases WHERE id=NEW.release_id; SELECT * INTO r FROM runs WHERE id=NEW.run_id;
  SELECT * INTO e FROM run_evidence WHERE id=NEW.evidence_id; SELECT * INTO v FROM event_log WHERE id=NEW.acceptance_event_id;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE; SELECT * INTO plan FROM plans WHERE id=NEW.plan_id;
  source:=imported_validation_source(x.id);
  caps:=x.request->'origin'->'execution_request'->'review_request'->'continuation_request'->'review_request'->'operation'->'intent'->'request'->'measurement_v2'->'destination_release';
  summary:=e.payload->'measurement_plan';
  expected_origin:=jsonb_build_object('version',1,'validation_id',x.id,'request_digest',x.request_digest,'result_digest',x.result_digest,
    'review_id',h.id,'review_request_digest',h.request_digest,'review_result_digest',h.result_digest,'acceptance_event_id',h.acceptance_event_id,'subject_digest',source->>'subject_digest');
  IF x.id IS NULL OR h.id IS NULL OR c.validation_id IS NULL OR p.review_id IS NULL OR rel.id IS NULL OR r.id IS NULL OR e.id IS NULL OR v.id IS NULL OR g.id IS NULL OR plan.id IS NULL
    OR x.organization_id<>NEW.organization_id OR x.goal_id<>NEW.goal_id OR x.plan_id<>NEW.plan_id OR x.origin_review_id<>NEW.origin_review_id
    OR x.run_id<>NEW.run_id OR x.computer_id<>NEW.computer_id OR x.ready_kind<>'review' OR c.outcome<>'verified' OR c.evidence_id IS DISTINCT FROM NEW.evidence_id
    OR c.source_digest<>NEW.source_digest OR h.validation_id<>x.id OR h.source_digest<>NEW.source_digest OR h.request->'source' IS DISTINCT FROM source
    OR h.organization_id<>NEW.organization_id OR h.goal_id<>NEW.goal_id OR h.plan_id<>NEW.plan_id OR h.task_id<>x.task_id
    OR h.stop_requested OR h.accepted_at IS NULL OR h.acceptance_event_id IS DISTINCT FROM NEW.acceptance_event_id
    OR (h.result->>'outcome'='reviewed' AND h.result->'closed'='true'::jsonb AND h.result->'verdict'->>'outcome'='accepted') IS NOT TRUE
    OR h.author_instance_id<>x.writer_instance_id OR h.author_agent_id<>x.writer_agent_id
    OR p.result_digest IS DISTINCT FROM h.result_digest OR p.request_digest<>h.request_digest
    OR EXISTS(SELECT 1 FROM goal_imported_validation_reviews WHERE validation_id=x.id AND sequence>h.sequence)
    OR r.organization_id<>NEW.organization_id OR r.status<>'completed' OR r.computer_id<>NEW.computer_id OR r.workspace_root IS DISTINCT FROM x.workspace_root
    OR e.organization_id<>NEW.organization_id OR e.run_id<>r.id OR e.payload IS DISTINCT FROM source->'verification' OR e.payload->>'outcome' IS DISTINCT FROM 'passed'
    OR e.payload->>'subject_digest' IS DISTINCT FROM source->>'subject_digest'
    OR v.organization_id<>NEW.organization_id OR v.type<>'goal.imported-validation-review.accepted' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
    OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM x.task_id OR v.run_id IS DISTINCT FROM r.id
    OR v.payload->>'review_id' IS DISTINCT FROM h.id OR v.payload->>'validation_id' IS DISTINCT FROM x.id
    OR v.payload->>'result_digest' IS DISTINCT FROM h.result_digest OR v.payload->>'source_digest' IS DISTINCT FROM NEW.source_digest
    OR v.payload->>'subject_digest' IS DISTINCT FROM source->>'subject_digest' OR v.payload->>'verification_evidence_id' IS DISTINCT FROM e.id
    OR v.payload->>'actor_user_id' IS DISTINCT FROM x.actor_user_id OR v.payload->'publication_authorized' IS DISTINCT FROM 'false'::jsonb
    OR g.organization_id<>NEW.organization_id OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id
    OR plan.organization_id<>NEW.organization_id OR plan.goal_id<>NEW.goal_id
    OR EXISTS(SELECT 1 FROM tasks WHERE organization_id=NEW.organization_id AND goal_id=NEW.goal_id AND source_plan_id=NEW.plan_id AND status<>'done')
    OR rel.organization_id<>NEW.organization_id OR rel.goal_id<>NEW.goal_id OR rel.run_id<>NEW.run_id OR rel.evidence_id<>NEW.evidence_id OR rel.computer_id<>NEW.computer_id OR rel.status<>'queued'
    OR NEW.origin IS DISTINCT FROM expected_origin OR rel.request->'imported_validation' IS DISTINCT FROM expected_origin
    OR caps IS NULL OR NEW.capabilities IS DISTINCT FROM caps OR r.verification_requirement->>'profile_id' IS DISTINCT FROM caps->'binding'->>'verification_profile_id'
    OR caps->'binding'->>'workspace_root' IS DISTINCT FROM x.workspace_root OR caps->'binding'->>'project_id' IS DISTINCT FROM rel.project_id
    OR x.request->'run_start'->'context_pack'->'payload'->'release_capabilities' IS DISTINCT FROM caps
    OR (summary->'version'='2'::jsonb AND summary->>'scope'='final' AND jsonb_typeof(summary->'pending_release')='array' AND jsonb_array_length(summary->'pending_release')>0) IS NOT TRUE
    OR rel.request->>'release_id' IS DISTINCT FROM NEW.release_id OR rel.request->>'goal_id' IS DISTINCT FROM NEW.goal_id OR rel.request->>'project_id' IS DISTINCT FROM rel.project_id
    OR rel.request->>'run_id' IS DISTINCT FROM r.id OR rel.request->>'subject_digest' IS DISTINCT FROM source->>'subject_digest'
    OR rel.request->>'verification_request_id' IS DISTINCT FROM e.request_id OR rel.request->>'verification_profile_id' IS DISTINCT FROM e.payload->>'profile_id'
    OR rel.request->>'verification_profile_digest' IS DISTINCT FROM e.payload->>'profile_digest' OR rel.request->>'release_profile_id' IS DISTINCT FROM caps->'binding'->>'release_profile_id'
    THEN RAISE EXCEPTION 'H7 publication differs from current accepted final product and original destination'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(summary->'pending_release') item WHERE item->'release_binding' IS DISTINCT FROM caps->'binding')
    THEN RAISE EXCEPTION 'H7 publication changed its destination release obligations'; END IF;
  SELECT jsonb_agg(jsonb_build_object('requirement_id',item->'requirement_id','criterion_index',item->'criterion_index',
    'criterion_digest',item->'criterion_digest','claim_id',item->'claim_id') ORDER BY ordinal)
    INTO criteria FROM jsonb_array_elements(summary->'pending_release') WITH ORDINALITY AS entries(item,ordinal);
  expected_binding:=jsonb_build_object('version',1,'plan',jsonb_build_object('id',plan.id,'version',plan.version),'research',summary->'research',
    'measurement_plan_digest',summary->'measurement_plan_digest','release_binding',caps->'binding','criteria',criteria);
  IF rel.request->'acceptance_binding' IS DISTINCT FROM expected_binding
    THEN RAISE EXCEPTION 'H7 publication changed its exact accepted research and measurement obligations'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_validation_publications_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_validation_publications FOR EACH ROW EXECUTE FUNCTION protect_imported_validation_publication();
