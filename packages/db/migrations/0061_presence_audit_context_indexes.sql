CREATE INDEX messages_org_task_created_idx ON messages (organization_id, task_id, created_at, id);
--> statement-breakpoint
CREATE INDEX runs_org_task_created_idx ON runs (organization_id, task_id, created_at DESC, id DESC);
--> statement-breakpoint
-- Shared by organization-wide Presence batches and computer/instance lookups.
-- Keep every non-terminal state; do not make latest-task lookups completed-only.
CREATE INDEX runs_org_active_idx ON runs (organization_id, computer_id, agent_instance_id)
WHERE status NOT IN ('completed', 'failed', 'cancelled');
