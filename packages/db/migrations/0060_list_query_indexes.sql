CREATE INDEX tasks_org_project_created_idx ON tasks (organization_id, project_id, created_at, id);
--> statement-breakpoint
CREATE INDEX goals_org_created_idx ON goals (organization_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX approvals_org_status_created_idx ON approvals (organization_id, status, created_at, id);
