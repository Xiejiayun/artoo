ALTER TABLE approvals DROP CONSTRAINT approvals_requested_by_type_chk;
--> statement-breakpoint
ALTER TABLE approvals ADD CONSTRAINT approvals_requested_by_type_chk CHECK (requested_by_type IN ('user','agent','system'));
