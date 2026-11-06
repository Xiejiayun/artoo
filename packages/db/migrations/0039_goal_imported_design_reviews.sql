CREATE TABLE goal_imported_design_completions (
  continuation_id text PRIMARY KEY REFERENCES goal_imported_design_continuations(id), organization_id text NOT NULL REFERENCES organizations(id),
  run_id text NOT NULL REFERENCES runs(id), evidence_id text NOT NULL REFERENCES run_evidence(id), context_pack_id text NOT NULL REFERENCES context_packs(id),
  delivery_id text NOT NULL REFERENCES goal_imported_design_deliveries(id), session_id text NOT NULL,
  result_digest text NOT NULL, completed_design_digest text NOT NULL, verified_design jsonb NOT NULL, created_at timestamptz NOT NULL, receipt_sent_at timestamptz,
  CONSTRAINT goal_imported_design_completion_digest_chk CHECK(result_digest ~ '^sha256:[a-f0-9]{64}$' AND completed_design_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_imported_design_reviews (
  id text PRIMARY KEY, continuation_id text NOT NULL REFERENCES goal_imported_design_completions(continuation_id),
  organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id), task_id text NOT NULL REFERENCES tasks(id),
  author_instance_id text NOT NULL REFERENCES agent_instances(id), author_agent_id text NOT NULL REFERENCES agents(id),
  reviewer_instance_id text NOT NULL REFERENCES agent_instances(id), reviewer_agent_id text NOT NULL REFERENCES agents(id),
  computer_id text NOT NULL REFERENCES computers(id), workspace_root text NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL,
  session_bindings jsonb NOT NULL, request_digest text NOT NULL, request jsonb NOT NULL,
  result jsonb, result_digest text, result_delivery_id text, result_session_id text,
  stop_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL, accepted_at timestamptz, acceptance_event_id text REFERENCES event_log(id),
  CONSTRAINT goal_imported_design_reviews_continuation_uniq UNIQUE(continuation_id), CONSTRAINT goal_imported_design_reviews_task_uniq UNIQUE(task_id),
  CONSTRAINT goal_imported_design_reviews_independent_chk CHECK(author_instance_id<>reviewer_instance_id AND author_agent_id<>reviewer_agent_id),
  CONSTRAINT goal_imported_design_reviews_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND (result_digest IS NULL OR result_digest ~ '^sha256:[a-f0-9]{64}$')),
  CONSTRAINT goal_imported_design_reviews_result_chk CHECK((result IS NULL AND result_digest IS NULL AND result_delivery_id IS NULL AND result_session_id IS NULL)
    OR (result IS NOT NULL AND result_digest IS NOT NULL AND result_delivery_id IS NOT NULL AND result_session_id IS NOT NULL
      AND result->'version'='1'::jsonb AND result->>'review_id'=id AND result->>'request_digest'=request_digest
      AND result->'execution_authorized'='false'::jsonb AND result->>'outcome' IN ('reviewed','failed','uncertain','cancelled_before_start')
      AND result->'closed'=to_jsonb(result->>'outcome'<>'uncertain')) IS TRUE),
  CONSTRAINT goal_imported_design_reviews_acceptance_chk CHECK((accepted_at IS NULL AND acceptance_event_id IS NULL)
    OR (accepted_at IS NOT NULL AND acceptance_event_id IS NOT NULL AND result->>'outcome'='reviewed' AND result->'verdict'->>'outcome'='accepted') IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_imported_design_review_deliveries (
  id text PRIMARY KEY, review_id text NOT NULL REFERENCES goal_imported_design_reviews(id), session_id text NOT NULL,
  control text NOT NULL, ack jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_design_review_delivery_session_uniq UNIQUE(review_id,session_id,control),
  CONSTRAINT goal_imported_design_review_delivery_control_chk CHECK(control IN ('start','stop','status'))
);
--> statement-breakpoint
ALTER TABLE goal_imported_design_reviews ADD CONSTRAINT goal_imported_design_reviews_delivery_fk FOREIGN KEY(result_delivery_id) REFERENCES goal_imported_design_review_deliveries(id);
--> statement-breakpoint
CREATE FUNCTION protect_goal_imported_design_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c goal_imported_design_continuations; r runs; e run_evidence; p context_packs; d goal_imported_design_deliveries; v event_log;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'imported completed-design provenance is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'receipt_sent_at') IS DISTINCT FROM (to_jsonb(OLD)-'receipt_sent_at')
      OR OLD.receipt_sent_at IS NOT NULL AND NEW.receipt_sent_at IS DISTINCT FROM OLD.receipt_sent_at
      THEN RAISE EXCEPTION 'imported completed-design identity/receipt is immutable'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM goal_imported_design_continuations WHERE id=NEW.continuation_id;
  SELECT * INTO r FROM runs WHERE id=NEW.run_id; SELECT * INTO e FROM run_evidence WHERE id=NEW.evidence_id;
  SELECT * INTO p FROM context_packs WHERE id=NEW.context_pack_id; SELECT * INTO d FROM goal_imported_design_deliveries WHERE id=NEW.delivery_id;
  SELECT * INTO v FROM event_log WHERE id=e.event_id;
  IF c.id IS NULL OR r.id IS NULL OR e.id IS NULL OR p.id IS NULL OR d.id IS NULL OR v.id IS NULL
    OR c.organization_id<>NEW.organization_id OR c.run_id<>r.id OR c.context_pack_id<>p.id OR c.result->'verified_design' IS DISTINCT FROM NEW.verified_design
    OR (c.result->>'outcome'='finished' AND c.result->'closed'='true'::jsonb) IS NOT TRUE
    OR r.organization_id<>NEW.organization_id OR r.status<>'completed' OR r.task_id<>c.task_id OR r.context_pack_id IS DISTINCT FROM p.id
    OR r.agent_instance_id<>c.writer_instance_id OR r.computer_id<>c.computer_id
    OR e.organization_id<>NEW.organization_id OR e.run_id<>r.id OR e.payload IS DISTINCT FROM NEW.verified_design->'verification'
    OR e.request_id IS DISTINCT FROM r.verification_requirement->>'request_id' OR e.payload->>'outcome' IS DISTINCT FROM 'passed'
    OR p.organization_id<>NEW.organization_id OR p.task_id<>c.task_id OR p.run_id IS DISTINCT FROM r.id OR p.payload IS DISTINCT FROM c.request->'run_start'->'context_pack'->'payload'
    OR d.continuation_id<>c.id OR d.session_id<>NEW.session_id
    OR NOT EXISTS(SELECT 1 FROM goal_imported_design_deliveries WHERE continuation_id=c.id AND session_id=NEW.session_id AND control='start')
    OR v.organization_id<>NEW.organization_id OR v.type<>'run.verification' OR v.run_id IS DISTINCT FROM r.id OR v.task_id IS DISTINCT FROM c.task_id
    OR v.actor_type<>'system' OR v.actor_id<>c.computer_id OR v.payload IS DISTINCT FROM e.payload
    OR (NEW.verified_design->>'continuation_id'=c.id AND NEW.verified_design->>'request_digest'=c.request_digest AND NEW.verified_design->>'run_id'=r.id
      AND NEW.verified_design->'author'->>'instance_id'=c.writer_instance_id AND NEW.verified_design->'author'->>'agent_id'=c.writer_agent_id) IS NOT TRUE
    THEN RAISE EXCEPTION 'imported completed design lacks its original committed node/run/evidence/delivery'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_design_completions_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_design_completions
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_design_completion();
--> statement-breakpoint
CREATE FUNCTION protect_goal_imported_design_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c goal_imported_design_continuations; p goal_imported_design_completions; a agent_instances; d goal_imported_design_review_deliveries; v event_log; t tasks; g goals;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'imported design review history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','accepted_at','acceptance_event_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result','result_digest','result_delivery_id','result_session_id','stop_requested','accepted_at','acceptance_event_id'])
      OR OLD.stop_requested AND NOT NEW.stop_requested
      OR OLD.result IS NOT NULL AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.result_digest IS DISTINCT FROM OLD.result_digest
        OR NEW.result_delivery_id IS DISTINCT FROM OLD.result_delivery_id OR NEW.result_session_id IS DISTINCT FROM OLD.result_session_id)
      OR OLD.accepted_at IS NOT NULL AND (NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NEW.acceptance_event_id IS DISTINCT FROM OLD.acceptance_event_id)
      THEN RAISE EXCEPTION 'imported design review identity/result/acceptance is immutable'; END IF;
    IF OLD.result IS NULL AND NEW.result IS NOT NULL THEN
      SELECT * INTO d FROM goal_imported_design_review_deliveries WHERE id=NEW.result_delivery_id;
      IF d.id IS NULL OR d.review_id<>NEW.id OR d.session_id<>NEW.result_session_id THEN RAISE EXCEPTION 'design review result lacks its issuing delivery'; END IF;
      IF NEW.result->>'outcome'='reviewed' AND (NEW.result_session_id IS DISTINCT FROM NEW.session_bindings->'destination'->>'sessionId'
        OR NOT EXISTS(SELECT 1 FROM goal_imported_design_review_deliveries WHERE review_id=NEW.id AND session_id=NEW.result_session_id AND control='start'))
        THEN RAISE EXCEPTION 'design review success belongs to its original admitted session'; END IF;
    END IF;
    IF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN
      SELECT * INTO v FROM event_log WHERE id=NEW.acceptance_event_id; SELECT * INTO t FROM tasks WHERE id=NEW.task_id; SELECT * INTO g FROM goals WHERE id=NEW.goal_id;
      IF NEW.stop_requested OR v.id IS NULL OR t.id IS NULL OR g.id IS NULL OR t.status<>'done' OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id
        OR v.organization_id<>NEW.organization_id OR v.type<>'goal.imported-design-review.accepted' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
        OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM NEW.task_id OR v.payload->>'review_id' IS DISTINCT FROM NEW.id
        OR v.payload->>'result_digest' IS DISTINCT FROM NEW.result_digest OR v.payload->>'actor_user_id' IS DISTINCT FROM NEW.actor_user_id
        THEN RAISE EXCEPTION 'design acceptance requires its current goal and trusted exact acceptance event'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM goal_imported_design_continuations WHERE id=NEW.continuation_id;
  SELECT * INTO p FROM goal_imported_design_completions WHERE continuation_id=NEW.continuation_id;
  SELECT * INTO a FROM agent_instances WHERE id=NEW.reviewer_instance_id;
  IF c.id IS NULL OR p.continuation_id IS NULL OR a.id IS NULL OR c.stop_requested OR p.receipt_sent_at IS NULL OR NEW.result IS NOT NULL OR NEW.accepted_at IS NOT NULL
    OR c.organization_id<>NEW.organization_id OR c.goal_id<>NEW.goal_id OR c.plan_id<>NEW.plan_id OR c.task_id<>NEW.task_id
    OR c.writer_instance_id<>NEW.author_instance_id OR c.writer_agent_id<>NEW.author_agent_id OR c.computer_id<>NEW.computer_id OR c.workspace_root<>NEW.workspace_root
    OR c.actor_user_id<>NEW.actor_user_id OR c.consent_id IS DISTINCT FROM NEW.consent_id OR c.policy_version<>NEW.policy_version
    OR a.organization_id<>NEW.organization_id OR a.agent_id<>NEW.reviewer_agent_id OR a.computer_id<>NEW.computer_id OR a.workspace_root IS DISTINCT FROM NEW.workspace_root
    OR NEW.request->'continuation_request' IS DISTINCT FROM c.request OR NEW.request->'continuation_result' IS DISTINCT FROM c.result
    OR (NEW.request->'version'='1'::jsonb AND NEW.request->>'review_id'=NEW.id AND NEW.request->'reviewer'->>'instance_id'=a.id AND NEW.request->'reviewer'->>'agent_id'=a.agent_id
      AND NEW.session_bindings->'destination'->>'computerId'=c.computer_id AND NEW.session_bindings->'destination'->>'sessionId'=p.session_id) IS NOT TRUE
    THEN RAISE EXCEPTION 'design review differs from its exact completed author or reviewer'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_design_reviews_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_design_reviews
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_design_review();
--> statement-breakpoint
CREATE TRIGGER goal_imported_design_review_deliveries_protected BEFORE UPDATE OR DELETE ON goal_imported_design_review_deliveries
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_design_delivery();
