ALTER TABLE "rooms" ADD COLUMN "description" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "thread_root_id" text REFERENCES "messages"("id");
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_request_id" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_request_hash" text;
--> statement-breakpoint
CREATE INDEX "messages_thread_position_idx" ON "messages"("thread_root_id", "position");
--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_request_unique" ON "messages"("organization_id", "room_id", "actor_type", "actor_id", "client_request_id");
--> statement-breakpoint
CREATE TABLE "notifications" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "room_id" text NOT NULL REFERENCES "rooms"("id"),
  "message_id" text NOT NULL REFERENCES "messages"("id"),
  "thread_root_id" text REFERENCES "messages"("id"),
  "actor_id" text NOT NULL,
  "body_preview" text NOT NULL,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "notifications_user_message_unique" UNIQUE("user_id", "message_id")
);
--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications"("organization_id", "user_id", "created_at");
