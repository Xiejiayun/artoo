-- Preserve the existing local-policy null grant without accepting an omitted field.
-- Existing authorization history, live external-consent checks and every other fence remain exact.
CREATE OR REPLACE FUNCTION protect_goal_source_recovery_v1() RETURNS trigger LANGUAGE plpgsql AS $$
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
      AND NEW.request->'authorization'->>'actor_user_id'=NEW.actor_user_id AND NEW.request->'authorization'->'consent_id'=COALESCE(to_jsonb(NEW.consent_id),'null'::jsonb)
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
