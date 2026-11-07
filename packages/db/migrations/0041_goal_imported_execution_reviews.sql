-- H6: independent review and one-use repair; no H7 or release admission.
CREATE TABLE goal_imported_execution_receipts (
  execution_id text PRIMARY KEY REFERENCES goal_imported_executions(id), organization_id text NOT NULL REFERENCES organizations(id),
  delivery_id text NOT NULL REFERENCES goal_imported_execution_deliveries(id), session_id text NOT NULL, session_bindings jsonb NOT NULL,
  request_digest text NOT NULL, result_digest text NOT NULL, sent_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_execution_receipts_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND result_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_imported_execution_reviews (
  id text PRIMARY KEY, base_execution_id text NOT NULL REFERENCES goal_imported_execution_completions(execution_id),
  source_kind text NOT NULL, source_operation_id text NOT NULL, source_digest text NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id), task_id text NOT NULL REFERENCES tasks(id),
  author_instance_id text NOT NULL REFERENCES agent_instances(id), author_agent_id text NOT NULL REFERENCES agents(id),
  reviewer_instance_id text NOT NULL REFERENCES agent_instances(id), reviewer_agent_id text NOT NULL REFERENCES agents(id),
  computer_id text NOT NULL REFERENCES computers(id), workspace_root text NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL,
  session_bindings jsonb NOT NULL, request_digest text NOT NULL, request jsonb NOT NULL,
  result jsonb, result_digest text, result_delivery_id text, result_session_id text,
  stop_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL, accepted_at timestamptz, acceptance_event_id text REFERENCES event_log(id),
  CONSTRAINT goal_imported_execution_reviews_source_uniq UNIQUE(base_execution_id,source_kind,source_operation_id),
  CONSTRAINT goal_imported_execution_reviews_source_chk CHECK(source_kind IN ('execution','repair') AND source_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT goal_imported_execution_reviews_independent_chk CHECK(author_instance_id<>reviewer_instance_id AND author_agent_id<>reviewer_agent_id),
  CONSTRAINT goal_imported_execution_reviews_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND (result_digest IS NULL OR result_digest ~ '^sha256:[a-f0-9]{64}$')),
  CONSTRAINT goal_imported_execution_reviews_result_chk CHECK((result IS NULL AND result_digest IS NULL AND result_delivery_id IS NULL AND result_session_id IS NULL)
    OR (result IS NOT NULL AND result_digest IS NOT NULL AND result_delivery_id IS NOT NULL AND result_session_id IS NOT NULL
      AND result->'version'='1'::jsonb AND result->>'review_id'=id AND result->>'request_digest'=request_digest
      AND result->'execution_authorized'='false'::jsonb AND result->>'outcome' IN ('reviewed','failed','uncertain','cancelled_before_start')
      AND result->'closed'=to_jsonb(result->>'outcome'<>'uncertain')) IS TRUE),
  CONSTRAINT goal_imported_execution_reviews_acceptance_chk CHECK((accepted_at IS NULL AND acceptance_event_id IS NULL)
    OR (accepted_at IS NOT NULL AND acceptance_event_id IS NOT NULL AND result->>'outcome'='reviewed' AND result->'verdict'->>'outcome'='accepted') IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_imported_execution_review_deliveries (
  id text PRIMARY KEY, review_id text NOT NULL REFERENCES goal_imported_execution_reviews(id), session_id text NOT NULL,
  control text NOT NULL, ack jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_execution_review_delivery_session_uniq UNIQUE(review_id,session_id,control),
  CONSTRAINT goal_imported_execution_review_delivery_control_chk CHECK(control IN ('start','stop','status'))
);
--> statement-breakpoint
ALTER TABLE goal_imported_execution_reviews ADD CONSTRAINT goal_imported_execution_reviews_delivery_fk FOREIGN KEY(result_delivery_id) REFERENCES goal_imported_execution_review_deliveries(id);
--> statement-breakpoint
CREATE TABLE goal_imported_execution_review_receipts (
  review_id text PRIMARY KEY REFERENCES goal_imported_execution_reviews(id), organization_id text NOT NULL REFERENCES organizations(id),
  delivery_id text NOT NULL REFERENCES goal_imported_execution_review_deliveries(id), session_id text NOT NULL, session_bindings jsonb NOT NULL,
  request_digest text NOT NULL, result_digest text NOT NULL, sent_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_execution_review_receipts_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND result_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_imported_execution_repairs (
  id text PRIMARY KEY, review_id text NOT NULL REFERENCES goal_imported_execution_review_receipts(review_id),
  organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id),
  task_id text NOT NULL REFERENCES tasks(id), run_id text NOT NULL REFERENCES runs(id), context_pack_id text NOT NULL REFERENCES context_packs(id),
  writer_instance_id text NOT NULL REFERENCES agent_instances(id), writer_agent_id text NOT NULL REFERENCES agents(id), computer_id text NOT NULL REFERENCES computers(id),
  workspace_root text NOT NULL, actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL,
  authorization_event_id text NOT NULL REFERENCES event_log(id), base_execution_id text NOT NULL REFERENCES goal_imported_executions(id), attempt_index integer NOT NULL, session_bindings jsonb NOT NULL,
  request_digest text NOT NULL, request jsonb NOT NULL, result jsonb, result_digest text, result_delivery_id text, result_session_id text,
  stop_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL, review_ready_at timestamptz, review_ready_event_id text REFERENCES event_log(id),
  CONSTRAINT goal_imported_execution_repairs_review_uniq UNIQUE(review_id), CONSTRAINT goal_imported_execution_repairs_attempt_uniq UNIQUE(goal_id,attempt_index), CONSTRAINT goal_imported_execution_repairs_run_uniq UNIQUE(run_id),
  CONSTRAINT goal_imported_execution_repairs_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND (result_digest IS NULL OR result_digest ~ '^sha256:[a-f0-9]{64}$')),
  CONSTRAINT goal_imported_execution_repairs_request_chk CHECK((request->'version'='1'::jsonb AND request->>'repair_id'=id
    AND request->'run_start'->>'run_id'=run_id AND request->'run_start'->>'task_id'=task_id AND request->'authorization'->>'event_id'=authorization_event_id
    AND request->'execution_request'->>'execution_id'=base_execution_id AND attempt_index>0 AND (request->'authorization'->>'attempt_index')::integer=attempt_index AND request->'authorization'->>'goal_id'=goal_id AND request->'run_start'->'context_pack'->>'id'=context_pack_id
    AND request->'run_start'->>'agent_instance_id'=writer_instance_id AND request->'run_start'->'workspace'->>'root'=workspace_root) IS TRUE),
  CONSTRAINT goal_imported_execution_repairs_result_chk CHECK((result IS NULL AND result_digest IS NULL AND result_delivery_id IS NULL AND result_session_id IS NULL)
    OR (result IS NOT NULL AND result_digest IS NOT NULL AND result_delivery_id IS NOT NULL AND result_session_id IS NOT NULL AND result->'version'='1'::jsonb
      AND result->>'repair_id'=id AND result->>'request_digest'=request_digest AND result->>'run_id'=run_id
      AND result->>'outcome' IN ('finished','failed','uncertain','cancelled_before_start') AND result->'closed'=to_jsonb(result->>'outcome'<>'uncertain')) IS TRUE),
  CONSTRAINT goal_imported_execution_repairs_ready_chk CHECK((review_ready_at IS NULL AND review_ready_event_id IS NULL)
    OR (review_ready_at IS NOT NULL AND review_ready_event_id IS NOT NULL AND result->>'outcome'='finished' AND result->'verified_repair'->'verification'->>'outcome'='passed') IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_imported_execution_repair_deliveries (
  id text PRIMARY KEY, repair_id text NOT NULL REFERENCES goal_imported_execution_repairs(id), session_id text NOT NULL,
  control text NOT NULL, ack jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_execution_repair_delivery_session_uniq UNIQUE(repair_id,session_id,control),
  CONSTRAINT goal_imported_execution_repair_delivery_control_chk CHECK(control IN ('start','stop','status'))
);
--> statement-breakpoint
ALTER TABLE goal_imported_execution_repairs ADD CONSTRAINT goal_imported_execution_repairs_delivery_fk FOREIGN KEY(result_delivery_id) REFERENCES goal_imported_execution_repair_deliveries(id);
--> statement-breakpoint
CREATE TABLE goal_imported_execution_repair_completions (
  repair_id text PRIMARY KEY REFERENCES goal_imported_execution_repairs(id), organization_id text NOT NULL REFERENCES organizations(id),
  run_id text NOT NULL REFERENCES runs(id), evidence_id text NOT NULL REFERENCES run_evidence(id), context_pack_id text NOT NULL REFERENCES context_packs(id),
  delivery_id text NOT NULL REFERENCES goal_imported_execution_repair_deliveries(id), session_id text NOT NULL,
  result_digest text NOT NULL, completed_repair_digest text NOT NULL, verified_repair jsonb NOT NULL, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_execution_repair_completion_digest_chk CHECK(result_digest ~ '^sha256:[a-f0-9]{64}$' AND completed_repair_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_imported_execution_repair_receipts (
  repair_id text PRIMARY KEY REFERENCES goal_imported_execution_repairs(id), organization_id text NOT NULL REFERENCES organizations(id),
  delivery_id text NOT NULL REFERENCES goal_imported_execution_repair_deliveries(id), session_id text NOT NULL, session_bindings jsonb NOT NULL,
  request_digest text NOT NULL, result_digest text NOT NULL, sent_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_execution_repair_receipts_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND result_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE FUNCTION protect_goal_imported_execution_repair_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x goal_imported_execution_repairs; r runs; e run_evidence; p context_packs; d goal_imported_execution_repair_deliveries; v event_log;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'H6 repair completion provenance is immutable'; END IF;
  SELECT * INTO x FROM goal_imported_execution_repairs WHERE id=NEW.repair_id;
  SELECT * INTO r FROM runs WHERE id=NEW.run_id; SELECT * INTO e FROM run_evidence WHERE id=NEW.evidence_id;
  SELECT * INTO p FROM context_packs WHERE id=NEW.context_pack_id; SELECT * INTO d FROM goal_imported_execution_repair_deliveries WHERE id=NEW.delivery_id;
  SELECT * INTO v FROM event_log WHERE id=e.event_id;
  IF x.id IS NULL OR r.id IS NULL OR e.id IS NULL OR p.id IS NULL OR d.id IS NULL OR v.id IS NULL
    OR x.organization_id<>NEW.organization_id OR x.run_id<>r.id OR x.context_pack_id<>p.id OR x.result->'verified_repair' IS DISTINCT FROM NEW.verified_repair
    OR (x.result->>'outcome'='finished' AND x.result->'closed'='true'::jsonb) IS NOT TRUE OR x.result_digest IS DISTINCT FROM NEW.result_digest
    OR r.organization_id<>NEW.organization_id OR r.status<>'completed' OR r.task_id<>x.task_id OR r.context_pack_id IS DISTINCT FROM p.id
    OR r.agent_instance_id<>x.writer_instance_id OR r.computer_id<>x.computer_id
    OR e.organization_id<>NEW.organization_id OR e.run_id<>r.id OR e.payload IS DISTINCT FROM NEW.verified_repair->'verification'
    OR e.request_id IS DISTINCT FROM r.verification_requirement->>'request_id' OR e.payload->>'outcome' IS DISTINCT FROM 'passed'
    OR p.organization_id<>NEW.organization_id OR p.task_id<>x.task_id OR p.run_id IS DISTINCT FROM r.id OR p.payload IS DISTINCT FROM x.request->'run_start'->'context_pack'->'payload'
    OR d.repair_id<>x.id OR d.session_id<>NEW.session_id OR x.result_delivery_id IS DISTINCT FROM d.id OR x.result_session_id IS DISTINCT FROM NEW.session_id
    OR NOT EXISTS(SELECT 1 FROM goal_imported_execution_repair_deliveries WHERE repair_id=x.id AND session_id=NEW.session_id AND control='start')
    OR v.organization_id<>NEW.organization_id OR v.type<>'run.verification' OR v.run_id IS DISTINCT FROM r.id OR v.task_id IS DISTINCT FROM x.task_id
    OR v.actor_type<>'system' OR v.actor_id<>x.computer_id OR v.payload IS DISTINCT FROM e.payload
    OR (NEW.verified_repair->>'repair_id'=x.id AND NEW.verified_repair->>'stage'='implementation' AND NEW.verified_repair->>'request_digest'=x.request_digest
      AND NEW.verified_repair->>'run_id'=r.id AND NEW.verified_repair->>'authorization_event_id'=x.authorization_event_id
      AND NEW.verified_repair->'author'->>'instance_id'=x.writer_instance_id AND NEW.verified_repair->'author'->>'agent_id'=x.writer_agent_id) IS NOT TRUE
    THEN RAISE EXCEPTION 'H6 repair completion lacks original committed node/run/evidence/delivery'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_execution_repair_completions_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_execution_repair_completions
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_execution_repair_completion();

--> statement-breakpoint
-- Send completion is not remote possession; the node retains its own receipt boundary.
CREATE FUNCTION protect_imported_implementation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x jsonb; d jsonb; op text; fk text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'implementation receipt history is immutable'; END IF;
  IF TG_TABLE_NAME='goal_imported_execution_receipts' THEN
    op:=NEW.execution_id; fk:='execution_id';
    SELECT to_jsonb(r) INTO x FROM goal_imported_executions r WHERE id=op;
    SELECT to_jsonb(r) INTO d FROM goal_imported_execution_deliveries r WHERE id=NEW.delivery_id;
    IF NOT EXISTS(SELECT 1 FROM goal_imported_execution_completions WHERE execution_id=op AND result_digest=NEW.result_digest)
      THEN RAISE EXCEPTION 'execution receipt requires committed verified completion'; END IF;
  ELSIF TG_TABLE_NAME='goal_imported_execution_repair_receipts' THEN
    op:=NEW.repair_id; fk:='repair_id';
    SELECT to_jsonb(r) INTO x FROM goal_imported_execution_repairs r WHERE id=op;
    SELECT to_jsonb(r) INTO d FROM goal_imported_execution_repair_deliveries r WHERE id=NEW.delivery_id;
    IF NOT EXISTS(SELECT 1 FROM goal_imported_execution_repair_completions WHERE repair_id=op AND result_digest=NEW.result_digest)
      THEN RAISE EXCEPTION 'repair receipt requires committed verified completion'; END IF;
  ELSE
    op:=NEW.review_id; fk:='review_id';
    SELECT to_jsonb(r) INTO x FROM goal_imported_execution_reviews r WHERE id=op;
    SELECT to_jsonb(r) INTO d FROM goal_imported_execution_review_deliveries r WHERE id=NEW.delivery_id;
    IF (x->'result'->>'outcome'='reviewed' AND x->'result'->'closed'='true'::jsonb
      AND x->'result'->'verdict'->>'outcome' IN ('accepted','rejected')) IS NOT TRUE
      THEN RAISE EXCEPTION 'review receipt requires closed substantive review'; END IF;
  END IF;
  IF x IS NULL OR d IS NULL OR x->>'organization_id' IS DISTINCT FROM NEW.organization_id OR d->>fk IS DISTINCT FROM op
    OR d->>'session_id' IS DISTINCT FROM NEW.session_id OR x->>'result_delivery_id' IS DISTINCT FROM NEW.delivery_id
    OR x->>'result_session_id' IS DISTINCT FROM NEW.session_id OR x->>'request_digest' IS DISTINCT FROM NEW.request_digest
    OR x->>'result_digest' IS DISTINCT FROM NEW.result_digest OR x->'session_bindings' IS DISTINCT FROM NEW.session_bindings
    OR x->'session_bindings'->'destination'->>'sessionId' IS DISTINCT FROM NEW.session_id
    THEN RAISE EXCEPTION 'implementation receipt differs from original result/session'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_execution_receipts_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_execution_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_imported_implementation_receipt();
--> statement-breakpoint
CREATE TRIGGER goal_imported_execution_review_receipts_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_execution_review_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_imported_implementation_receipt();
--> statement-breakpoint
CREATE TRIGGER goal_imported_execution_repair_receipts_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_execution_repair_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_imported_implementation_receipt();
--> statement-breakpoint
-- Fixed projection from immutable originals. No recursive review/repair embedding.
CREATE FUNCTION imported_implementation_source(base_id text, source_kind text, operation_id text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE x jsonb; v jsonb; p jsonb; b goal_imported_executions;
BEGIN
  SELECT * INTO b FROM goal_imported_executions WHERE id=base_id;
  IF b.id IS NULL OR b.stop_requested OR b.review_ready_at IS NULL THEN RAISE EXCEPTION 'source lacks current original H5'; END IF;
  IF source_kind='execution' AND operation_id=base_id THEN
    x:=to_jsonb(b);
    SELECT verified_execution INTO v FROM goal_imported_execution_completions WHERE execution_id=base_id;
    SELECT to_jsonb(r) INTO p FROM goal_imported_execution_receipts r WHERE execution_id=base_id;
    IF EXISTS(SELECT 1 FROM goal_imported_execution_repairs WHERE base_execution_id=base_id)
      THEN RAISE EXCEPTION 'original implementation source was superseded'; END IF;
  ELSIF source_kind='repair' THEN
    SELECT to_jsonb(r) INTO x FROM goal_imported_execution_repairs r WHERE id=operation_id AND base_execution_id=base_id;
    SELECT verified_repair INTO v FROM goal_imported_execution_repair_completions WHERE repair_id=operation_id;
    SELECT to_jsonb(r) INTO p FROM goal_imported_execution_repair_receipts r WHERE repair_id=operation_id;
    IF EXISTS(SELECT 1 FROM goal_imported_execution_repairs WHERE base_execution_id=base_id AND attempt_index>(x->>'attempt_index')::integer)
      THEN RAISE EXCEPTION 'repair source was superseded'; END IF;
  ELSE RAISE EXCEPTION 'unknown implementation source'; END IF;
  IF x IS NULL OR v IS NULL OR p IS NULL OR x->'stop_requested'<>'false'::jsonb OR x->>'review_ready_at' IS NULL
    OR x->>'organization_id' IS DISTINCT FROM b.organization_id OR x->>'goal_id' IS DISTINCT FROM b.goal_id
    OR x->>'plan_id' IS DISTINCT FROM b.plan_id OR x->>'task_id' IS DISTINCT FROM b.task_id
    OR x->>'computer_id' IS DISTINCT FROM b.computer_id OR x->>'workspace_root' IS DISTINCT FROM b.workspace_root
    OR x->>'actor_user_id' IS DISTINCT FROM b.actor_user_id OR x->>'consent_id' IS DISTINCT FROM b.consent_id OR x->>'policy_version' IS DISTINCT FROM b.policy_version
    OR x->'session_bindings' IS DISTINCT FROM b.session_bindings OR p->'session_bindings' IS DISTINCT FROM x->'session_bindings'
    OR p->>'result_digest' IS DISTINCT FROM x->>'result_digest' OR p->>'request_digest' IS DISTINCT FROM x->>'request_digest'
    OR p->>'session_id' IS DISTINCT FROM x->>'result_session_id' OR p->>'delivery_id' IS DISTINCT FROM x->>'result_delivery_id'
    OR NOT EXISTS(SELECT 1 FROM runs WHERE id=x->>'run_id' AND status='completed')
    THEN RAISE EXCEPTION 'source lacks exact current committed receipt/completion'; END IF;
  RETURN jsonb_build_object('version',1,'kind',source_kind,'operation_id',operation_id,'request_digest',x->'request_digest',
    'result_digest',x->'result_digest','author',jsonb_build_object('agent_id',x->'writer_agent_id','instance_id',x->'writer_instance_id'),
    'run_start',x->'request'->'run_start','subject_digest',v->'subject_digest','verification',v->'verification');
END $$;

--> statement-breakpoint
CREATE FUNCTION protect_goal_imported_execution_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b goal_imported_executions; g goals; t tasks; d goal_imported_execution_review_deliveries;
  p goal_imported_execution_review_receipts; v event_log; source jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'H6 review history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','accepted_at','acceptance_event_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','accepted_at','acceptance_event_id'])
      OR OLD.stop_requested AND NOT NEW.stop_requested
      OR OLD.result IS NOT NULL AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.result_digest IS DISTINCT FROM OLD.result_digest
        OR NEW.result_delivery_id IS DISTINCT FROM OLD.result_delivery_id OR NEW.result_session_id IS DISTINCT FROM OLD.result_session_id)
      OR OLD.accepted_at IS NOT NULL AND (NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NEW.acceptance_event_id IS DISTINCT FROM OLD.acceptance_event_id)
      THEN RAISE EXCEPTION 'H6 identity/result/acceptance is immutable'; END IF;
    IF OLD.result IS NULL AND NEW.result IS NOT NULL THEN
      SELECT * INTO d FROM goal_imported_execution_review_deliveries WHERE id=NEW.result_delivery_id;
      IF d.id IS NULL OR d.review_id<>NEW.id OR d.session_id<>NEW.result_session_id THEN RAISE EXCEPTION 'H6 result lacks issuing delivery'; END IF;
      IF NEW.result->>'outcome'='reviewed' AND (NEW.result_session_id IS DISTINCT FROM NEW.session_bindings->'destination'->>'sessionId'
        OR NOT EXISTS(SELECT 1 FROM goal_imported_execution_review_deliveries WHERE review_id=NEW.id AND session_id=NEW.result_session_id AND control='start'))
        THEN RAISE EXCEPTION 'H6 reviewed result requires original session/start'; END IF;
    END IF;
    IF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN
      SELECT * INTO p FROM goal_imported_execution_review_receipts WHERE review_id=NEW.id;
      SELECT * INTO v FROM event_log WHERE id=NEW.acceptance_event_id; SELECT * INTO t FROM tasks WHERE id=NEW.task_id;
      SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE;
      source:=imported_implementation_source(NEW.base_execution_id,NEW.source_kind,NEW.source_operation_id);
      IF p.review_id IS NULL OR v.id IS NULL OR t.id IS NULL OR g.id IS NULL OR NEW.stop_requested
        OR t.status<>'done' OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id
        OR source IS DISTINCT FROM NEW.request->'source' OR p.result_digest<>NEW.result_digest
        OR v.organization_id<>NEW.organization_id OR v.type<>'goal.imported-execution-review.accepted' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
        OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.run_id IS DISTINCT FROM source->'run_start'->>'run_id'
        OR v.payload->>'review_id' IS DISTINCT FROM NEW.id OR v.payload->>'result_digest' IS DISTINCT FROM NEW.result_digest
        OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id OR v.payload->>'source_digest' IS DISTINCT FROM NEW.source_digest
        OR v.payload->'subsequent_stage_authorized' IS DISTINCT FROM 'false'::jsonb
        THEN RAISE EXCEPTION 'H6 acceptance lacks current receipt/source/goal'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO b FROM goal_imported_executions WHERE id=NEW.base_execution_id;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE; SELECT * INTO t FROM tasks WHERE id=NEW.task_id;
  source:=imported_implementation_source(NEW.base_execution_id,NEW.source_kind,NEW.source_operation_id);
  IF b.id IS NULL OR g.id IS NULL OR t.id IS NULL OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id OR t.status<>'review'
    OR b.organization_id<>NEW.organization_id OR b.goal_id<>NEW.goal_id OR b.plan_id<>NEW.plan_id OR b.task_id<>NEW.task_id
    OR b.computer_id<>NEW.computer_id OR b.workspace_root<>NEW.workspace_root OR b.actor_user_id<>NEW.actor_user_id
    OR b.consent_id IS DISTINCT FROM NEW.consent_id OR b.policy_version<>NEW.policy_version OR b.session_bindings IS DISTINCT FROM NEW.session_bindings
    OR NEW.request->'execution_request' IS DISTINCT FROM b.request OR NEW.request->'source' IS DISTINCT FROM source
    OR NEW.request->>'review_id' IS DISTINCT FROM NEW.id OR NEW.request->'reviewer'->>'instance_id' IS DISTINCT FROM NEW.reviewer_instance_id
    OR NEW.request->'reviewer'->>'agent_id' IS DISTINCT FROM NEW.reviewer_agent_id OR source->'author'->>'instance_id' IS DISTINCT FROM NEW.author_instance_id
    OR source->'author'->>'agent_id' IS DISTINCT FROM NEW.author_agent_id OR NEW.result IS NOT NULL OR NEW.accepted_at IS NOT NULL
    THEN RAISE EXCEPTION 'H6 differs from original completed implementation'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_execution_reviews_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_execution_reviews
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_execution_review();
--> statement-breakpoint
CREATE TRIGGER goal_imported_execution_review_deliveries_protected BEFORE UPDATE OR DELETE ON goal_imported_execution_review_deliveries
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_design_delivery();

--> statement-breakpoint

CREATE FUNCTION protect_goal_imported_execution_repair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h goal_imported_execution_reviews; p goal_imported_execution_review_receipts; b goal_imported_executions;
  r runs; t tasks; pack context_packs; a agent_instances; d goal_imported_execution_repair_deliveries; v event_log; g goals; proof goal_imported_execution_repair_completions; receipt goal_imported_execution_repair_receipts; source jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'H6 repair execution history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','review_ready_at','review_ready_event_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','review_ready_at','review_ready_event_id'])
      OR OLD.stop_requested AND NOT NEW.stop_requested
      OR OLD.result IS NOT NULL AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.result_digest IS DISTINCT FROM OLD.result_digest
        OR NEW.result_delivery_id IS DISTINCT FROM OLD.result_delivery_id OR NEW.result_session_id IS DISTINCT FROM OLD.result_session_id)
      OR OLD.review_ready_at IS NOT NULL AND (NEW.review_ready_at IS DISTINCT FROM OLD.review_ready_at OR NEW.review_ready_event_id IS DISTINCT FROM OLD.review_ready_event_id)
      THEN RAISE EXCEPTION 'H6 repair identity/result/readiness is immutable'; END IF;
    IF OLD.result IS NULL AND NEW.result IS NOT NULL THEN
      SELECT * INTO d FROM goal_imported_execution_repair_deliveries WHERE id=NEW.result_delivery_id;
      IF d.id IS NULL OR d.repair_id<>NEW.id OR d.session_id<>NEW.result_session_id THEN RAISE EXCEPTION 'H6 repair result lacks issuing delivery'; END IF;
      IF NEW.result->'verified_repair' IS NOT NULL AND (NEW.result_session_id IS DISTINCT FROM NEW.session_bindings->'destination'->>'sessionId'
        OR NOT EXISTS(SELECT 1 FROM goal_imported_execution_repair_deliveries WHERE repair_id=NEW.id AND session_id=NEW.result_session_id AND control='start'))
        THEN RAISE EXCEPTION 'H6 repair verified completion requires original session'; END IF;
    END IF;
    IF OLD.review_ready_at IS NULL AND NEW.review_ready_at IS NOT NULL THEN
      SELECT * INTO proof FROM goal_imported_execution_repair_completions WHERE repair_id=NEW.id;
      SELECT * INTO receipt FROM goal_imported_execution_repair_receipts WHERE repair_id=NEW.id;
      SELECT * INTO v FROM event_log WHERE id=NEW.review_ready_event_id; SELECT * INTO t FROM tasks WHERE id=NEW.task_id; SELECT * INTO g FROM goals WHERE id=NEW.goal_id;
      IF receipt.repair_id IS NULL OR receipt.result_digest<>NEW.result_digest OR proof.repair_id IS NULL OR proof.result_digest<>NEW.result_digest OR NEW.stop_requested OR v.id IS NULL OR t.id IS NULL OR g.id IS NULL
        OR t.status<>'review' OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id
        OR v.organization_id<>NEW.organization_id OR v.type<>'goal.imported-execution-repair.review-ready' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
        OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.run_id IS DISTINCT FROM NEW.run_id
        OR v.payload->>'repair_id' IS DISTINCT FROM NEW.id OR v.payload->>'result_digest' IS DISTINCT FROM NEW.result_digest
        OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id OR v.payload->>'verification_evidence_id' IS DISTINCT FROM proof.evidence_id
        THEN RAISE EXCEPTION 'H6 repair review readiness requires exact trusted completion and current goal'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO h FROM goal_imported_execution_reviews WHERE id=NEW.review_id;
  SELECT * INTO p FROM goal_imported_execution_review_receipts WHERE review_id=NEW.review_id;
  SELECT * INTO b FROM goal_imported_executions WHERE id=NEW.base_execution_id;
  SELECT * INTO r FROM runs WHERE id=NEW.run_id; SELECT * INTO t FROM tasks WHERE id=NEW.task_id;
  SELECT * INTO pack FROM context_packs WHERE id=NEW.context_pack_id; SELECT * INTO a FROM agent_instances WHERE id=NEW.writer_instance_id;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE; SELECT * INTO v FROM event_log WHERE id=NEW.authorization_event_id;
  source:=imported_implementation_source(NEW.base_execution_id,h.source_kind,h.source_operation_id);
  IF h.id IS NULL OR p.review_id IS NULL OR b.id IS NULL OR r.id IS NULL OR t.id IS NULL OR pack.id IS NULL OR a.id IS NULL OR g.id IS NULL OR v.id IS NULL
    OR h.stop_requested OR h.accepted_at IS NOT NULL OR h.base_execution_id<>b.id
    OR (h.result->>'outcome'='reviewed' AND h.result->'closed'='true'::jsonb AND h.result->'verdict'->>'outcome'='rejected') IS NOT TRUE
    OR h.organization_id<>NEW.organization_id OR h.goal_id<>NEW.goal_id OR h.plan_id<>NEW.plan_id OR h.task_id<>NEW.task_id
    OR h.computer_id<>NEW.computer_id OR h.workspace_root<>NEW.workspace_root OR h.actor_user_id<>NEW.actor_user_id
    OR h.consent_id IS DISTINCT FROM NEW.consent_id OR h.policy_version<>NEW.policy_version OR NEW.session_bindings IS DISTINCT FROM h.session_bindings
    OR p.session_bindings IS DISTINCT FROM NEW.session_bindings OR p.result_digest IS DISTINCT FROM h.result_digest
    OR NEW.request->'execution_request' IS DISTINCT FROM b.request OR NEW.request->'source' IS DISTINCT FROM h.request->'source' OR source IS DISTINCT FROM h.request->'source'
    OR NEW.request->>'review_id' IS DISTINCT FROM h.id OR NEW.request->>'review_request_digest' IS DISTINCT FROM h.request_digest
    OR NEW.request->>'review_result_digest' IS DISTINCT FROM h.result_digest OR g.retry_count<>NEW.attempt_index
    OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id
    OR ((g.budgets->>'max_retries')::integer IS NOT NULL AND NEW.attempt_index>(g.budgets->>'max_retries')::integer)
    OR v.type<>'goal.imported-execution-repair.authorized' OR v.organization_id<>NEW.organization_id OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
    OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.run_id IS DISTINCT FROM NEW.run_id
    OR v.payload->>'repair_id' IS DISTINCT FROM NEW.id OR v.payload->>'review_id' IS DISTINCT FROM h.id
    OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id OR v.payload->>'review_result_digest' IS DISTINCT FROM h.result_digest
    OR (v.payload->>'attempt_index')::integer IS DISTINCT FROM NEW.attempt_index OR (v.payload->>'previous_retry_count')::integer IS DISTINCT FROM NEW.attempt_index-1
    OR r.organization_id<>NEW.organization_id OR r.task_id<>t.id OR r.context_pack_id IS DISTINCT FROM pack.id OR r.agent_instance_id<>a.id OR r.computer_id<>NEW.computer_id
    OR r.requested_by_user_id IS DISTINCT FROM NEW.actor_user_id OR r.ai_data_sharing_consent_id IS DISTINCT FROM NEW.consent_id OR r.ai_data_sharing_policy_version IS DISTINCT FROM NEW.policy_version
    OR r.workspace_root IS DISTINCT FROM NEW.workspace_root OR r.workspace_branch IS NOT NULL OR r.workspace_allocation IS NOT NULL OR r.status<>'queued'
    OR t.organization_id<>NEW.organization_id OR t.goal_id IS DISTINCT FROM NEW.goal_id OR t.source_plan_id IS DISTINCT FROM NEW.plan_id OR t.status<>'assigned'
    OR pack.organization_id<>NEW.organization_id OR pack.run_id IS DISTINCT FROM r.id OR pack.task_id IS DISTINCT FROM t.id OR NEW.request->'run_start'->'context_pack'->'payload' IS DISTINCT FROM pack.payload
    OR NEW.request->'run_start'->'verification' IS DISTINCT FROM r.verification_requirement OR NEW.request->'run_start'->>'runtime' IS DISTINCT FROM r.runtime_id
    OR a.organization_id<>NEW.organization_id OR a.agent_id<>NEW.writer_agent_id OR a.computer_id<>NEW.computer_id
    OR (NEW.request->'writer'->>'instance_id'=a.id AND NEW.request->'writer'->>'agent_id'=a.agent_id) IS NOT TRUE
    OR NEW.result IS NOT NULL OR NEW.review_ready_at IS NOT NULL THEN RAISE EXCEPTION 'repair differs from rejected H6, original goal budget or real writer assignment'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_execution_repairs_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_execution_repairs
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_execution_repair();
--> statement-breakpoint
CREATE TRIGGER goal_imported_execution_repair_deliveries_protected BEFORE UPDATE OR DELETE ON goal_imported_execution_repair_deliveries
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_design_delivery();
