ALTER TABLE messages ADD COLUMN position bigserial NOT NULL;
--> statement-breakpoint
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS ordinal FROM messages
)
UPDATE messages SET position = ordered.ordinal FROM ordered WHERE messages.id = ordered.id;
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('messages', 'position'), COALESCE((SELECT MAX(position) FROM messages), 1), EXISTS(SELECT 1 FROM messages));
--> statement-breakpoint
ALTER TABLE messages ADD CONSTRAINT messages_position_unique UNIQUE (position);
--> statement-breakpoint
CREATE INDEX messages_room_position_idx ON messages (room_id, position);
