CREATE TABLE product_design_revisions (
  id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
  goal_id text NOT NULL REFERENCES goals(id), plan_id text NOT NULL REFERENCES plans(id), project_id text NOT NULL REFERENCES projects(id),
  design_task_id text NOT NULL REFERENCES tasks(id), requesting_review_id text NOT NULL REFERENCES autonomous_reviews(id),
  author_instance_id text NOT NULL REFERENCES agent_instances(id), computer_id text NOT NULL REFERENCES computers(id), workspace_root text NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id), consent_id text REFERENCES ai_data_sharing_consents(id), policy_version text NOT NULL,
  sequence integer NOT NULL CHECK(sequence > 0), intent jsonb NOT NULL, state text NOT NULL DEFAULT 'active',
  accepted_run_id text REFERENCES runs(id), accepted_evidence_id text REFERENCES run_evidence(id), accepted_review_id text REFERENCES autonomous_reviews(id),
  created_at timestamptz NOT NULL, accepted_at timestamptz,
  CONSTRAINT product_design_revision_request_uniq UNIQUE(organization_id,requesting_review_id),
  CONSTRAINT product_design_revision_sequence_uniq UNIQUE(organization_id,goal_id,sequence),
  CONSTRAINT product_design_revision_state_chk CHECK(
    (state='active' AND accepted_run_id IS NULL AND accepted_evidence_id IS NULL AND accepted_review_id IS NULL AND accepted_at IS NULL)
    OR (state='accepted' AND accepted_run_id IS NOT NULL AND accepted_evidence_id IS NOT NULL AND accepted_review_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CONSTRAINT product_design_revision_intent_chk CHECK((intent->'version'='1'::jsonb AND intent->>'revision_id'=id
    AND intent->>'goal_id'=goal_id AND intent->>'plan_id'=plan_id AND intent->>'project_id'=project_id AND intent->>'computer_id'=computer_id
    AND intent->>'workspace_root'=workspace_root AND intent->>'design_task_id'=design_task_id AND NOT intent ? 'author_run_id'
    AND intent->'requesting_review'->>'review_id'=requesting_review_id
    AND octet_length(intent->'baseline'->'design'->>'text') BETWEEN 1 AND 1048576
    AND octet_length(intent->'baseline'->'design'->>'text')=(intent->'baseline'->'design'->>'size')::integer) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX product_design_revision_active_uniq ON product_design_revisions(organization_id,goal_id) WHERE state='active';
--> statement-breakpoint
CREATE TABLE product_design_revision_runs (
  run_id text PRIMARY KEY REFERENCES runs(id), revision_id text NOT NULL REFERENCES product_design_revisions(id),
  organization_id text NOT NULL REFERENCES organizations(id), context_pack_id text NOT NULL REFERENCES context_packs(id),
  attempt integer NOT NULL CHECK(attempt>0), descriptor_digest text NOT NULL CHECK(descriptor_digest ~ '^sha256:[a-f0-9]{64}$'), created_at timestamptz NOT NULL,
  CONSTRAINT product_design_revision_attempt_uniq UNIQUE(revision_id,attempt), CONSTRAINT product_design_revision_context_uniq UNIQUE(context_pack_id)
);
--> statement-breakpoint
CREATE FUNCTION protect_product_design_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a goal_automations; g goals; t tasks; q autonomous_reviews; b autonomous_reviews; r runs; e run_evidence;
  tr assistant_turns; m messages; c computers; rb product_design_revision_runs;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'design revision history is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['state','accepted_run_id','accepted_evidence_id','accepted_review_id','accepted_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','accepted_run_id','accepted_evidence_id','accepted_review_id','accepted_at'])
      OR OLD.state<>'active' OR NEW.state<>'accepted' THEN RAISE EXCEPTION 'design revision intent and settlement are immutable'; END IF;
    SELECT * INTO rb FROM product_design_revision_runs WHERE run_id=NEW.accepted_run_id;
    SELECT * INTO r FROM runs WHERE id=NEW.accepted_run_id;
    SELECT * INTO e FROM run_evidence WHERE id=NEW.accepted_evidence_id;
    SELECT * INTO q FROM autonomous_reviews WHERE id=NEW.accepted_review_id;
    SELECT * INTO t FROM tasks WHERE id=NEW.design_task_id;
    IF rb.revision_id IS DISTINCT FROM NEW.id OR r.task_id IS DISTINCT FROM NEW.design_task_id OR r.status IS DISTINCT FROM 'completed'
      OR e.run_id IS DISTINCT FROM r.id OR q.subject_run_id IS DISTINCT FROM r.id OR q.evidence_id IS DISTINCT FROM e.id
      OR q.status IS DISTINCT FROM 'accepted' OR t.status IS DISTINCT FROM 'done'
      OR (e.payload->'product_design_revision'->>'revision_id'=NEW.id AND e.payload->>'outcome'='passed') IS NOT TRUE
      OR EXISTS(SELECT 1 FROM product_design_revision_runs WHERE revision_id=NEW.id AND attempt>rb.attempt)
      THEN RAISE EXCEPTION 'design revision settlement differs from its current accepted author'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO a FROM goal_automations WHERE goal_id=NEW.goal_id;
  SELECT * INTO g FROM goals WHERE id=NEW.goal_id;
  SELECT * INTO t FROM tasks WHERE id=NEW.design_task_id;
  SELECT * INTO q FROM autonomous_reviews WHERE id=NEW.requesting_review_id;
  SELECT * INTO b FROM autonomous_reviews WHERE id=NEW.intent->'baseline'->>'review_id';
  SELECT * INTO r FROM runs WHERE id=NEW.intent->'baseline'->>'run_id';
  SELECT * INTO c FROM computers WHERE id=NEW.computer_id;
  SELECT * INTO tr FROM assistant_turns WHERE id=q.turn_id;
  SELECT * INTO m FROM messages WHERE id=tr.response_message_id;
  IF NEW.state<>'active' OR a.organization_id IS DISTINCT FROM NEW.organization_id OR a.execution_mode IS DISTINCT FROM 'agent_team'
    OR a.plan_id IS DISTINCT FROM NEW.plan_id OR a.computer_id IS DISTINCT FROM NEW.computer_id OR a.workspace_root IS DISTINCT FROM NEW.workspace_root
    OR a.actor_user_id IS DISTINCT FROM NEW.actor_user_id OR a.consent_id IS DISTINCT FROM NEW.consent_id OR a.policy_version IS DISTINCT FROM NEW.policy_version
    OR g.status IS DISTINCT FROM 'running' OR g.current_plan_id IS DISTINCT FROM NEW.plan_id OR g.project_id IS DISTINCT FROM NEW.project_id
    OR t.organization_id IS DISTINCT FROM NEW.organization_id OR t.goal_id IS DISTINCT FROM NEW.goal_id OR t.source_plan_id IS DISTINCT FROM NEW.plan_id
    OR t.status IS DISTINCT FROM 'done' OR r.task_id IS DISTINCT FROM t.id OR r.status IS DISTINCT FROM 'completed'
    OR r.agent_instance_id IS DISTINCT FROM NEW.author_instance_id OR r.computer_id IS DISTINCT FROM NEW.computer_id OR r.workspace_root IS DISTINCT FROM NEW.workspace_root
    OR r.workspace_branch IS NOT NULL OR r.workspace_allocation IS NOT NULL OR c.os NOT IN ('win32','windows')
    OR q.organization_id IS DISTINCT FROM NEW.organization_id OR q.goal_id IS DISTINCT FROM NEW.goal_id OR q.status IS DISTINCT FROM 'changes_requested'
    OR q.subject_run_id IS DISTINCT FROM NEW.intent->'requesting_review'->>'subject_run_id'
    OR q.evidence_id IS DISTINCT FROM NEW.intent->'requesting_review'->>'subject_evidence_id'
    OR q.turn_id IS DISTINCT FROM NEW.intent->'requesting_review'->>'turn_id'
    OR tr.run_id IS DISTINCT FROM NEW.intent->'requesting_review'->>'reviewer_run_id'
    OR tr.response_message_id IS DISTINCT FROM NEW.intent->'requesting_review'->>'response_message_id'
    OR tr.status IS DISTINCT FROM 'completed' OR m.run_id IS DISTINCT FROM tr.run_id
    -- Reason is normalized display text, never authority. The server binds the
    -- entire raw response digest; SQL preserves every structured request field.
    OR (((m.body::jsonb)->'design_revision_request') - 'reason'::text) IS DISTINCT FROM ((NEW.intent->'request') - 'reason'::text)
    OR jsonb_typeof((m.body::jsonb)->'design_revision_request'->'reason') IS DISTINCT FROM 'string'
    OR b.subject_run_id IS DISTINCT FROM r.id OR b.status IS DISTINCT FROM 'accepted'
    OR b.evidence_id IS DISTINCT FROM NEW.intent->'baseline'->>'evidence_id'
    OR EXISTS(SELECT 1 FROM goal_imported_design_continuations WHERE goal_id=NEW.goal_id)
    OR EXISTS(SELECT 1 FROM goal_product_handoffs WHERE goal_id=NEW.goal_id)
    OR EXISTS(SELECT 1 FROM product_releases WHERE goal_id=NEW.goal_id)
    THEN RAISE EXCEPTION 'design revision lacks its original local authorization and independently bound request'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER product_design_revisions_protected BEFORE INSERT OR UPDATE OR DELETE ON product_design_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_product_design_revision();
--> statement-breakpoint
CREATE FUNCTION protect_product_design_revision_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d product_design_revisions; r runs; c context_packs;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'design revision run bindings are append-only'; END IF;
  SELECT * INTO d FROM product_design_revisions WHERE id=NEW.revision_id;
  SELECT * INTO r FROM runs WHERE id=NEW.run_id;
  SELECT * INTO c FROM context_packs WHERE id=NEW.context_pack_id;
  IF d.state IS DISTINCT FROM 'active' OR d.organization_id IS DISTINCT FROM NEW.organization_id
    OR r.organization_id IS DISTINCT FROM NEW.organization_id OR r.task_id IS DISTINCT FROM d.design_task_id OR r.agent_instance_id IS DISTINCT FROM d.author_instance_id
    OR r.computer_id IS DISTINCT FROM d.computer_id OR r.workspace_root IS DISTINCT FROM d.workspace_root OR r.status IS DISTINCT FROM 'queued'
    OR r.workspace_branch IS NOT NULL OR r.workspace_allocation IS NOT NULL OR r.owned_result_assignment IS NOT NULL
    OR r.requested_by_user_id IS DISTINCT FROM d.actor_user_id OR r.ai_data_sharing_consent_id IS DISTINCT FROM d.consent_id
    OR r.ai_data_sharing_policy_version IS DISTINCT FROM d.policy_version
    OR r.context_pack_id IS DISTINCT FROM c.id OR c.organization_id IS DISTINCT FROM NEW.organization_id OR c.run_id IS DISTINCT FROM r.id OR c.task_id IS DISTINCT FROM r.task_id
    OR c.payload->'product_design_revision' IS DISTINCT FROM d.intent || jsonb_build_object('author_run_id',r.id)
    THEN RAISE EXCEPTION 'design revision run differs from its exact authorized context'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER product_design_revision_runs_protected BEFORE INSERT OR UPDATE OR DELETE ON product_design_revision_runs
  FOR EACH ROW EXECUTE FUNCTION protect_product_design_revision_run();
