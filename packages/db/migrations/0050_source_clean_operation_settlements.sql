CREATE TABLE source_clean_operation_settlements (
  id text PRIMARY KEY, generation_id text NOT NULL REFERENCES source_clean_generations(id),
  organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id), computer_id text NOT NULL REFERENCES computers(id),
  kind text NOT NULL, operation_id text NOT NULL, request_digest text NOT NULL, run_id text REFERENCES runs(id),
  event_id text NOT NULL REFERENCES event_log(id), created_at timestamptz NOT NULL,
  CONSTRAINT source_clean_operation_settlement_uniq UNIQUE(organization_id,kind,operation_id),
  CONSTRAINT source_clean_operation_settlement_kind_chk CHECK((kind='validation' AND run_id IS NOT NULL) OR (kind IN ('validation_review','release') AND run_id IS NULL)),
  CONSTRAINT source_clean_operation_settlement_digest_chk CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE FUNCTION protect_source_clean_operation_settlement_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g source_clean_generations; s source_clean_stops; e event_log; operation jsonb; reference jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Clean operation settlement history is immutable'; END IF;
  SELECT * INTO g FROM source_clean_generations WHERE id=NEW.generation_id;
  SELECT * INTO s FROM source_clean_stops WHERE id=g.predecessor_stop_id;
  SELECT * INTO e FROM event_log WHERE id=NEW.event_id;
  SELECT item INTO reference FROM jsonb_array_elements(s.intent->'operations') item
    WHERE item->>'kind'=NEW.kind AND item->>'operation_id'=NEW.operation_id;
  IF NEW.kind='validation' THEN SELECT to_jsonb(v) INTO operation FROM goal_imported_validations v WHERE id=NEW.operation_id;
  ELSIF NEW.kind='validation_review' THEN SELECT to_jsonb(v) INTO operation FROM goal_imported_validation_reviews v WHERE id=NEW.operation_id;
  ELSE SELECT to_jsonb(v) INTO operation FROM product_releases v WHERE id=NEW.operation_id; END IF;
  IF g.id IS NULL OR s.id IS NULL OR e.id IS NULL OR reference IS NULL OR operation IS NULL OR g.checkpoint IS NULL OR g.receipt IS NULL
    OR g.organization_id<>NEW.organization_id OR s.organization_id<>NEW.organization_id OR s.closure IS NULL OR s.receipt IS NULL
    OR g."grant"->'predecessor' IS DISTINCT FROM s.receipt OR g."grant"->>'goal_id' IS DISTINCT FROM NEW.goal_id
    OR g."grant"->'stable'->>'node_id' IS DISTINCT FROM NEW.computer_id
    OR g.checkpoint_digest IS DISTINCT FROM artoo_release_retry_digest_v1(g.checkpoint)
    OR g.receipt->>'checkpoint_digest' IS DISTINCT FROM g.checkpoint_digest
    OR reference->>'request_digest' IS DISTINCT FROM NEW.request_digest OR reference->>'run_id' IS DISTINCT FROM NEW.run_id
    OR operation->>'organization_id' IS DISTINCT FROM NEW.organization_id OR operation->>'goal_id' IS DISTINCT FROM NEW.goal_id
    OR operation->>'computer_id' IS DISTINCT FROM NEW.computer_id
    OR NEW.request_digest IS DISTINCT FROM artoo_release_retry_digest_v1(operation->'request')
    OR NEW.kind='validation' AND operation->>'run_id' IS DISTINCT FROM NEW.run_id
    OR e.organization_id<>NEW.organization_id OR e.type<>'goal.source-clean-restart.settled' OR e.actor_type<>'system' OR e.actor_id<>'goal_runner'
    OR e.goal_id IS DISTINCT FROM NEW.goal_id OR e.payload->>'generation_id' IS DISTINCT FROM g.id
    OR e.payload->>'checkpoint_digest' IS DISTINCT FROM g.checkpoint_digest OR e.payload->>'source_state' IS DISTINCT FROM 'unverified'
    OR e.payload->>'actor_user_id' IS DISTINCT FROM g."grant"->'authorization'->>'actor_user_id'
    OR e.payload->'publication_authorized' IS DISTINCT FROM 'false'::jsonb
    THEN RAISE EXCEPTION 'Clean operation settlement lacks exact committed closure, checkpoint and original operation'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER source_clean_operation_settlements_protected BEFORE INSERT OR UPDATE OR DELETE ON source_clean_operation_settlements
  FOR EACH ROW EXECUTE FUNCTION protect_source_clean_operation_settlement_v1();
--> statement-breakpoint
CREATE FUNCTION assert_source_clean_generation_settlement_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s source_clean_stops;
BEGIN
  IF NEW.settled_at IS NOT NULL THEN
    SELECT * INTO s FROM source_clean_stops WHERE id=NEW.predecessor_stop_id;
    IF s.id IS NULL OR jsonb_array_length(s.intent->'operations')<>(SELECT count(*) FROM source_clean_operation_settlements WHERE generation_id=NEW.id)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.intent->'operations') item WHERE NOT EXISTS(
        SELECT 1 FROM source_clean_operation_settlements o WHERE o.generation_id=NEW.id AND o.organization_id=NEW.organization_id
          AND o.event_id=NEW.settlement_event_id AND o.kind=item->>'kind' AND o.operation_id=item->>'operation_id'
          AND o.request_digest=item->>'request_digest' AND o.run_id IS NOT DISTINCT FROM item->>'run_id'))
      THEN RAISE EXCEPTION 'Clean generation settlement requires its complete exact old operation set'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER source_clean_generation_settlement_complete BEFORE UPDATE ON source_clean_generations
  FOR EACH ROW EXECUTE FUNCTION assert_source_clean_generation_settlement_v1();
