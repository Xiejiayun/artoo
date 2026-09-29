CREATE TABLE assistant_turns (
  id text PRIMARY KEY,
  position bigserial NOT NULL UNIQUE,
  organization_id text NOT NULL REFERENCES organizations(id),
  room_id text NOT NULL REFERENCES rooms(id),
  task_id text NOT NULL REFERENCES tasks(id),
  actor_user_id text NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL,
  agent_instance_id text,
  user_message_id text NOT NULL REFERENCES messages(id),
  response_message_id text REFERENCES messages(id),
  run_id text REFERENCES runs(id),
  status text NOT NULL CHECK (status IN ('queued','waiting','running','completed','failed','cancelled')),
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT assistant_turns_request_unique UNIQUE (organization_id,room_id,actor_user_id,client_request_id)
);
--> statement-breakpoint
CREATE INDEX assistant_turns_room_position_idx ON assistant_turns(room_id,position);
--> statement-breakpoint
CREATE INDEX assistant_turns_status_idx ON assistant_turns(organization_id,status);
--> statement-breakpoint
CREATE UNIQUE INDEX assistant_turns_one_running_per_room ON assistant_turns(room_id) WHERE status = 'running';
