-- Opt-in H2 revision successors. Existing research, imports and reviews retain their identities.
-- Extend only new-request admission. The existing immutable-grant trigger stays
-- unchanged, so an older goal cannot acquire revision authority after creation.
ALTER TABLE goal_automations DROP CONSTRAINT goal_automations_source_handoff_chk;
ALTER TABLE goal_automations ADD CONSTRAINT goal_automations_source_handoff_chk CHECK (
  source_handoff IS NULL OR (execution_mode='agent_team' AND release_profile_id IS NOT NULL AND source_handoff IN (
    '{"version":1,"mode":"automatic"}'::jsonb,
    '{"version":1,"mode":"automatic","research_revision":{"version":1,"strategy":"configured_pool"}}'::jsonb)) IS TRUE
);
--> statement-breakpoint
-- Match canonicalAutomationWorkspace(root, 'windows') for absolute drive, rooted
-- and UNC paths. Keys are comparisons only; execution retains the advertised root.
CREATE FUNCTION research_windows_workspace_key(root text) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE value text := lower(replace(root,'/',chr(92))); prefix text; component text; parts text[]; stack text[] := ARRAY[]::text[];
BEGIN
  IF value ~ '^[a-z]:' AND substring(value FROM 3 FOR 1)=chr(92) THEN
    prefix := substring(value FROM 1 FOR 3); value := substring(value FROM 4);
  ELSIF substring(value FROM 1 FOR 2)=repeat(chr(92),2) THEN
    parts := regexp_split_to_array(substring(value FROM 3), E'\\\\+');
    IF coalesce(parts[1],'')='' OR coalesce(parts[2],'')='' THEN RAISE EXCEPTION 'research workspace UNC root is incomplete'; END IF;
    prefix := repeat(chr(92),2)||parts[1]||chr(92)||parts[2]||chr(92);
    value := array_to_string(parts[3:cardinality(parts)],chr(92));
  ELSIF substring(value FROM 1 FOR 1)=chr(92) THEN prefix := chr(92); value := substring(value FROM 2);
  ELSE RAISE EXCEPTION 'research workspace must be absolute'; END IF;
  FOREACH component IN ARRAY regexp_split_to_array(coalesce(value,''), E'\\\\+') LOOP
    IF component='' OR component='.' THEN CONTINUE;
    ELSIF component='..' THEN stack := stack[1:greatest(cardinality(stack)-1,0)];
    ELSE stack := array_append(stack,component); END IF;
  END LOOP;
  RETURN prefix||coalesce(array_to_string(stack,chr(92)),'');
