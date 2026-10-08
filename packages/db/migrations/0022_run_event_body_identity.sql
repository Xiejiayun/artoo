ALTER TABLE "run_event_ingest" ADD COLUMN "body_identity" text;
--> statement-breakpoint
ALTER TABLE "run_event_ingest" ADD CONSTRAINT "run_event_ingest_body_identity_shape"
  CHECK ("body_identity" IS NULL
    OR "body_identity" ~ '^run-event-body-v1:sha256:[0-9a-f]{64}$');
