CREATE INDEX runs_agent_history_idx ON runs (organization_id, agent_instance_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX event_log_run_history_idx ON event_log (organization_id, run_id, position DESC);