END $$;
--> statement-breakpoint
CREATE TABLE goal_research_destination_pools (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id),
  plan_id text NOT NULL REFERENCES plans(id), next_task_id text NOT NULL REFERENCES tasks(id), base_research_task_id text NOT NULL REFERENCES tasks(id),
  actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL,
  source_computer_id text NOT NULL REFERENCES computers(id), source_workspace_root text NOT NULL, max_retries integer NOT NULL,
  snapshot_digest text NOT NULL, snapshot jsonb NOT NULL, current_revision_id text, created_at timestamptz NOT NULL,
  CONSTRAINT research_destination_pool_goal_next_uniq UNIQUE(organization_id,goal_id,plan_id,next_task_id),
  CONSTRAINT research_destination_pool_budget_chk CHECK(max_retries BETWEEN 0 AND 10),
  CONSTRAINT research_destination_pool_digest_chk CHECK(snapshot_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_research_destination_slots (
  id text PRIMARY KEY, pool_id text NOT NULL REFERENCES goal_research_destination_pools(id), organization_id text NOT NULL REFERENCES organizations(id),
  slot_index integer NOT NULL, computer_id text NOT NULL REFERENCES computers(id), workspace_root text NOT NULL, workspace_key text NOT NULL,
  mapping_digest text NOT NULL, descriptor jsonb NOT NULL, writer_instance_id text NOT NULL REFERENCES agent_instances(id),
  reviewer_instance_id text NOT NULL REFERENCES agent_instances(id), status text NOT NULL DEFAULT 'reserved',
  handoff_id text REFERENCES goal_product_handoffs(id), revision_id text, created_at timestamptz NOT NULL,
  CONSTRAINT research_destination_slot_index_uniq UNIQUE(pool_id,slot_index),
  CONSTRAINT research_destination_slot_root_uniq UNIQUE(organization_id,computer_id,workspace_key),
  CONSTRAINT research_destination_slot_handoff_uniq UNIQUE(handoff_id), CONSTRAINT research_destination_slot_revision_uniq UNIQUE(revision_id),
  CONSTRAINT research_destination_slot_state_chk CHECK(status IN ('reserved','consumed','uncertain') AND slot_index BETWEEN 0 AND 10),
  CONSTRAINT research_destination_slot_digest_chk CHECK(mapping_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE goal_research_revisions (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), goal_id text NOT NULL REFERENCES goals(id),
  plan_id text NOT NULL REFERENCES plans(id), next_task_id text NOT NULL REFERENCES tasks(id), base_research_task_id text NOT NULL REFERENCES tasks(id),
  auxiliary_task_id text NOT NULL REFERENCES tasks(id), parent_review_id text NOT NULL REFERENCES goal_imported_product_reviews(id),
  predecessor_revision_id text REFERENCES goal_research_revisions(id), pool_id text NOT NULL REFERENCES goal_research_destination_pools(id),
  slot_id text NOT NULL REFERENCES goal_research_destination_slots(id), generation integer NOT NULL, attempt_index integer NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL,
  authorization_event_id text NOT NULL REFERENCES event_log(id), intent_digest text NOT NULL, intent jsonb NOT NULL,
  handoff_id text REFERENCES goal_product_handoffs(id), created_at timestamptz NOT NULL,
  CONSTRAINT research_revision_parent_uniq UNIQUE(parent_review_id), CONSTRAINT research_revision_auxiliary_uniq UNIQUE(auxiliary_task_id),
  CONSTRAINT research_revision_slot_uniq UNIQUE(slot_id), CONSTRAINT research_revision_handoff_uniq UNIQUE(handoff_id),
  CONSTRAINT research_revision_attempt_uniq UNIQUE(organization_id,goal_id,attempt_index), CONSTRAINT research_revision_generation_uniq UNIQUE(pool_id,generation),
  CONSTRAINT research_revision_generation_chk CHECK(generation BETWEEN 1 AND 10 AND attempt_index >= generation),
  CONSTRAINT research_revision_digest_chk CHECK(intent_digest ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE goal_research_destination_pools ADD CONSTRAINT research_pool_current_revision_fk FOREIGN KEY(current_revision_id) REFERENCES goal_research_revisions(id);
--> statement-breakpoint
ALTER TABLE goal_research_destination_slots ADD CONSTRAINT research_slot_revision_fk FOREIGN KEY(revision_id) REFERENCES goal_research_revisions(id);
--> statement-breakpoint
CREATE FUNCTION protect_research_destination_pool() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a goal_automations; g goals; b tasks; n tasks; r goal_research_revisions;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'research destination pool history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'current_revision_id') IS DISTINCT FROM (to_jsonb(OLD)-'current_revision_id') THEN RAISE EXCEPTION 'research pool snapshot is immutable'; END IF;
    IF NEW.current_revision_id IS NOT DISTINCT FROM OLD.current_revision_id THEN RETURN NEW; END IF;
    SELECT * INTO r FROM goal_research_revisions WHERE id=NEW.current_revision_id;
    IF r.id IS NULL OR r.pool_id<>NEW.id OR r.predecessor_revision_id IS DISTINCT FROM OLD.current_revision_id THEN RAISE EXCEPTION 'research pool must advance to its exact successor'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO a FROM goal_automations WHERE goal_id=NEW.goal_id;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id;
  SELECT * INTO b FROM tasks WHERE id=NEW.base_research_task_id;
  SELECT * INTO n FROM tasks WHERE id=NEW.next_task_id;
  IF a.goal_id IS NULL OR g.id IS NULL OR b.id IS NULL OR n.id IS NULL OR NEW.current_revision_id IS NOT NULL
    OR a.organization_id<>NEW.organization_id OR a.plan_id IS DISTINCT FROM NEW.plan_id OR a.actor_user_id<>NEW.actor_user_id
    OR a.consent_id IS DISTINCT FROM NEW.consent_id OR a.policy_version<>NEW.policy_version OR a.execution_mode<>'agent_team'
    OR (a.source_handoff->'research_revision' = '{"version":1,"strategy":"configured_pool"}'::jsonb) IS NOT TRUE
    OR (g.budgets->>'max_retries')::integer IS DISTINCT FROM NEW.max_retries OR g.current_plan_id IS DISTINCT FROM NEW.plan_id
    OR b.goal_id IS DISTINCT FROM g.id OR b.source_plan_id IS DISTINCT FROM NEW.plan_id OR b.source_plan_spec_ref IS DISTINCT FROM '0' OR b.status<>'done'
    OR n.goal_id IS DISTINCT FROM g.id OR n.source_plan_id IS DISTINCT FROM NEW.plan_id OR n.source_plan_spec_ref IS DISTINCT FROM '1' OR n.status<>'ready'
    OR (NEW.snapshot->>'goal_id'=NEW.goal_id AND NEW.snapshot->>'plan_id'=NEW.plan_id
      AND NEW.snapshot->>'next_task_id'=NEW.next_task_id AND NEW.snapshot->>'base_research_task_id'=NEW.base_research_task_id
      AND NEW.snapshot->>'actor_user_id'=NEW.actor_user_id AND NEW.snapshot->>'policy_version'=NEW.policy_version
      AND NEW.snapshot->'source'->>'computer_id'=NEW.source_computer_id AND NEW.snapshot->'source'->>'workspace_root'=NEW.source_workspace_root
      AND NEW.snapshot->>'max_retries'=NEW.max_retries::text AND jsonb_array_length(NEW.snapshot->'members')=NEW.max_retries+1) IS NOT TRUE
    OR NEW.snapshot->>'consent_id' IS DISTINCT FROM NEW.consent_id THEN RAISE EXCEPTION 'research pool differs from its original explicit goal grant'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER research_destination_pool_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_research_destination_pools FOR EACH ROW EXECUTE FUNCTION protect_research_destination_pool();
--> statement-breakpoint
CREATE FUNCTION protect_research_destination_slot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p goal_research_destination_pools; h goal_product_handoffs; r goal_research_revisions;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'research destination reservation is retained'; END IF;
  SELECT * INTO p FROM goal_research_destination_pools WHERE id=NEW.pool_id;
  IF p.id IS NULL OR p.organization_id<>NEW.organization_id OR NEW.slot_index>p.max_retries
    OR NEW.descriptor IS DISTINCT FROM p.snapshot->'members'->NEW.slot_index
    OR (NEW.descriptor->>'slot_id'=NEW.id AND NEW.descriptor->>'index'=NEW.slot_index::text
      AND p.snapshot->'destination'->>'computer_id'=NEW.computer_id
      AND NEW.descriptor->'mapping'->'destination_release'->'binding'->>'workspace_root'=NEW.workspace_root
      AND NEW.descriptor->'writer'->>'instance_id'=NEW.writer_instance_id AND NEW.descriptor->'reviewer'->>'instance_id'=NEW.reviewer_instance_id) IS NOT TRUE
    OR NEW.workspace_key<>research_windows_workspace_key(NEW.workspace_root) THEN RAISE EXCEPTION 'research slot differs from its frozen pool'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['status','handoff_id','revision_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','handoff_id','revision_id'])
      OR OLD.handoff_id IS NOT NULL AND NEW.handoff_id IS DISTINCT FROM OLD.handoff_id
      OR OLD.revision_id IS NOT NULL AND NEW.revision_id IS DISTINCT FROM OLD.revision_id
      OR OLD.status='uncertain' AND NEW.status<>'uncertain' OR OLD.status='consumed' AND NEW.status='reserved'
      THEN RAISE EXCEPTION 'research slot ownership cannot be replaced or reset'; END IF;
  ELSIF NEW.status<>'reserved' OR NEW.handoff_id IS NOT NULL OR NEW.revision_id IS NOT NULL THEN RAISE EXCEPTION 'research slots start as empty reservations'; END IF;
  IF NEW.revision_id IS NOT NULL THEN
    SELECT * INTO r FROM goal_research_revisions WHERE id=NEW.revision_id;
    IF r.id IS NULL OR r.slot_id<>NEW.id OR r.pool_id<>NEW.pool_id THEN RAISE EXCEPTION 'research slot revision differs'; END IF;
  END IF;
  IF NEW.handoff_id IS NOT NULL THEN
    SELECT * INTO h FROM goal_product_handoffs WHERE id=NEW.handoff_id;
    IF h.id IS NULL OR h.goal_id<>p.goal_id OR h.plan_id<>p.plan_id OR h.next_task_id<>p.next_task_id OR h.organization_id<>p.organization_id
      OR (h.intent->'request'->'byte_request'->'destination'->>'workspace_root'=NEW.workspace_root
        AND h.intent->'request'->'byte_request'->'destination'->>'node_id'=NEW.computer_id) IS NOT TRUE
      OR NEW.status='reserved' THEN RAISE EXCEPTION 'research slot handoff differs'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER research_destination_slot_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_research_destination_slots FOR EACH ROW EXECUTE FUNCTION protect_research_destination_slot();
--> statement-breakpoint
CREATE FUNCTION protect_goal_research_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p goal_research_destination_pools; s goal_research_destination_slots; h goal_imported_product_reviews; a tasks; g goals; e event_log; prior goal_research_revisions; target goal_product_handoffs;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'research revision history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'handoff_id') IS DISTINCT FROM (to_jsonb(OLD)-'handoff_id') OR OLD.handoff_id IS NOT NULL AND NEW.handoff_id IS DISTINCT FROM OLD.handoff_id
      THEN RAISE EXCEPTION 'research revision intent is immutable'; END IF;
    IF NEW.handoff_id IS NOT NULL THEN
      SELECT * INTO target FROM goal_product_handoffs WHERE id=NEW.handoff_id;
      IF target.id IS NULL OR target.goal_id<>NEW.goal_id OR target.plan_id<>NEW.plan_id OR target.next_task_id<>NEW.next_task_id
        OR target.intent->'request'->'byte_request'->'source'->>'task_id' IS DISTINCT FROM NEW.auxiliary_task_id THEN RAISE EXCEPTION 'research revision handoff is unrelated'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO p FROM goal_research_destination_pools WHERE id=NEW.pool_id;
  SELECT * INTO s FROM goal_research_destination_slots WHERE id=NEW.slot_id;
  SELECT * INTO h FROM goal_imported_product_reviews WHERE id=NEW.parent_review_id;
  SELECT * INTO a FROM tasks WHERE id=NEW.auxiliary_task_id;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id;
  SELECT * INTO e FROM event_log WHERE id=NEW.authorization_event_id;
  IF NEW.predecessor_revision_id IS NOT NULL THEN SELECT * INTO prior FROM goal_research_revisions WHERE id=NEW.predecessor_revision_id; END IF;
  IF p.id IS NULL OR s.id IS NULL OR h.id IS NULL OR a.id IS NULL OR g.id IS NULL OR e.id IS NULL OR NEW.handoff_id IS NOT NULL
    OR p.organization_id<>NEW.organization_id OR p.goal_id<>NEW.goal_id OR p.plan_id<>NEW.plan_id OR p.next_task_id<>NEW.next_task_id
    OR p.base_research_task_id<>NEW.base_research_task_id OR p.actor_user_id<>NEW.actor_user_id OR p.consent_id IS DISTINCT FROM NEW.consent_id OR p.policy_version<>NEW.policy_version
    OR p.current_revision_id IS DISTINCT FROM NEW.predecessor_revision_id OR s.pool_id<>p.id OR s.slot_index<>NEW.generation OR s.status<>'reserved' OR s.revision_id IS NOT NULL OR s.handoff_id IS NOT NULL
    OR h.goal_id<>NEW.goal_id OR h.plan_id<>NEW.plan_id OR h.next_task_id<>NEW.next_task_id OR h.stop_requested
    OR (h.result->>'outcome'='reviewed' AND h.result->'closed'='true'::jsonb AND h.result->'verdict'->>'outcome'='changes_requested') IS NOT TRUE
    OR (NEW.predecessor_revision_id IS NULL AND (NEW.generation<>1 OR NOT EXISTS(SELECT 1 FROM goal_research_destination_slots WHERE pool_id=p.id AND slot_index=0 AND handoff_id=h.handoff_id)))
    OR (NEW.predecessor_revision_id IS NOT NULL AND (prior.id IS NULL OR prior.pool_id<>p.id OR prior.handoff_id IS DISTINCT FROM h.handoff_id OR prior.generation+1<>NEW.generation))
    OR a.organization_id<>NEW.organization_id OR a.goal_id IS DISTINCT FROM NEW.goal_id OR a.parent_task_id IS DISTINCT FROM NEW.base_research_task_id OR a.execution_policy_task_id IS DISTINCT FROM NEW.base_research_task_id
    OR a.source_plan_id IS NOT NULL OR a.source_plan_spec_ref IS NOT NULL OR a.status<>'ready' OR g.retry_count<>NEW.attempt_index
    OR e.type<>'goal.research-revision.authorized' OR e.actor_type<>'system' OR e.actor_id IS DISTINCT FROM 'goal_runner'
    OR e.goal_id IS DISTINCT FROM NEW.goal_id OR e.task_id IS DISTINCT FROM a.id OR e.organization_id<>NEW.organization_id
    OR (NEW.intent->>'revision_id'=NEW.id AND NEW.intent->>'auxiliary_task_id'=a.id AND NEW.intent->>'pool_id'=p.id
      AND NEW.intent->>'slot_id'=s.id AND NEW.intent->'parent_review'->>'review_id'=h.id AND NEW.intent->>'authorization_event_id'=e.id
      AND NEW.intent->>'attempt_index'=NEW.attempt_index::text AND NEW.intent->>'generation'=NEW.generation::text
      AND NEW.intent->'execution_authorized'='false'::jsonb) IS NOT TRUE
    THEN RAISE EXCEPTION 'research revision lacks its exact parent, budget or auxiliary authority'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER goal_research_revision_protected BEFORE INSERT OR UPDATE OR DELETE ON goal_research_revisions FOR EACH ROW EXECUTE FUNCTION protect_goal_research_revision();
