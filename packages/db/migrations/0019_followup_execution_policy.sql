ALTER TABLE tasks ADD COLUMN execution_policy_task_id text REFERENCES tasks(id);
--> statement-breakpoint
DROP INDEX assistant_turns_one_running_per_room;
--> statement-breakpoint
CREATE UNIQUE INDEX assistant_turns_one_running_per_conversation ON assistant_turns(room_id, COALESCE(thread_root_id, '')) WHERE status = 'running';
