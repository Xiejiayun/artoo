-- Preserve publication facts. A retry is a new attempt with a unique predecessor.
ALTER TABLE product_releases ADD COLUMN publication_generation integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE product_releases ADD COLUMN root_release_id text REFERENCES product_releases(id);
--> statement-breakpoint
ALTER TABLE product_releases ADD COLUMN retry_of_release_id text REFERENCES product_releases(id);
--> statement-breakpoint
ALTER TABLE product_releases ADD COLUMN retry_authorization_event_id text REFERENCES event_log(id);
--> statement-breakpoint
ALTER TABLE product_releases DROP CONSTRAINT product_releases_goal_uniq;
--> statement-breakpoint
ALTER TABLE product_releases ADD CONSTRAINT product_releases_goal_generation_uniq UNIQUE(organization_id,goal_id,publication_generation);
--> statement-breakpoint
ALTER TABLE product_releases ADD CONSTRAINT product_releases_retry_predecessor_uniq UNIQUE(retry_of_release_id);
--> statement-breakpoint
CREATE UNIQUE INDEX product_releases_goal_queued_uniq ON product_releases(organization_id,goal_id) WHERE status='queued';
--> statement-breakpoint
ALTER TABLE product_releases ADD CONSTRAINT product_releases_lineage_chk CHECK(
  (publication_generation=0 AND root_release_id IS NULL AND retry_of_release_id IS NULL AND retry_authorization_event_id IS NULL)
  OR (publication_generation>0 AND root_release_id IS NOT NULL AND retry_of_release_id IS NOT NULL AND retry_authorization_event_id IS NOT NULL));
