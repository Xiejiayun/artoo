ALTER TABLE assistant_turns ADD COLUMN thread_root_id text REFERENCES messages(id);
--> statement-breakpoint
CREATE INDEX assistant_turns_thread_idx ON assistant_turns(room_id, thread_root_id, position);
--> statement-breakpoint
CREATE TABLE discussions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  goal_id text NOT NULL REFERENCES goals(id),
  room_id text NOT NULL REFERENCES rooms(id),
  thread_root_id text NOT NULL REFERENCES messages(id),
  task_id text NOT NULL REFERENCES tasks(id),
  actor_user_id text NOT NULL REFERENCES users(id),
  participants jsonb NOT NULL,
  rounds integer NOT NULL CHECK (rounds BETWEEN 1 AND 3),
  max_minutes integer NOT NULL CHECK (max_minutes BETWEEN 2 AND 60),
  status text NOT NULL CHECK (status IN ('running','stopping','ready','failed','cancelled')),
  current_step integer NOT NULL DEFAULT 0,
  active_turn_id text REFERENCES assistant_turns(id),
  final_message_id text REFERENCES messages(id),
  plan_id text REFERENCES plans(id),
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX discussions_goal_idx ON discussions(organization_id, goal_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX discussions_one_active_goal ON discussions(goal_id) WHERE status IN ('running','stopping');
