CREATE TABLE goal_imported_design_continuations (
  id text PRIMARY KEY, review_id text NOT NULL REFERENCES goal_imported_product_reviews(id),
  organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id),
  task_id text NOT NULL REFERENCES tasks(id), run_id text NOT NULL REFERENCES runs(id), context_pack_id text NOT NULL REFERENCES context_packs(id),
  writer_instance_id text NOT NULL REFERENCES agent_instances(id), writer_agent_id text NOT NULL REFERENCES agents(id), computer_id text NOT NULL REFERENCES computers(id),
  workspace_root text NOT NULL, actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL,
  request_digest text NOT NULL, request jsonb NOT NULL, result jsonb, stop_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_design_review_uniq UNIQUE(review_id), CONSTRAINT goal_imported_design_task_uniq UNIQUE(task_id), CONSTRAINT goal_imported_design_run_uniq UNIQUE(run_id),
  CONSTRAINT goal_imported_design_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT goal_imported_design_request_chk CHECK((request->'version'='1'::jsonb AND request->>'continuation_id'=id
    AND request->'run_start'->>'run_id'=run_id AND request->'run_start'->>'task_id'=task_id AND request->'run_start'->'context_pack'->>'id'=context_pack_id
    AND request->'run_start'->>'agent_instance_id'=writer_instance_id AND request->'run_start'->'workspace'->>'root'=workspace_root) IS TRUE),
  CONSTRAINT goal_imported_design_result_chk CHECK(result IS NULL OR (result->'version'='1'::jsonb AND result->>'continuation_id'=id
    AND result->>'request_digest'=request_digest AND result->>'run_id'=run_id AND result->>'outcome' IN ('finished','failed','uncertain','cancelled_before_start')
    AND result->'closed'=to_jsonb(result->>'outcome'<>'uncertain')) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_imported_design_deliveries (
  id text PRIMARY KEY, continuation_id text NOT NULL REFERENCES goal_imported_design_continuations(id), session_id text NOT NULL,
  control text NOT NULL, ack jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_design_delivery_session_uniq UNIQUE(continuation_id,session_id,control),
  CONSTRAINT goal_imported_design_delivery_control_chk CHECK(control IN ('start','stop','status'))
);
--> statement-breakpoint
CREATE FUNCTION protect_goal_imported_design_continuation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p goal_imported_product_reviews; r runs; t tasks; c context_packs; a agent_instances;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'imported design history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['result','stop_requested']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result','stop_requested'])
      OR OLD.stop_requested AND NOT NEW.stop_requested OR OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result
      THEN RAISE EXCEPTION 'imported design identity/result is immutable'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO p FROM goal_imported_product_reviews WHERE id=NEW.review_id;
  SELECT * INTO r FROM runs WHERE id=NEW.run_id;
  SELECT * INTO t FROM tasks WHERE id=NEW.task_id;
  SELECT * INTO c FROM context_packs WHERE id=NEW.context_pack_id;
  SELECT * INTO a FROM agent_instances WHERE id=NEW.writer_instance_id;
  IF p.id IS NULL OR r.id IS NULL OR t.id IS NULL OR c.id IS NULL OR a.id IS NULL OR p.stop_requested
    OR (p.result->>'outcome'='reviewed' AND p.result->'verdict'->>'outcome'='accepted' AND p.result->'closed'='true'::jsonb) IS NOT TRUE
    OR p.organization_id<>NEW.organization_id OR p.goal_id<>NEW.goal_id OR p.plan_id<>NEW.plan_id OR p.next_task_id<>NEW.task_id OR p.computer_id<>NEW.computer_id
    OR p.actor_user_id<>NEW.actor_user_id OR p.consent_id IS DISTINCT FROM NEW.consent_id OR p.policy_version<>NEW.policy_version
    OR NEW.request->'review_request' IS DISTINCT FROM p.request OR NEW.request->'review_result' IS DISTINCT FROM p.result
    OR r.organization_id<>NEW.organization_id OR r.task_id<>t.id OR r.context_pack_id IS DISTINCT FROM c.id OR r.agent_instance_id<>a.id OR r.computer_id<>NEW.computer_id
    OR r.requested_by_user_id IS DISTINCT FROM NEW.actor_user_id OR r.ai_data_sharing_consent_id IS DISTINCT FROM NEW.consent_id OR r.ai_data_sharing_policy_version IS DISTINCT FROM NEW.policy_version
    OR r.workspace_root IS DISTINCT FROM NEW.workspace_root OR r.workspace_branch IS NOT NULL OR r.workspace_allocation IS NOT NULL OR r.status<>'queued'
    OR t.organization_id<>NEW.organization_id OR t.goal_id IS DISTINCT FROM NEW.goal_id OR t.source_plan_id IS DISTINCT FROM NEW.plan_id OR t.status<>'assigned'
    OR c.organization_id<>NEW.organization_id OR c.run_id IS DISTINCT FROM r.id OR c.task_id IS DISTINCT FROM t.id OR NEW.request->'run_start'->'context_pack'->'payload' IS DISTINCT FROM c.payload
    OR NEW.request->'run_start'->'verification' IS DISTINCT FROM r.verification_requirement OR NEW.request->'run_start'->>'runtime' IS DISTINCT FROM r.runtime_id
    OR a.organization_id<>NEW.organization_id OR a.agent_id<>NEW.writer_agent_id OR a.computer_id<>NEW.computer_id
    OR (NEW.request->'writer'->>'instance_id'=a.id AND NEW.request->'writer'->>'agent_id'=a.agent_id) IS NOT TRUE
    THEN RAISE EXCEPTION 'imported design differs from its accepted review or exact real writer assignment'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_design_continuations_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_design_continuations
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_design_continuation();
--> statement-breakpoint
CREATE FUNCTION protect_goal_imported_design_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'ack') IS DISTINCT FROM (to_jsonb(OLD)-'ack') OR OLD.ack IS NOT NULL AND NEW.ack IS DISTINCT FROM OLD.ack
    THEN RAISE EXCEPTION 'imported design delivery identity/ack is immutable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_design_deliveries_protected BEFORE UPDATE OR DELETE ON goal_imported_design_deliveries
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_design_delivery();
