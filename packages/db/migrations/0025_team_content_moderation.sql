CREATE TABLE content_rules (
  organization_id text PRIMARY KEY REFERENCES organizations(id),
  blocked_phrases jsonb NOT NULL,
  updated_by_user_id text NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE member_suspensions (
  user_id text PRIMARY KEY REFERENCES users(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  suspended_by_user_id text NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  suspended_at timestamptz NOT NULL,
  reinstated_at timestamptz
);
--> statement-breakpoint
CREATE TABLE content_reports (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  message_id text NOT NULL REFERENCES messages(id),
  reporter_user_id text NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  body_snapshot text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  reviewed_by_user_id text REFERENCES users(id),
  resolution_note text,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX content_reports_reporter_message_idx
  ON content_reports (organization_id, reporter_user_id, message_id);
--> statement-breakpoint
CREATE INDEX content_reports_queue_idx ON content_reports (organization_id, status, created_at, id);
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN moderated_at timestamptz;
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN moderated_by_user_id text REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE messages ADD CONSTRAINT messages_moderation_pair_chk CHECK ((moderated_at IS NULL) = (moderated_by_user_id IS NULL));
