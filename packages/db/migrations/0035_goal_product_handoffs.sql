CREATE TABLE goal_product_handoffs (
  id text PRIMARY KEY REFERENCES product_source_semantic_transfers(id),
  organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id),
  next_task_id text NOT NULL REFERENCES tasks(id), source_run_id text NOT NULL REFERENCES runs(id), actor_user_id text NOT NULL REFERENCES users(id),
  consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL, intent_digest text NOT NULL, intent jsonb NOT NULL,
  stop_requested boolean NOT NULL DEFAULT false, qualified_receipt boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  CONSTRAINT goal_product_handoffs_source_next_uniq UNIQUE (organization_id, goal_id, plan_id, source_run_id, next_task_id),
  CONSTRAINT goal_product_handoffs_intent_digest_chk CHECK (intent_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT goal_product_handoffs_intent_chk CHECK ((intent->'version'='1'::jsonb AND intent->>'next_task_id'=next_task_id AND intent->'request'->'byte_request'->>'transfer_id'=id) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_product_handoff_operations (
  id text PRIMARY KEY, handoff_id text NOT NULL REFERENCES goal_product_handoffs(id), kind text NOT NULL,
  computer_id text NOT NULL REFERENCES computers(id), payload_digest text NOT NULL,
  payload jsonb NOT NULL, result jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_product_handoff_operation_kind_uniq UNIQUE(handoff_id,kind),
  CONSTRAINT goal_product_handoff_operation_kind_chk CHECK(kind IN ('upload','import_verify')),
  CONSTRAINT goal_product_handoff_operation_digest_chk CHECK(payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT goal_product_handoff_operation_payload_chk CHECK ((payload->'version'='1'::jsonb AND payload->>'operation_id'=id AND payload->>'kind'=kind) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE goal_product_handoff_deliveries (
  id text PRIMARY KEY, operation_id text NOT NULL REFERENCES goal_product_handoff_operations(id), session_id text NOT NULL,
  control text NOT NULL, ack jsonb, created_at timestamptz NOT NULL,
  CONSTRAINT goal_product_handoff_delivery_control_chk CHECK(control IN ('start','stop','status')),
  CONSTRAINT goal_product_handoff_delivery_session_uniq UNIQUE(operation_id,session_id,control)
);
--> statement-breakpoint
CREATE FUNCTION protect_goal_product_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s product_source_semantic_transfers; b product_source_transfers;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'handoff history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['stop_requested','qualified_receipt','updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['stop_requested','qualified_receipt','updated_at']) OR OLD.stop_requested AND NOT NEW.stop_requested
      OR OLD.qualified_receipt AND NOT NEW.qualified_receipt THEN RAISE EXCEPTION 'handoff identity/history is immutable'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO s FROM product_source_semantic_transfers WHERE id=NEW.id;
  SELECT * INTO b FROM product_source_transfers WHERE id=NEW.id;
  IF s.id IS NULL OR s.organization_id<>NEW.organization_id OR s.request IS DISTINCT FROM NEW.intent->'request'
    OR b.goal_id<>NEW.goal_id OR b.plan_id<>NEW.plan_id OR b.source_run_id<>NEW.source_run_id OR b.actor_user_id<>NEW.actor_user_id
    OR (b.request->'authorization'->>'consent_id') IS DISTINCT FROM NEW.consent_id
    OR b.request->'authorization'->>'policy_version'<>NEW.policy_version THEN RAISE EXCEPTION 'handoff differs from admitted original authorization'; END IF;
  IF NOT EXISTS(SELECT 1 FROM tasks WHERE id=NEW.next_task_id AND organization_id=NEW.organization_id AND goal_id=NEW.goal_id AND source_plan_id=NEW.plan_id)
    THEN RAISE EXCEPTION 'handoff next task differs from accepted plan'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_product_handoffs_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_product_handoffs FOR EACH ROW EXECUTE FUNCTION protect_goal_product_handoff();
--> statement-breakpoint
CREATE FUNCTION protect_goal_product_handoff_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h goal_product_handoffs;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'operation history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'result') IS DISTINCT FROM (to_jsonb(OLD)-'result') OR OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result
      THEN RAISE EXCEPTION 'operation identity/result is immutable'; END IF;
  ELSE
    SELECT * INTO h FROM goal_product_handoffs WHERE id=NEW.handoff_id;
    IF h.id IS NULL OR NEW.payload->'intent' IS DISTINCT FROM h.intent
      OR NEW.payload->>'request_digest' IS DISTINCT FROM (SELECT request_digest FROM product_source_semantic_transfers WHERE id=h.id)
      OR NEW.computer_id IS DISTINCT FROM (CASE WHEN NEW.kind='upload' THEN h.intent->'request'->'byte_request'->'source'->>'node_id'
        ELSE h.intent->'request'->'byte_request'->'destination'->>'node_id' END) THEN RAISE EXCEPTION 'operation differs from immutable handoff'; END IF;
  END IF;
  IF NEW.result IS NOT NULL AND ((NEW.result->>'operation_id'=NEW.id AND NEW.result->>'payload_digest'=NEW.payload_digest
    AND NEW.result->>'request_digest'=NEW.payload->>'request_digest') IS NOT TRUE) THEN RAISE EXCEPTION 'result differs from operation'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_product_handoff_operations_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_product_handoff_operations FOR EACH ROW EXECUTE FUNCTION protect_goal_product_handoff_operation();
--> statement-breakpoint
CREATE FUNCTION protect_goal_product_handoff_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'ack') IS DISTINCT FROM (to_jsonb(OLD)-'ack')
    OR OLD.ack IS NOT NULL AND NEW.ack IS DISTINCT FROM OLD.ack THEN RAISE EXCEPTION 'delivery identity/ack is immutable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_product_handoff_deliveries_protected BEFORE UPDATE OR DELETE ON goal_product_handoff_deliveries FOR EACH ROW EXECUTE FUNCTION protect_goal_product_handoff_delivery();
