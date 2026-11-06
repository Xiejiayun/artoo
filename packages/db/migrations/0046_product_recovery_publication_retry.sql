-- Retry the fresh H9 publication only after its own settled failure. The original
-- recovery lineage stays on the root; the goal-wide sequence and wire retry sequence differ.
ALTER TABLE product_releases DROP CONSTRAINT product_releases_lineage_chk;
--> statement-breakpoint
ALTER TABLE product_releases ADD CONSTRAINT product_releases_lineage_chk CHECK(
  (((publication_generation=0 AND root_release_id IS NULL AND retry_of_release_id IS NULL AND retry_authorization_event_id IS NULL)
    OR (publication_generation>0 AND root_release_id IS NOT NULL AND retry_of_release_id IS NOT NULL AND retry_authorization_event_id IS NOT NULL))
    AND recovery_id IS NULL AND recovery_of_release_id IS NULL AND recovery_authorization_event_id IS NULL)
  OR (recovery_id IS NOT NULL AND recovery_authorization_event_id IS NOT NULL AND root_release_id IS NULL
    AND retry_of_release_id IS NULL AND retry_authorization_event_id IS NULL
    AND ((publication_generation=0 AND recovery_of_release_id IS NULL) OR (publication_generation>0 AND recovery_of_release_id IS NOT NULL)))
  OR (publication_generation>0 AND recovery_id IS NOT NULL AND root_release_id IS NOT NULL
    AND retry_of_release_id IS NOT NULL AND retry_authorization_event_id IS NOT NULL
    AND recovery_of_release_id IS NULL AND recovery_authorization_event_id IS NULL));
