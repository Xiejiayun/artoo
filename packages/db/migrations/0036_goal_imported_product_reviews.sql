CREATE TABLE goal_imported_product_reviews (
  id text PRIMARY KEY, handoff_id text NOT NULL REFERENCES goal_product_handoffs(id),
  operation_id text NOT NULL REFERENCES goal_product_handoff_operations(id),
  organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id),
  next_task_id text NOT NULL REFERENCES tasks(id), source_run_id text NOT NULL REFERENCES runs(id),
  source_instance_id text NOT NULL REFERENCES agent_instances(id), source_agent_id text NOT NULL REFERENCES agents(id),
  reviewer_instance_id text NOT NULL REFERENCES agent_instances(id), reviewer_agent_id text NOT NULL REFERENCES agents(id), computer_id text NOT NULL REFERENCES computers(id),
  actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL,
  review_run_id text NOT NULL, review_task_id text NOT NULL, request_digest text NOT NULL, request jsonb NOT NULL, result jsonb,
  stop_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_reviews_handoff_uniq UNIQUE(handoff_id),
  CONSTRAINT goal_imported_reviews_run_uniq UNIQUE(review_run_id), CONSTRAINT goal_imported_reviews_task_uniq UNIQUE(review_task_id),
  CONSTRAINT goal_imported_reviews_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT goal_imported_reviews_distinct_agent_chk CHECK(source_agent_id<>reviewer_agent_id AND source_instance_id<>reviewer_instance_id),
  CONSTRAINT goal_imported_reviews_request_chk CHECK((request->'version'='1'::jsonb AND request->>'review_id'=id AND request->'review_start'->>'run_id'=review_run_id AND request->'review_start'->>'task_id'=review_task_id) IS TRUE),
  CONSTRAINT goal_imported_reviews_result_chk CHECK(result IS NULL OR (result->'version'='1'::jsonb AND result->>'review_id'=id AND result->>'request_digest'=request_digest
    AND result->'execution_authorized'='false'::jsonb AND result->>'outcome' IN ('reviewed','failed','uncertain','cancelled_before_start') AND result->'closed'=to_jsonb(result->>'outcome'<>'uncertain')) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_imported_product_review_deliveries (
  id text PRIMARY KEY, review_id text NOT NULL REFERENCES goal_imported_product_reviews(id), session_id text NOT NULL,
  control text NOT NULL, ack jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_imported_review_delivery_session_uniq UNIQUE(review_id,session_id,control),
  CONSTRAINT goal_imported_review_delivery_control_chk CHECK(control IN ('start','stop','status'))
);
--> statement-breakpoint
CREATE FUNCTION protect_goal_imported_product_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h goal_product_handoffs; o goal_product_handoff_operations; s runs; a agent_instances; r agent_instances;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'imported review history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['result','stop_requested']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result','stop_requested'])
      OR OLD.stop_requested AND NOT NEW.stop_requested OR OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result
      THEN RAISE EXCEPTION 'imported review identity/result is immutable'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO h FROM goal_product_handoffs WHERE id=NEW.handoff_id;
  SELECT * INTO o FROM goal_product_handoff_operations WHERE id=NEW.operation_id;
  SELECT * INTO s FROM runs WHERE id=NEW.source_run_id;
  SELECT * INTO a FROM agent_instances WHERE id=NEW.source_instance_id;
  SELECT * INTO r FROM agent_instances WHERE id=NEW.reviewer_instance_id;
  IF h.id IS NULL OR o.id IS NULL OR s.id IS NULL OR a.id IS NULL OR r.id IS NULL OR NOT h.qualified_receipt OR h.stop_requested
    OR h.organization_id<>NEW.organization_id OR h.goal_id<>NEW.goal_id OR h.plan_id<>NEW.plan_id OR h.next_task_id<>NEW.next_task_id
    OR h.source_run_id<>NEW.source_run_id OR h.actor_user_id<>NEW.actor_user_id OR h.consent_id IS DISTINCT FROM NEW.consent_id OR h.policy_version<>NEW.policy_version
    OR o.handoff_id<>h.id OR o.kind<>'import_verify' OR o.computer_id<>NEW.computer_id
    OR (o.result->>'outcome'='verified' AND o.result->'fresh'->'verification'->>'outcome'='passed' AND o.result->'closed'='true'::jsonb) IS NOT TRUE
    OR s.organization_id<>NEW.organization_id OR s.agent_instance_id<>a.id OR a.organization_id<>NEW.organization_id OR a.agent_id<>NEW.source_agent_id
    OR r.organization_id<>NEW.organization_id OR r.agent_id<>NEW.reviewer_agent_id OR r.computer_id<>NEW.computer_id
    OR NEW.request->'operation' IS DISTINCT FROM o.payload OR NEW.request->'result' IS DISTINCT FROM o.result
    OR (NEW.request->'source_author'->>'instance_id'=a.id AND NEW.request->'source_author'->>'agent_id'=a.agent_id
      AND NEW.request->'reviewer'->>'instance_id'=r.id AND NEW.request->'reviewer'->>'agent_id'=r.agent_id) IS NOT TRUE
    THEN RAISE EXCEPTION 'imported review differs from its admitted source author, destination reviewer or handoff'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_product_reviews_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_imported_product_reviews
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_product_review();
--> statement-breakpoint
CREATE FUNCTION protect_goal_imported_product_review_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'ack') IS DISTINCT FROM (to_jsonb(OLD)-'ack') OR OLD.ack IS NOT NULL AND NEW.ack IS DISTINCT FROM OLD.ack
    THEN RAISE EXCEPTION 'imported review delivery identity/ack is immutable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_imported_product_review_deliveries_protected BEFORE UPDATE OR DELETE ON goal_imported_product_review_deliveries
  FOR EACH ROW EXECUTE FUNCTION protect_goal_imported_product_review_delivery();
