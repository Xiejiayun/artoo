CREATE TABLE ai_data_sharing_consents (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  user_id text NOT NULL REFERENCES users(id),
  policy_version text NOT NULL,
  policy_snapshot jsonb NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX ai_data_sharing_active_user_idx
  ON ai_data_sharing_consents (organization_id, user_id)
  WHERE revoked_at IS NULL;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN requested_by_user_id text REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN ai_data_sharing_consent_id text REFERENCES ai_data_sharing_consents(id);
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN ai_data_sharing_policy_version text;
--> statement-breakpoint
ALTER TABLE assistant_turns ADD COLUMN ai_data_sharing_consent_id text REFERENCES ai_data_sharing_consents(id);
--> statement-breakpoint
ALTER TABLE assistant_turns ADD COLUMN ai_data_sharing_policy_version text;
--> statement-breakpoint
ALTER TABLE discussions ADD COLUMN ai_data_sharing_consent_id text REFERENCES ai_data_sharing_consents(id);
--> statement-breakpoint
ALTER TABLE discussions ADD COLUMN ai_data_sharing_policy_version text;