--> statement-breakpoint
CREATE FUNCTION assert_product_release_recovery_retry_v1(candidate product_releases) RETURNS void LANGUAGE plpgsql AS $$
DECLARE root product_releases; publication goal_recovery_validation_publications; origin jsonb;
BEGIN
  SELECT * INTO root FROM product_releases WHERE id=candidate.root_release_id;
  SELECT * INTO publication FROM goal_recovery_validation_publications WHERE release_id=root.id;
  origin:=candidate.request->'imported_recovery';
  IF root.id IS NULL OR publication.release_id IS NULL OR candidate.recovery_id IS NULL OR origin IS NULL
    OR root.status NOT IN ('failed','rolled_back') OR root.receipt IS NULL OR root.request ? 'retry'
    OR root.root_release_id IS NOT NULL OR root.retry_of_release_id IS NOT NULL OR root.retry_authorization_event_id IS NOT NULL
    OR root.recovery_id IS DISTINCT FROM candidate.recovery_id OR root.recovery_authorization_event_id IS NULL
    OR root.recovery_authorization_event_id IS DISTINCT FROM origin->'authorization'->>'event_id'
    OR root.recovery_of_release_id IS DISTINCT FROM origin->>'recovery_of_release_id'
    OR candidate.recovery_of_release_id IS NOT NULL OR candidate.recovery_authorization_event_id IS NOT NULL
    OR root.organization_id<>candidate.organization_id OR root.goal_id<>candidate.goal_id OR root.project_id<>candidate.project_id
    OR root.computer_id<>candidate.computer_id OR root.run_id<>candidate.run_id OR root.evidence_id<>candidate.evidence_id
    OR (candidate.request-'release_id'-'retry') IS DISTINCT FROM (root.request-'release_id'-'retry')
    OR publication.organization_id<>candidate.organization_id OR publication.recovery_id<>candidate.recovery_id
    OR publication.origin IS DISTINCT FROM origin OR publication.run_id<>candidate.run_id OR publication.evidence_id<>candidate.evidence_id
    OR candidate.request->'retry'->>'root_release_id' IS DISTINCT FROM root.id
    OR candidate.request->'retry'->>'previous_release_id' IS DISTINCT FROM candidate.retry_of_release_id
    OR candidate.request->'retry'->'authorization'->>'event_id' IS DISTINCT FROM candidate.retry_authorization_event_id
    OR candidate.request->'retry'->'authorization'->>'actor_user_id' IS DISTINCT FROM origin->'authorization'->>'actor_user_id'
    OR candidate.retry_authorization_event_id IS NOT DISTINCT FROM root.recovery_authorization_event_id
    OR ((candidate.request->'retry'->'authorization'->>'attempt_index')::integer > (origin->'authorization'->>'attempt_index')::integer) IS NOT TRUE
    THEN RAISE EXCEPTION 'Recovered publication retry requires its immutable fresh root, accepted source and separate retry decision'; END IF;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_product_release_attempt_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous product_releases%ROWTYPE; source product_release_retry_sources%ROWTYPE; g goals%ROWTYPE;
  a goal_automations%ROWTYPE; plan plans%ROWTYPE; r runs%ROWTYPE; evidence run_evidence%ROWTYPE;
  e event_log%ROWTYPE; d devices%ROWTYPE; token device_tokens%ROWTYPE; retry jsonb; retry_authorization jsonb; session jsonb; attempt integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Publication attempts are immutable history'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.organization_id,NEW.goal_id,NEW.project_id,NEW.computer_id,NEW.run_id,NEW.evidence_id,NEW.request,NEW.created_at,
      NEW.publication_generation,NEW.root_release_id,NEW.retry_of_release_id,NEW.retry_authorization_event_id,NEW.recovery_id,NEW.recovery_of_release_id,NEW.recovery_authorization_event_id)
      IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.goal_id,OLD.project_id,OLD.computer_id,OLD.run_id,OLD.evidence_id,OLD.request,OLD.created_at,
      OLD.publication_generation,OLD.root_release_id,OLD.retry_of_release_id,OLD.retry_authorization_event_id,OLD.recovery_id,OLD.recovery_of_release_id,OLD.recovery_authorization_event_id)
      THEN RAISE EXCEPTION 'Publication identity, request and retry lineage are immutable'; END IF;
    IF OLD.status='queued' AND NEW.status='interrupted' THEN
      PERFORM assert_product_release_interruption_v1(OLD,NEW); RETURN NEW;
    END IF;
    IF ROW(NEW.interrupted_recovery_id,NEW.interruption_event_id,NEW.interruption_checkpoint_digest)
      IS DISTINCT FROM ROW(OLD.interrupted_recovery_id,OLD.interruption_event_id,OLD.interruption_checkpoint_digest)
      THEN RAISE EXCEPTION 'Publication interruption provenance is immutable'; END IF;
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
  IF (NEW.recovery_id IS NOT NULL OR NEW.request ? 'imported_recovery') AND NOT (NEW.request ? 'retry') THEN
    PERFORM assert_product_release_recovery_v1(NEW); RETURN NEW;
  END IF;
  IF NEW.publication_generation=0 THEN
    IF NEW.request ? 'retry' THEN RAISE EXCEPTION 'An initial publication cannot carry retry authority'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.recovery_id IS NOT NULL OR NEW.request ? 'imported_recovery' THEN
    PERFORM assert_product_release_recovery_retry_v1(NEW);
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
      'generation',COALESCE((previous.request->'retry'->>'generation')::integer,0)+1,'source_id',source.source_id,'previous_request_digest',source.request_digest,'previous_receipt_digest',source.receipt_digest,
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
      'generation',COALESCE((previous.request->'retry'->>'generation')::integer,0)+1,'source_id',source.source_id,'previous_request_digest',source.request_digest,'previous_receipt_digest',source.receipt_digest,
      'actor_user_id',a.actor_user_id,'previous_retry_count',attempt-1,'attempt_index',attempt,'session',session)
    OR d.organization_id<>NEW.organization_id OR d.computer_id IS DISTINCT FROM NEW.computer_id OR d.trust<>'active' OR d.revoked_at IS NOT NULL
    OR token.organization_id<>NEW.organization_id OR token.device_id<>d.id OR token.kind<>'node' OR token.status<>'active' OR token.revoked_at IS NOT NULL
    OR (token.expires_at IS NOT NULL AND token.expires_at<=NEW.created_at)
    THEN RAISE EXCEPTION 'Publication retry differs from its latest settled source, original authorization or goal budget'; END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_recovery_validation_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x goal_recovery_validations; h goal_recovery_validation_reviews; c goal_recovery_validation_completions;
  p goal_recovery_validation_review_receipts; rel product_releases; r runs; e run_evidence; v event_log; g goals; plan plans;
  checkpoint goal_source_recovery_checkpoints;
  source jsonb; caps jsonb; summary jsonb; criteria jsonb; expected_origin jsonb; expected_binding jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'H9 publication origin is immutable'; END IF;
  SELECT * INTO x FROM goal_recovery_validations WHERE id=NEW.validation_id;
  SELECT * INTO h FROM goal_recovery_validation_reviews WHERE id=NEW.review_id;
  SELECT * INTO c FROM goal_recovery_validation_completions WHERE validation_id=x.id;
  SELECT * INTO p FROM goal_recovery_validation_review_receipts WHERE review_id=h.id;
  SELECT * INTO rel FROM product_releases WHERE id=NEW.release_id; SELECT * INTO r FROM runs WHERE id=NEW.run_id;
  SELECT * INTO e FROM run_evidence WHERE id=NEW.evidence_id; SELECT * INTO v FROM event_log WHERE id=NEW.acceptance_event_id;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id FOR UPDATE; SELECT * INTO plan FROM plans WHERE id=NEW.plan_id;
  SELECT * INTO checkpoint FROM goal_source_recovery_checkpoints WHERE recovery_id=NEW.recovery_id;
  source:=recovery_validation_source(x.id);
  IF rel.request ? 'retry' THEN PERFORM assert_product_release_recovery_retry_v1(rel);
  ELSE PERFORM assert_product_release_recovery_v1(rel); END IF;
  caps:=x.request->'origin'->'execution_request'->'review_request'->'continuation_request'->'review_request'->'operation'->'intent'->'request'->'measurement_v2'->'destination_release';
  summary:=e.payload->'measurement_plan';
  expected_origin:=jsonb_build_object('version',1,'recovery_id',NEW.recovery_id,'checkpoint_digest',checkpoint.checkpoint_digest,'validation_id',x.id,'validation_request_digest',x.request_digest,'validation_result_digest',x.result_digest,
    'review_id',h.id,'review_request_digest',h.request_digest,'review_result_digest',h.result_digest,'acceptance_event_id',h.acceptance_event_id,'subject_digest',source->>'subject_digest','recovery_of_release_id',rel.request->'imported_recovery'->'recovery_of_release_id','authorization',rel.request->'imported_recovery'->'authorization');
  IF checkpoint.recovery_id IS NULL OR x.recovery_id<>NEW.recovery_id OR h.recovery_id<>NEW.recovery_id OR rel.recovery_id<>NEW.recovery_id OR x.id IS NULL OR h.id IS NULL OR c.validation_id IS NULL OR p.review_id IS NULL OR rel.id IS NULL OR r.id IS NULL OR e.id IS NULL OR v.id IS NULL OR g.id IS NULL OR plan.id IS NULL
    OR x.organization_id<>NEW.organization_id OR x.goal_id<>NEW.goal_id OR x.plan_id<>NEW.plan_id OR x.origin_review_id<>NEW.origin_review_id
    OR x.run_id<>NEW.run_id OR x.computer_id<>NEW.computer_id OR x.ready_kind<>'review' OR c.outcome<>'verified' OR c.evidence_id IS DISTINCT FROM NEW.evidence_id
    OR c.source_digest<>NEW.source_digest OR h.validation_id<>x.id OR h.source_digest<>NEW.source_digest OR h.request->'source' IS DISTINCT FROM source
    OR h.organization_id<>NEW.organization_id OR h.goal_id<>NEW.goal_id OR h.plan_id<>NEW.plan_id OR h.task_id<>x.task_id
    OR h.stop_requested OR h.accepted_at IS NULL OR h.acceptance_event_id IS DISTINCT FROM NEW.acceptance_event_id
    OR (h.result->>'outcome'='reviewed' AND h.result->'closed'='true'::jsonb AND h.result->'verdict'->>'outcome'='accepted') IS NOT TRUE
    OR h.author_instance_id<>x.writer_instance_id OR h.author_agent_id<>x.writer_agent_id
    OR p.result_digest IS DISTINCT FROM h.result_digest OR p.request_digest<>h.request_digest
    OR EXISTS(SELECT 1 FROM goal_recovery_validation_reviews WHERE validation_id=x.id AND sequence>h.sequence)
    OR r.organization_id<>NEW.organization_id OR r.status<>'completed' OR r.computer_id<>NEW.computer_id OR r.workspace_root IS DISTINCT FROM x.workspace_root
    OR e.organization_id<>NEW.organization_id OR e.run_id<>r.id OR e.payload IS DISTINCT FROM source->'verification' OR e.payload->>'outcome' IS DISTINCT FROM 'passed'
    OR e.payload->>'subject_digest' IS DISTINCT FROM source->>'subject_digest'
    OR v.organization_id<>NEW.organization_id OR v.type<>'goal.recovery-validation-review.accepted' OR v.actor_type<>'system' OR v.actor_id<>'goal_runner'
    OR v.goal_id IS DISTINCT FROM NEW.goal_id OR v.task_id IS DISTINCT FROM x.task_id OR v.run_id IS DISTINCT FROM r.id
    OR v.payload->>'review_id' IS DISTINCT FROM h.id OR v.payload->>'validation_id' IS DISTINCT FROM x.id
    OR v.payload->>'result_digest' IS DISTINCT FROM h.result_digest OR v.payload->>'source_digest' IS DISTINCT FROM NEW.source_digest
    OR v.payload->>'subject_digest' IS DISTINCT FROM source->>'subject_digest' OR v.payload->>'verification_evidence_id' IS DISTINCT FROM e.id
    OR v.payload->>'actor_user_id' IS DISTINCT FROM x.actor_user_id OR v.payload->'publication_authorized' IS DISTINCT FROM 'false'::jsonb
    OR g.organization_id<>NEW.organization_id OR g.status<>'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id
    OR plan.organization_id<>NEW.organization_id OR plan.goal_id<>NEW.goal_id
    OR EXISTS(SELECT 1 FROM tasks WHERE organization_id=NEW.organization_id AND goal_id=NEW.goal_id AND source_plan_id=NEW.plan_id AND status<>'done')
    OR rel.organization_id<>NEW.organization_id OR rel.goal_id<>NEW.goal_id OR rel.run_id<>NEW.run_id OR rel.evidence_id<>NEW.evidence_id OR rel.computer_id<>NEW.computer_id OR rel.status<>'queued'
    OR NEW.origin IS DISTINCT FROM expected_origin OR rel.request->'imported_recovery' IS DISTINCT FROM expected_origin
    OR caps IS NULL OR NEW.capabilities IS DISTINCT FROM caps OR r.verification_requirement->>'profile_id' IS DISTINCT FROM caps->'binding'->>'verification_profile_id'
    OR caps->'binding'->>'workspace_root' IS DISTINCT FROM x.workspace_root OR caps->'binding'->>'project_id' IS DISTINCT FROM rel.project_id
    OR x.request->'run_start'->'context_pack'->'payload'->'release_capabilities' IS DISTINCT FROM caps
    OR (summary->'version'='2'::jsonb AND summary->>'scope'='final' AND jsonb_typeof(summary->'pending_release')='array' AND jsonb_array_length(summary->'pending_release')>0) IS NOT TRUE
    OR rel.request->>'release_id' IS DISTINCT FROM NEW.release_id OR rel.request->>'goal_id' IS DISTINCT FROM NEW.goal_id OR rel.request->>'project_id' IS DISTINCT FROM rel.project_id
    OR rel.request->>'run_id' IS DISTINCT FROM r.id OR rel.request->>'subject_digest' IS DISTINCT FROM source->>'subject_digest'
    OR rel.request->>'verification_request_id' IS DISTINCT FROM e.request_id OR rel.request->>'verification_profile_id' IS DISTINCT FROM e.payload->>'profile_id'
    OR rel.request->>'verification_profile_digest' IS DISTINCT FROM e.payload->>'profile_digest' OR rel.request->>'release_profile_id' IS DISTINCT FROM caps->'binding'->>'release_profile_id'
    THEN RAISE EXCEPTION 'H9 publication differs from current accepted final product and original destination'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(summary->'pending_release') item WHERE item->'release_binding' IS DISTINCT FROM caps->'binding')
    THEN RAISE EXCEPTION 'H9 publication changed its destination release obligations'; END IF;
  SELECT jsonb_agg(jsonb_build_object('requirement_id',item->'requirement_id','criterion_index',item->'criterion_index',
    'criterion_digest',item->'criterion_digest','claim_id',item->'claim_id') ORDER BY ordinal)
    INTO criteria FROM jsonb_array_elements(summary->'pending_release') WITH ORDINALITY AS entries(item,ordinal);
  expected_binding:=jsonb_build_object('version',1,'plan',jsonb_build_object('id',plan.id,'version',plan.version),'research',summary->'research',
    'measurement_plan_digest',summary->'measurement_plan_digest','release_binding',caps->'binding','criteria',criteria);
  IF rel.request->'acceptance_binding' IS DISTINCT FROM expected_binding
    THEN RAISE EXCEPTION 'H9 publication changed its exact accepted research and measurement obligations'; END IF;
  RETURN NEW;
END $$;
