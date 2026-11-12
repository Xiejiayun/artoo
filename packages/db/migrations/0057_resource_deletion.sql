-- Retain resource identities for historical runs, messages and audit records.
ALTER TABLE computers ADD COLUMN deleted_at timestamptz;
--> statement-breakpoint
ALTER TABLE agents ADD COLUMN deleted_at timestamptz;
--> statement-breakpoint
ALTER TABLE agent_instances ADD COLUMN deleted_at timestamptz;
