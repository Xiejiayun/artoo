-- Literal ILIKE substring search; no tokenization or language-dependent ranking.
-- Install with the normal migration role. Missing extension privileges fail the
-- transaction; do not silently omit indexes on a supposedly upgraded database.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX tasks_title_trgm_idx ON tasks USING gin (title gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX tasks_description_trgm_idx ON tasks USING gin (description gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX messages_body_trgm_idx ON messages USING gin (body gin_trgm_ops) WHERE moderated_at IS NULL;
