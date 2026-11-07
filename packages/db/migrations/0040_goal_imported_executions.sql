CREATE TABLE goal_imported_design_review_receipts (
  review_id text PRIMARY KEY REFERENCES goal_imported_design_reviews(id), organization_id text NOT NULL REFERENCES organizations(id),
  delivery_id text NOT NULL REFERENCES goal_imported_design_review_deliveries(id), session_id text NOT NULL, session_bindings jsonb NOT NULL,
  request_digest text NOT NULL, result_digest text NOT NULL, sent_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_design_review_receipts_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND result_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_imported_executions (
  id text PRIMARY KEY, review_id text NOT NULL REFERENCES goal_imported_design_review_receipts(review_id),
  organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id),
  task_id text NOT NULL REFERENCES tasks(id), run_id text NOT NULL REFERENCES runs(id), context_pack_id text NOT NULL REFERENCES context_packs(id),
  writer_instance_id text NOT NULL REFERENCES agent_instances(id), writer_agent_id text NOT NULL REFERENCES agents(id), computer_id text NOT NULL REFERENCES computers(id),
  workspace_root text NOT NULL, actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL,
  acceptance_event_id text NOT NULL REFERENCES event_log(id), design_evidence_id text NOT NULL REFERENCES run_evidence(id), session_bindings jsonb NOT NULL,
  request_digest text NOT NULL, request jsonb NOT NULL, result jsonb, result_digest text, result_delivery_id text, result_session_id text,
  stop_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL, review_ready_at timestamptz, review_ready_event_id text REFERENCES event_log(id),
  CONSTRAINT goal_imported_executions_review_uniq UNIQUE(review_id), CONSTRAINT goal_imported_executions_task_uniq UNIQUE(task_id), CONSTRAINT goal_imported_executions_run_uniq UNIQUE(run_id),
  CONSTRAINT goal_imported_executions_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND (result_digest IS NULL OR result_digest ~ '^sha256:[a-f0-9]{64}$')),
  CONSTRAINT goal_imported_executions_request_chk CHECK((request->'version'='1'::jsonb AND request->>'stage'='implementation' AND request->>'execution_id'=id
    AND request->'run_start'->>'run_id'=run_id AND request->'run_start'->>'task_id'=task_id AND request->>'acceptance_event_id'=acceptance_event_id
    AND request->>'design_evidence_id'=design_evidence_id AND request->'run_start'->'context_pack'->>'id'=context_pack_id
    AND request->'run_start'->>'agent_instance_id'=writer_instance_id AND request->'run_start'->'workspace'->>'root'=workspace_root) IS TRUE),
  CONSTRAINT goal_imported_executions_result_chk CHECK((result IS NULL AND result_digest IS NULL AND result_delivery_id IS NULL AND result_session_id IS NULL)
    OR (result IS NOT NULL AND result_digest IS NOT NULL AND result_delivery_id IS NOT NULL AND result_session_id IS NOT NULL AND result->'version'='1'::jsonb
      AND result->>'execution_id'=id AND result->>'request_digest'=request_digest AND result->>'run_id'=run_id
      AND result->>'outcome' IN ('finished','failed','uncertain','cancelled_before_start') AND result->'closed'=to_jsonb(result->>'outcome'<>'uncertain')) IS TRUE),
  CONSTRAINT goal_imported_executions_ready_chk CHECK((review_ready_at IS NULL AND review_ready_event_id IS NULL)
    OR (review_ready_at IS NOT NULL AND review_ready_event_id IS NOT NULL AND result->>'outcome'='finished' AND result->'verified_execution'->'verification'->>'outcome'='passed') IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_imported_execution_deliveries (
  id text PRIMARY KEY, execution_id text NOT NULL REFERENCES goal_imported_executions(id), session_id text NOT NULL,
  control text NOT NULL, ack jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_execution_delivery_session_uniq UNIQUE(execution_id,session_id,control),
  CONSTRAINT goal_imported_execution_delivery_control_chk CHECK(control IN ('start','stop','status'))
);
--> statement-breakpoint
ALTER TABLE goal_imported_executions ADD CONSTRAINT goal_imported_executions_delivery_fk FOREIGN KEY(result_delivery_id) REFERENCES goal_imported_execution_deliveries(id);
--> statement-breakpoint
CREATE TABLE goal_imported_execution_completions (
  execution_id text PRIMARY KEY REFERENCES goal_imported_executions(id), organization_id text NOT NULL REFERENCES organizations(id),
  run_id text NOT NULL REFERENCES runs(id), evidence_id text NOT NULL REFERENCES run_evidence(id), context_pack_id text NOT NULL REFERENCES context_packs(id),
  delivery_id text NOT NULL REFERENCES goal_imported_execution_deliveries(id), session_id text NOT NULL,
  result_digest text NOT NULL, completed_execution_digest text NOT NULL, verified_execution jsonb NOT NULL, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_execution_completion_digest_chk CHECK(result_digest ~ '^sha256:[a-f0-9]{64}$' AND completed_execution_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE FUNCTION protect_goal_imported_design_review_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r goal_imported_design_reviews; d goal_imported_design_review_deliveries;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'H4 receipt-send history is immutable'; END IF;
  SELECT * INTO r FROM goal_imported_design_reviews WHERE id=NEW.review_id;
  SELECT * INTO d FROM goal_imported_design_review_deliveries WHERE id=NEW.delivery_id;
  IF r.id IS NULL OR d.id IS NULL OR r.organization_id<>NEW.organization_id OR d.review_id<>r.id OR d.session_id<>NEW.session_id
    OR r.result_delivery_id IS DISTINCT FROM d.id OR r.result_session_id IS DISTINCT FROM NEW.session_id OR r.request_digest<>NEW.request_digest OR r.result_digest IS DISTINCT FROM NEW.result_digest
    OR r.session_bindings IS DISTINCT FROM NEW.session_bindings OR NEW.session_id IS DISTINCT FROM r.session_bindings->'destination'->>'sessionId'
    OR (r.result->>'outcome'='reviewed' AND r.result->'closed'='true'::jsonb AND r.result->'verdict'->>'outcome'='accepted') IS NOT TRUE
    THEN RAISE EXCEPTION 'H4 receipt-send differs from original accepted result/session'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_design_review_receipts_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_design_review_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_design_review_receipt();
--> statement-breakpoint
CREATE FUNCTION protect_goal_imported_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h goal_imported_design_reviews; p goal_imported_design_review_receipts; c goal_imported_design_completions;
  r runs; t tasks; pack context_packs; a agent_instances; d goal_imported_execution_deliveries; v event_log; g goals; proof goal_imported_execution_completions;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'H5 execution history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','review_ready_at','review_ready_event_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','review_ready_at','review_ready_event_id'])
      OR OLD.stop_requested AND NOT NEW.stop_requested
      OR OLD.result IS NOT NULL AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.result_digest IS DISTINCT FROM OLD.result_digest
        OR NEW.result_delivery_id IS DISTINCT FROM OLD.result_delivery_id OR NEW.result_session_id IS DISTINCT FROM OLD.result_session_id)
      OR OLD.review_ready_at IS NOT NULL AND (NEW.review_ready_at IS DISTINCT FROM OLD.review_ready_at OR NEW.review_ready_event_id IS DISTINCT FROM OLD.review_ready_event_id)
      THEN RAISE EXCEPTION 'H5 identity/result/readiness is immutable'; END IF;
    IF OLD.result IS NULL AND NEW.result IS NOT NULL THEN
      SELECT * INTO d FROM goal_imported_execution_deliveries WHERE id=NEW.result_delivery_id;
      IF d.id IS NULL OR d.execution_id<>NEW.id OR d.session_id<>NEW.result_session_id THEN RAISE EXCEPTION 'H5 result lacks issuing delivery'; END IF;
      IF NEW.result->'verified_execution' IS NOT NULL AND (NEW.result_session_id IS DISTINCT FROM NEW.session_bindings->'destination'->>'sessionId'
        OR NOT EXISTS(SELECT 1 FROM goal_imported_execution_deliveries WHERE execution_id=NEW.id AND session_id=NEW.result_session_id AND control='start'))
        THEN RAISE EXCEPTION 'H5 verified completion requires original session'; END IF;
    END IF;
    IF OLD.review_ready_at IS NULL AND NEW.review_ready_at IS NOT NULL THEN
      SELECT * INTO proof FROM goal_imported_execution_completions WHERE execution_id=NEW.id;
      SELECT * INTO v FROM event_log WHERE id=NEW.review_ready_event_id; SELECT * INTO t FROM tasks WHERE id=NEW.task_id; SELECT * INTO g FROM goals WHERE id=NEW.goal_id;
      IF proof.execution_id IS NULL OR proof.result_digest<>NEW.result_digest OR NEW.stop_requested OR v.id IS NULL OR t.id IS NULL OR g.id IS NULL
        OR t.status<>'review' OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id
        OR v.organization_id<>NEW.organization_id OR v.type<>'goal.imported-execution.review-ready' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
        OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.run_id IS DISTINCT FROM NEW.run_id
        OR v.payload->>'execution_id' IS DISTINCT FROM NEW.id OR v.payload->>'result_digest' IS DISTINCT FROM NEW.result_digest
        OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id OR v.payload->>'verification_evidence_id' IS DISTINCT FROM proof.evidence_id
        THEN RAISE EXCEPTION 'H5 review readiness requires exact trusted completion and current goal'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO h FROM goal_imported_design_reviews WHERE id=NEW.review_id;
  SELECT * INTO p FROM goal_imported_design_review_receipts WHERE review_id=NEW.review_id;
  SELECT * INTO c FROM goal_imported_design_completions WHERE continuation_id=h.continuation_id;
  SELECT * INTO r FROM runs WHERE id=NEW.run_id; SELECT * INTO t FROM tasks WHERE id=NEW.task_id;
  SELECT * INTO pack FROM context_packs WHERE id=NEW.context_pack_id; SELECT * INTO a FROM agent_instances WHERE id=NEW.writer_instance_id;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id; SELECT * INTO v FROM event_log WHERE id=NEW.acceptance_event_id;
  IF h.id IS NULL OR p.review_id IS NULL OR c.continuation_id IS NULL OR r.id IS NULL OR t.id IS NULL OR pack.id IS NULL OR a.id IS NULL OR g.id IS NULL OR v.id IS NULL
    OR h.stop_requested OR h.accepted_at IS NULL OR h.acceptance_event_id IS DISTINCT FROM NEW.acceptance_event_id OR c.evidence_id<>NEW.design_evidence_id
    OR h.organization_id<>NEW.organization_id OR h.goal_id<>NEW.goal_id OR h.plan_id<>NEW.plan_id OR h.computer_id<>NEW.computer_id OR h.workspace_root<>NEW.workspace_root
    OR h.actor_user_id<>NEW.actor_user_id OR h.consent_id IS DISTINCT FROM NEW.consent_id OR h.policy_version<>NEW.policy_version
    OR NEW.request->'review_request' IS DISTINCT FROM h.request OR NEW.request->'review_result' IS DISTINCT FROM h.result
    OR NEW.session_bindings IS DISTINCT FROM p.session_bindings OR p.session_id IS DISTINCT FROM NEW.session_bindings->'destination'->>'sessionId'
    OR (h.result->>'outcome'='reviewed' AND h.result->'closed'='true'::jsonb AND h.result->'verdict'->>'outcome'='accepted') IS NOT TRUE
    OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id
    OR v.type<>'goal.imported-design-review.accepted' OR v.organization_id<>NEW.organization_id OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
    OR v.goal_id IS DISTINCT FROM h.goal_id OR v.task_id IS DISTINCT FROM h.task_id OR v.run_id IS DISTINCT FROM c.run_id
    OR v.payload->>'verification_evidence_id' IS DISTINCT FROM NEW.design_evidence_id
    OR v.payload->>'review_id' IS DISTINCT FROM h.id OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id OR v.payload->>'result_digest' IS DISTINCT FROM h.result_digest
    OR r.organization_id<>NEW.organization_id OR r.task_id<>t.id OR r.context_pack_id IS DISTINCT FROM pack.id OR r.agent_instance_id<>a.id OR r.computer_id<>NEW.computer_id
    OR r.requested_by_user_id IS DISTINCT FROM NEW.actor_user_id OR r.ai_data_sharing_consent_id IS DISTINCT FROM NEW.consent_id OR r.ai_data_sharing_policy_version IS DISTINCT FROM NEW.policy_version
    OR r.workspace_root IS DISTINCT FROM NEW.workspace_root OR r.workspace_branch IS NOT NULL OR r.workspace_allocation IS NOT NULL OR r.status<>'queued'
    OR t.organization_id<>NEW.organization_id OR t.goal_id IS DISTINCT FROM NEW.goal_id OR t.source_plan_id IS DISTINCT FROM NEW.plan_id OR t.status<>'assigned'
    OR pack.organization_id<>NEW.organization_id OR pack.run_id IS DISTINCT FROM r.id OR pack.task_id IS DISTINCT FROM t.id OR NEW.request->'run_start'->'context_pack'->'payload' IS DISTINCT FROM pack.payload
    OR NEW.request->'run_start'->'verification' IS DISTINCT FROM r.verification_requirement OR NEW.request->'run_start'->>'runtime' IS DISTINCT FROM r.runtime_id
    OR a.organization_id<>NEW.organization_id OR a.agent_id<>NEW.writer_agent_id OR a.computer_id<>NEW.computer_id
    OR (NEW.request->'writer'->>'instance_id'=a.id AND NEW.request->'writer'->>'agent_id'=a.agent_id) IS NOT TRUE
    OR NEW.result IS NOT NULL OR NEW.review_ready_at IS NOT NULL THEN RAISE EXCEPTION 'H5 differs from accepted H4 and exact real writer assignment'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_executions_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_executions
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_execution();
--> statement-breakpoint
CREATE TRIGGER goal_imported_execution_deliveries_protected BEFORE UPDATE OR DELETE ON goal_imported_execution_deliveries
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_design_delivery();
--> statement-breakpoint
CREATE FUNCTION protect_goal_imported_execution_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x goal_imported_executions; r runs; e run_evidence; p context_packs; d goal_imported_execution_deliveries; v event_log;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'H5 completion provenance is immutable'; END IF;
  SELECT * INTO x FROM goal_imported_executions WHERE id=NEW.execution_id;
  SELECT * INTO r FROM runs WHERE id=NEW.run_id; SELECT * INTO e FROM run_evidence WHERE id=NEW.evidence_id;
  SELECT * INTO p FROM context_packs WHERE id=NEW.context_pack_id; SELECT * INTO d FROM goal_imported_execution_deliveries WHERE id=NEW.delivery_id;
  SELECT * INTO v FROM event_log WHERE id=e.event_id;
  IF x.id IS NULL OR r.id IS NULL OR e.id IS NULL OR p.id IS NULL OR d.id IS NULL OR v.id IS NULL
    OR x.organization_id<>NEW.organization_id OR x.run_id<>r.id OR x.context_pack_id<>p.id OR x.result->'verified_execution' IS DISTINCT FROM NEW.verified_execution
    OR (x.result->>'outcome'='finished' AND x.result->'closed'='true'::jsonb) IS NOT TRUE OR x.result_digest IS DISTINCT FROM NEW.result_digest
    OR r.organization_id<>NEW.organization_id OR r.status<>'completed' OR r.task_id<>x.task_id OR r.context_pack_id IS DISTINCT FROM p.id
    OR r.agent_instance_id<>x.writer_instance_id OR r.computer_id<>x.computer_id
    OR e.organization_id<>NEW.organization_id OR e.run_id<>r.id OR e.payload IS DISTINCT FROM NEW.verified_execution->'verification'
    OR e.request_id IS DISTINCT FROM r.verification_requirement->>'request_id' OR e.payload->>'outcome' IS DISTINCT FROM 'passed'
    OR p.organization_id<>NEW.organization_id OR p.task_id<>x.task_id OR p.run_id IS DISTINCT FROM r.id OR p.payload IS DISTINCT FROM x.request->'run_start'->'context_pack'->'payload'
    OR d.execution_id<>x.id OR d.session_id<>NEW.session_id OR x.result_delivery_id IS DISTINCT FROM d.id OR x.result_session_id IS DISTINCT FROM NEW.session_id
    OR NOT EXISTS(SELECT 1 FROM goal_imported_execution_deliveries WHERE execution_id=x.id AND session_id=NEW.session_id AND control='start')
    OR v.organization_id<>NEW.organization_id OR v.type<>'run.verification' OR v.run_id IS DISTINCT FROM r.id OR v.task_id IS DISTINCT FROM x.task_id
    OR v.actor_type<>'system' OR v.actor_id<>x.computer_id OR v.payload IS DISTINCT FROM e.payload
    OR (NEW.verified_execution->>'execution_id'=x.id AND NEW.verified_execution->>'stage'='implementation' AND NEW.verified_execution->>'request_digest'=x.request_digest
      AND NEW.verified_execution->>'run_id'=r.id AND NEW.verified_execution->>'acceptance_event_id'=x.acceptance_event_id
      AND NEW.verified_execution->'author'->>'instance_id'=x.writer_instance_id AND NEW.verified_execution->'author'->>'agent_id'=x.writer_agent_id) IS NOT TRUE
    THEN RAISE EXCEPTION 'H5 completion lacks original committed node/run/evidence/delivery'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_execution_completions_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_execution_completions
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_execution_completion();
