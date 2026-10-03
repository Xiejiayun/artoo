CREATE INDEX "event_log_workspace_retention_run_idx"
  ON "event_log" ("organization_id", "run_id", "position" DESC)
  WHERE "type" = 'run.workspace.retained';
