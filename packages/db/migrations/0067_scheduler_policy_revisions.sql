ALTER TABLE scheduler_project_policies
  ADD COLUMN revision bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT scheduler_project_policy_revision_chk CHECK (revision BETWEEN 1 AND 9007199254740991);
--> statement-breakpoint
ALTER TABLE scheduler_agent_policies
  ADD COLUMN revision bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT scheduler_agent_policy_revision_chk CHECK (revision BETWEEN 1 AND 9007199254740991);
--> statement-breakpoint
ALTER TABLE scheduler_computer_policies
  ADD COLUMN revision bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT scheduler_computer_policy_revision_chk CHECK (revision BETWEEN 1 AND 9007199254740991);
