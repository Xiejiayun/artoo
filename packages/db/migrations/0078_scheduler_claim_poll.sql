CREATE INDEX scheduler_execution_request_poll_idx ON scheduler_execution_requests(organization_id,created_at,id) WHERE state='pending';
--> statement-breakpoint
CREATE INDEX scheduler_execution_request_session_idx ON scheduler_execution_requests(organization_id,consumed_device_id,consumed_session_id,consumed_at) WHERE state='consumed';
--> statement-breakpoint
CREATE TABLE scheduler_request_stop_intents (
  request_id text PRIMARY KEY REFERENCES scheduler_execution_requests(id),
  requested_by_user_id text NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL CHECK(isfinite(requested_at))
);
--> statement-breakpoint
CREATE FUNCTION artoo_scheduler_request_stop_intent_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Scheduler request Stop intent is immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM scheduler_execution_requests q JOIN runs r ON r.id=q.consumed_run_id
    WHERE q.id=NEW.request_id AND q.state='consumed' AND r.ended_at IS NULL
      AND r.status IN ('queued','starting','running','paused','awaiting_input')
    FOR SHARE OF q,r NOWAIT) THEN RAISE EXCEPTION 'Scheduler request Stop requires its original active Run'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER scheduler_request_stop_intent_history BEFORE INSERT OR UPDATE OR DELETE ON scheduler_request_stop_intents
FOR EACH ROW EXECUTE FUNCTION artoo_scheduler_request_stop_intent_history();