--> statement-breakpoint
CREATE TABLE product_release_retry_sources (
  release_id text PRIMARY KEY REFERENCES product_releases(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  computer_id text NOT NULL REFERENCES computers(id),
  device_id text NOT NULL REFERENCES devices(id),
  token_lookup text NOT NULL, session_id text NOT NULL, source_id text NOT NULL,
  request_digest text NOT NULL, receipt_digest text NOT NULL, projection jsonb NOT NULL,
  receipt_event_id text NOT NULL REFERENCES event_log(id), received_at timestamptz NOT NULL,
  CONSTRAINT product_release_retry_source_uniq UNIQUE(computer_id,session_id,source_id),
  CONSTRAINT product_release_retry_source_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND receipt_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE goal_imported_validation_publications DROP CONSTRAINT goal_imported_validation_publication_goal_uniq;
--> statement-breakpoint
CREATE INDEX goal_imported_validation_publication_goal_idx ON goal_imported_validation_publications(organization_id,goal_id);
--> statement-breakpoint
-- The validated release schemas use fixed ASCII object keys and safe integers.
-- Render their JSON without PostgreSQL's display whitespace, preserving array order.
CREATE FUNCTION artoo_release_retry_json_v1(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE rendered text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      IF EXISTS(SELECT 1 FROM jsonb_object_keys(value) k WHERE octet_length(k)<>char_length(k))
        THEN RAISE EXCEPTION 'Release retry canonical input requires ASCII object keys'; END IF;
      SELECT '{'||COALESCE(string_agg(to_json(k)::text||':'||artoo_release_retry_json_v1(v),',' ORDER BY k COLLATE "C"),'')||'}'
        INTO rendered FROM jsonb_each(value) AS entries(k,v);
    WHEN 'array' THEN
      SELECT '['||COALESCE(string_agg(artoo_release_retry_json_v1(v),',' ORDER BY ordinal),'')||']'
        INTO rendered FROM jsonb_array_elements(value) WITH ORDINALITY AS entries(v,ordinal);
    WHEN 'number' THEN
      IF (value#>>'{}')::numeric<>trunc((value#>>'{}')::numeric) OR abs((value#>>'{}')::numeric)>9007199254740991
        THEN RAISE EXCEPTION 'Release retry canonical input requires safe integer numbers'; END IF;
      rendered:=trunc((value#>>'{}')::numeric)::text;
    ELSE rendered:=value::text;
  END CASE;
  RETURN rendered;
END $$;
--> statement-breakpoint
CREATE FUNCTION artoo_release_retry_digest_v1(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT 'sha256:'||encode(sha256(convert_to(artoo_release_retry_json_v1(value),'UTF8')),'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION protect_product_release_retry_source_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r product_releases%ROWTYPE; restored product_releases%ROWTYPE; e event_log%ROWTYPE;
  d devices%ROWTYPE; t device_tokens%ROWTYPE; recovery jsonb; recovery_paths jsonb; restored_paths jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Publication retry sources are immutable'; END IF;
  SELECT * INTO r FROM product_releases WHERE id=NEW.release_id;
  SELECT * INTO e FROM event_log WHERE id=NEW.receipt_event_id;
  SELECT * INTO d FROM devices WHERE id=NEW.device_id;
  SELECT * INTO t FROM device_tokens WHERE token_lookup=NEW.token_lookup;
  IF r.id IS NULL OR e.id IS NULL OR d.id IS NULL OR t.id IS NULL
    OR r.organization_id<>NEW.organization_id OR r.computer_id<>NEW.computer_id OR r.status NOT IN ('failed','rolled_back') OR r.receipt IS NULL
    OR r.receipt->'request' IS DISTINCT FROM r.request OR r.receipt->>'outcome' IS DISTINCT FROM r.status
    OR NEW.request_digest IS DISTINCT FROM artoo_release_retry_digest_v1(r.request)
    OR NEW.receipt_digest IS DISTINCT FROM artoo_release_retry_digest_v1(r.receipt)
    OR NEW.projection IS DISTINCT FROM r.receipt->'retry_source'
    OR (NEW.projection->'version'='1'::jsonb AND NEW.projection->>'closure'='local-release-settled.v1'
      AND NEW.projection->>'source_id'=NEW.source_id AND length(NEW.source_id)>0 AND length(NEW.session_id)>0) IS NOT TRUE
    OR e.organization_id<>NEW.organization_id OR e.type<>'product.release.completed' OR e.actor_type<>'system' OR e.actor_id<>NEW.computer_id
    OR e.correlation_id IS DISTINCT FROM r.id OR e.goal_id IS DISTINCT FROM r.goal_id OR e.project_id IS DISTINCT FROM r.project_id OR e.run_id IS DISTINCT FROM r.run_id
    OR e.payload->>'release_id' IS DISTINCT FROM r.id OR e.payload->'receipt' IS DISTINCT FROM r.receipt
    OR e.payload->>'request_digest' IS DISTINCT FROM NEW.request_digest OR e.payload->>'receipt_digest' IS DISTINCT FROM NEW.receipt_digest
    OR d.organization_id<>NEW.organization_id OR d.computer_id IS DISTINCT FROM NEW.computer_id OR d.trust<>'active' OR d.revoked_at IS NOT NULL
    OR t.organization_id<>NEW.organization_id OR t.device_id<>d.id OR t.kind<>'node' OR t.status<>'active' OR t.revoked_at IS NOT NULL
    OR (t.expires_at IS NOT NULL AND t.expires_at<=NEW.received_at)
    THEN RAISE EXCEPTION 'Publication retry source lacks its exact receipt, event or paired sender'; END IF;
  recovery:=NEW.projection->'recovery';
  IF recovery->>'kind'='listener-closed' THEN
    IF recovery->'active_release_id' IS DISTINCT FROM 'null'::jsonb OR recovery->'active_artifact_digest' IS DISTINCT FROM 'null'::jsonb
      THEN RAISE EXCEPTION 'Closed publication retry source has an active endpoint'; END IF;
  ELSIF recovery->>'kind'='previous-restored' THEN
    SELECT * INTO restored FROM product_releases WHERE id=recovery->>'active_release_id';
    IF (recovery->>'active_release_id'=r.receipt->>'previous_release_id' AND recovery->>'active_release_id'<>r.id
      AND recovery->>'active_artifact_digest' ~ '^sha256:[a-f0-9]{64}$'
      AND jsonb_typeof(r.receipt->'recovery_checks')='array' AND jsonb_array_length(r.receipt->'recovery_checks')>0) IS NOT TRUE
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.receipt->'recovery_checks') item WHERE item->'passed' IS DISTINCT FROM 'true'::jsonb)
      THEN RAISE EXCEPTION 'Restored publication retry source lacks previous-version recovery measurements'; END IF;
    IF restored.id IS NULL OR restored.organization_id<>r.organization_id OR restored.project_id<>r.project_id
      OR restored.computer_id<>r.computer_id OR restored.status<>'published' OR restored.receipt IS NULL
      OR restored.receipt->>'outcome' IS DISTINCT FROM 'published' OR restored.receipt->'request' IS DISTINCT FROM restored.request
      OR restored.receipt->>'artifact_digest' IS DISTINCT FROM recovery->>'active_artifact_digest'
      OR restored.receipt->>'endpoint' IS NULL
      OR (r.receipt->>'endpoint' IS NOT NULL AND restored.receipt->>'endpoint' IS DISTINCT FROM r.receipt->>'endpoint')
      OR restored.receipt->>'artifact_digest' IS DISTINCT FROM restored.request->>'subject_digest'
      OR restored.receipt->>'release_profile_digest' IS DISTINCT FROM r.receipt->>'release_profile_digest'
      OR restored.request->>'release_profile_id' IS DISTINCT FROM r.request->>'release_profile_id'
      OR (jsonb_typeof(restored.receipt->'health_checks')='array' AND jsonb_array_length(restored.receipt->'health_checks')>0) IS NOT TRUE
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(restored.receipt->'health_checks') item WHERE item->'passed' IS DISTINCT FROM 'true'::jsonb)
      THEN RAISE EXCEPTION 'Restored retry source has no exact previous published version'; END IF;
    SELECT jsonb_agg(jsonb_build_array(item->'path',item->'body_digest') ORDER BY item->>'path',item->>'body_digest')
      INTO recovery_paths FROM jsonb_array_elements(r.receipt->'recovery_checks') item;
    SELECT jsonb_agg(jsonb_build_array(item->'path',item->'body_digest') ORDER BY item->>'path',item->>'body_digest')
      INTO restored_paths FROM jsonb_array_elements(restored.receipt->'health_checks') item;
    IF recovery_paths IS DISTINCT FROM restored_paths
      THEN RAISE EXCEPTION 'Restored retry source changed the previous measured paths or bytes'; END IF;
  ELSE RAISE EXCEPTION 'Publication retry source has no qualified recovery state'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER product_release_retry_sources_protected BEFORE INSERT OR UPDATE OR DELETE ON product_release_retry_sources
  FOR EACH ROW EXECUTE FUNCTION protect_product_release_retry_source_v1();
--> statement-breakpoint
CREATE FUNCTION protect_product_release_attempt_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous product_releases%ROWTYPE; source product_release_retry_sources%ROWTYPE; g goals%ROWTYPE;
  a goal_automations%ROWTYPE; plan plans%ROWTYPE; r runs%ROWTYPE; evidence run_evidence%ROWTYPE;
  e event_log%ROWTYPE; d devices%ROWTYPE; token device_tokens%ROWTYPE; retry jsonb; retry_authorization jsonb; session jsonb; attempt integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Publication attempts are immutable history'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.organization_id,NEW.goal_id,NEW.project_id,NEW.computer_id,NEW.run_id,NEW.evidence_id,NEW.request,NEW.created_at,
      NEW.publication_generation,NEW.root_release_id,NEW.retry_of_release_id,NEW.retry_authorization_event_id)
      IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.goal_id,OLD.project_id,OLD.computer_id,OLD.run_id,OLD.evidence_id,OLD.request,OLD.created_at,
      OLD.publication_generation,OLD.root_release_id,OLD.retry_of_release_id,OLD.retry_authorization_event_id)
      THEN RAISE EXCEPTION 'Publication identity, request and retry lineage are immutable'; END IF;
    IF OLD.receipt IS NOT NULL OR OLD.status<>'queued' THEN
      IF NEW.receipt IS DISTINCT FROM OLD.receipt OR NEW.status IS DISTINCT FROM OLD.status
        THEN RAISE EXCEPTION 'A committed publication receipt cannot be rewritten'; END IF;
      RETURN NEW;
    END IF;
    IF (NEW.status='queued' AND NEW.receipt IS NULL) THEN RETURN NEW; END IF;
    IF NEW.status NOT IN ('published','rolled_back','failed') OR NEW.receipt IS NULL
      OR NEW.receipt->'request' IS DISTINCT FROM NEW.request OR NEW.receipt->>'outcome' IS DISTINCT FROM NEW.status
      THEN RAISE EXCEPTION 'Publication completion must bind the original request and terminal outcome'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status<>'queued' OR NEW.receipt IS NOT NULL
    OR NEW.request->>'release_id' IS DISTINCT FROM NEW.id OR NEW.request->>'goal_id' IS DISTINCT FROM NEW.goal_id
    OR NEW.request->>'project_id' IS DISTINCT FROM NEW.project_id OR NEW.request->>'run_id' IS DISTINCT FROM NEW.run_id
    THEN RAISE EXCEPTION 'A new publication attempt must start queued with its exact request'; END IF;
  IF NEW.publication_generation=0 THEN
    IF NEW.request ? 'retry' THEN RAISE EXCEPTION 'An initial publication cannot carry retry authority'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE;
  SELECT * INTO previous FROM product_releases WHERE id=NEW.retry_of_release_id FOR UPDATE;
  SELECT * INTO source FROM product_release_retry_sources WHERE release_id=previous.id;
  SELECT * INTO a FROM goal_automations WHERE goal_id=NEW.goal_id;
  SELECT * INTO plan FROM plans WHERE id=a.plan_id;
  SELECT * INTO r FROM runs WHERE id=NEW.run_id;
  SELECT * INTO evidence FROM run_evidence WHERE id=NEW.evidence_id;
  SELECT * INTO e FROM event_log WHERE id=NEW.retry_authorization_event_id;
  SELECT * INTO d FROM devices WHERE id=source.device_id;
  SELECT * INTO token FROM device_tokens WHERE token_lookup=source.token_lookup;
  retry:=NEW.request->'retry'; retry_authorization:=retry->'authorization'; attempt:=(retry_authorization->>'attempt_index')::integer;
  session:=jsonb_build_object('computerId',source.computer_id,'deviceId',source.device_id,'tokenLookup',source.token_lookup,'sessionId',source.session_id);
  IF g.id IS NULL OR previous.id IS NULL OR source.release_id IS NULL OR a.goal_id IS NULL OR plan.id IS NULL OR r.id IS NULL
    OR evidence.id IS NULL OR e.id IS NULL OR d.id IS NULL OR token.id IS NULL
    OR previous.organization_id<>NEW.organization_id OR previous.goal_id<>NEW.goal_id OR previous.project_id<>NEW.project_id
    OR previous.computer_id<>NEW.computer_id OR previous.run_id<>NEW.run_id OR previous.evidence_id<>NEW.evidence_id
    OR previous.status NOT IN ('failed','rolled_back') OR previous.receipt IS NULL
    OR NEW.publication_generation<>previous.publication_generation+1 OR NEW.root_release_id<>COALESCE(previous.root_release_id,previous.id)
    OR EXISTS(SELECT 1 FROM product_releases WHERE organization_id=NEW.organization_id AND goal_id=NEW.goal_id AND publication_generation>previous.publication_generation)
    OR (NEW.request-'release_id'-'retry') IS DISTINCT FROM (previous.request-'release_id'-'retry')
    OR source.organization_id<>NEW.organization_id OR source.computer_id<>NEW.computer_id
    OR source.request_digest IS DISTINCT FROM artoo_release_retry_digest_v1(previous.request)
    OR source.receipt_digest IS DISTINCT FROM artoo_release_retry_digest_v1(previous.receipt)
    OR source.projection IS DISTINCT FROM previous.receipt->'retry_source'
    OR retry IS DISTINCT FROM jsonb_build_object('version',1,'root_release_id',NEW.root_release_id,'previous_release_id',previous.id,
      'generation',NEW.publication_generation,'source_id',source.source_id,'previous_request_digest',source.request_digest,'previous_receipt_digest',source.receipt_digest,
      'authorization',jsonb_build_object('event_id',e.id,'goal_id',g.id,'actor_user_id',a.actor_user_id,'attempt_index',attempt))
    OR g.organization_id<>NEW.organization_id OR g.project_id<>NEW.project_id OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM a.plan_id
    OR a.organization_id<>NEW.organization_id OR a.status NOT IN ('executing','waiting')
    OR plan.organization_id<>NEW.organization_id OR plan.goal_id<>NEW.goal_id OR plan.status<>'accepted'
    OR attempt IS NULL OR attempt<1 OR g.retry_count<>attempt
    OR ((g.budgets->>'max_retries')::integer IS NOT NULL AND attempt>(g.budgets->>'max_retries')::integer)
    OR r.organization_id<>NEW.organization_id OR r.status<>'completed' OR r.computer_id<>NEW.computer_id
    OR r.requested_by_user_id IS DISTINCT FROM a.actor_user_id OR r.ai_data_sharing_consent_id IS DISTINCT FROM a.consent_id
    OR r.ai_data_sharing_policy_version IS DISTINCT FROM a.policy_version
    OR evidence.organization_id<>NEW.organization_id OR evidence.run_id<>r.id OR evidence.payload->>'outcome' IS DISTINCT FROM 'passed'
    OR NEW.request->>'subject_digest' IS DISTINCT FROM evidence.payload->>'subject_digest'
    OR NEW.request->>'verification_request_id' IS DISTINCT FROM evidence.request_id
    OR NEW.request->>'verification_profile_id' IS DISTINCT FROM evidence.payload->>'profile_id'
    OR NEW.request->>'verification_profile_digest' IS DISTINCT FROM evidence.payload->>'profile_digest'
    OR e.organization_id<>NEW.organization_id OR e.type<>'product.release.retry-authorized' OR e.actor_type<>'system' OR e.actor_id<>'goal_runner'
    OR e.correlation_id IS DISTINCT FROM NEW.id OR e.goal_id IS DISTINCT FROM NEW.goal_id OR e.project_id IS DISTINCT FROM NEW.project_id OR e.run_id IS DISTINCT FROM NEW.run_id
    OR e.payload IS DISTINCT FROM jsonb_build_object('release_id',NEW.id,'root_release_id',NEW.root_release_id,'previous_release_id',previous.id,
      'generation',NEW.publication_generation,'source_id',source.source_id,'previous_request_digest',source.request_digest,'previous_receipt_digest',source.receipt_digest,
      'actor_user_id',a.actor_user_id,'previous_retry_count',attempt-1,'attempt_index',attempt,'session',session)
    OR d.organization_id<>NEW.organization_id OR d.computer_id IS DISTINCT FROM NEW.computer_id OR d.trust<>'active' OR d.revoked_at IS NOT NULL
    OR token.organization_id<>NEW.organization_id OR token.device_id<>d.id OR token.kind<>'node' OR token.status<>'active' OR token.revoked_at IS NOT NULL
    OR (token.expires_at IS NOT NULL AND token.expires_at<=NEW.created_at)
    THEN RAISE EXCEPTION 'Publication retry differs from its latest settled source, original authorization or goal budget'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER product_release_attempts_protected BEFORE INSERT OR UPDATE OR DELETE ON product_releases
  FOR EACH ROW EXECUTE FUNCTION protect_product_release_attempt_v1();
