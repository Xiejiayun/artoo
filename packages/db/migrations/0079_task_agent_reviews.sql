CREATE TABLE task_agent_reviews (
  id text PRIMARY KEY, version integer NOT NULL DEFAULT 1,
  organization_id text NOT NULL REFERENCES organizations(id), project_id text NOT NULL REFERENCES projects(id),
  source_task_id text NOT NULL REFERENCES tasks(id), source_run_id text NOT NULL REFERENCES runs(id),
  source_agent_id text NOT NULL REFERENCES agents(id), review_task_id text NOT NULL REFERENCES tasks(id),
  reviewer_agent_id text NOT NULL REFERENCES agents(id), artifacts jsonb NOT NULL,
  source_updated_at timestamptz NOT NULL, source_event_position bigint NOT NULL,
  requested_by_user_id text NOT NULL REFERENCES users(id),
  ai_data_sharing_consent_id text REFERENCES ai_data_sharing_consents(id), ai_data_sharing_policy_version text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT task_agent_reviews_task_uniq UNIQUE(review_task_id),
  CONSTRAINT task_agent_reviews_subject_reviewer_uniq UNIQUE(organization_id,source_run_id,reviewer_agent_id),
  CONSTRAINT task_agent_reviews_scope_chk CHECK(version=1 AND source_task_id<>review_task_id AND source_agent_id<>reviewer_agent_id AND source_event_position>0),
  CONSTRAINT task_agent_reviews_artifacts_chk CHECK(jsonb_typeof(artifacts)='array' AND jsonb_array_length(artifacts) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE INDEX task_agent_reviews_source_idx ON task_agent_reviews(organization_id,source_task_id,created_at,id);
--> statement-breakpoint
CREATE TABLE task_agent_review_feedback (
  review_id text PRIMARY KEY REFERENCES task_agent_reviews(id), review_run_id text NOT NULL REFERENCES runs(id),
  report_message_id text NOT NULL REFERENCES messages(id), review_event_id text NOT NULL REFERENCES event_log(id),
  requested_by_user_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION artoo_task_agent_review_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'User-requested Agent review bindings and applied feedback are immutable'; END $$;
--> statement-breakpoint
CREATE TRIGGER task_agent_review_immutable BEFORE UPDATE OR DELETE ON task_agent_reviews FOR EACH ROW EXECUTE FUNCTION artoo_task_agent_review_immutable();
--> statement-breakpoint
CREATE TRIGGER task_agent_review_feedback_immutable BEFORE UPDATE OR DELETE ON task_agent_review_feedback FOR EACH ROW EXECUTE FUNCTION artoo_task_agent_review_immutable();
