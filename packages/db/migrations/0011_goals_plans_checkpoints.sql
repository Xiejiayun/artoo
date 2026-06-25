CREATE TABLE "goals" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"room_id" text,
	"owner_user_id" text NOT NULL,
	"title" text NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT 'p2' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stop_conditions" jsonb DEFAULT '{"rules":[]}'::jsonb NOT NULL,
	"budgets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_plan_id" text,
	"running_since" timestamp with time zone,
	"elapsed_cost_usd" real,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "goals_status_chk" CHECK ("goals"."status" in ('draft','planned','running','awaiting_approval','paused','blocked','completed','cancelled','archived')),
	CONSTRAINT "goals_priority_chk" CHECK ("goals"."priority" in ('p0','p1','p2','p3'))
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"goal_id" text NOT NULL,
	"version" integer NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"task_specs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"materialized_at" timestamp with time zone,
	"materialization_event_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "plans_goal_version_uniq" UNIQUE("goal_id","version"),
	CONSTRAINT "plans_status_chk" CHECK ("plans"."status" in ('proposed','accepted','rejected','superseded')),
	CONSTRAINT "plans_author_type_chk" CHECK ("plans"."author_type" in ('user','agent','system','bridge'))
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"goal_id" text NOT NULL,
	"plan_id" text,
	"type" text NOT NULL,
	"trigger_event_id" text,
	"state_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "checkpoints_type_chk" CHECK ("checkpoints"."type" in ('plan_accepted','dag_materialized','approval_decided','run_terminal','artifact_accepted','paused','resumed'))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "source_plan_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "source_plan_spec_ref" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_plan_spec_uniq" UNIQUE("source_plan_id","source_plan_spec_ref");--> statement-breakpoint
ALTER TABLE "event_log" ADD COLUMN "goal_id" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "goal_id" text;--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_type_chk";--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_type_chk" CHECK ("rooms"."type" in ('dm','project','sprint','task','agent_team','incident','goal'));--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goals_project_status_idx" ON "goals" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "goals_owner_idx" ON "goals" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "plans_goal_idx" ON "plans" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "checkpoints_goal_idx" ON "checkpoints" USING btree ("goal_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_goal_idx" ON "tasks" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "event_log_goal_idx" ON "event_log" USING btree ("goal_id","occurred_at");
