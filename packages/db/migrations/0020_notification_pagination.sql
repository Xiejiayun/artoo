DROP INDEX notifications_user_created_idx;
--> statement-breakpoint
CREATE INDEX notifications_user_created_idx ON notifications(organization_id, user_id, created_at, id);
--> statement-breakpoint
CREATE INDEX notifications_user_unread_idx ON notifications(organization_id, user_id) WHERE read_at IS NULL;
