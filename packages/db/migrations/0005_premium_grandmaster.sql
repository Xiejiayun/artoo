ALTER TABLE "agent_runtimes" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtimes" ADD COLUMN "last_seen_at" timestamp with time zone;