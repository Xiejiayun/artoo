CREATE TABLE "agent_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"computer_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"runtime" text NOT NULL,
	"model_profile_id" text,
	"effort_profile_id" text,
	"status" text NOT NULL,
	"workspace_root" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_instances_status_chk" CHECK ("agent_instances"."status" in ('idle','queued','running','stopping','failed','disabled'))
);
--> statement-breakpoint
CREATE TABLE "agent_runtimes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"computer_id" text NOT NULL,
	"runtime" text NOT NULL,
	"version" text,
	"status" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "agent_runtimes_computer_runtime" UNIQUE("computer_id","runtime"),
	CONSTRAINT "agent_runtimes_status_chk" CHECK ("agent_runtimes"."status" in ('detected','available','missing','disabled'))
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agents_kind_chk" CHECK ("agents"."kind" in ('coding','reviewer','planner','integrator','qa','memory_curator','mock')),
	CONSTRAINT "agents_status_chk" CHECK ("agents"."status" in ('offline','idle','queued','running','awaiting_approval','blocked','failed'))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"action" text NOT NULL,
	"risk" text NOT NULL,
	"summary" text NOT NULL,
	"payload_ref" text,
	"status" text NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approvals_requested_by_type_chk" CHECK ("approvals"."requested_by_type" in ('agent','system')),
	CONSTRAINT "approvals_risk_chk" CHECK ("approvals"."risk" in ('low','medium','high')),
	CONSTRAINT "approvals_status_chk" CHECK ("approvals"."status" in ('pending','approved','rejected','needs_more_info','expired'))
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text,
	"type" text NOT NULL,
	"uri" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checksum" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "artifacts_type_chk" CHECK ("artifacts"."type" in ('patch','pull_request','file','screenshot','report','log_bundle','url','test_result'))
);
--> statement-breakpoint
CREATE TABLE "computers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"display_name" text NOT NULL,
	"hostname" text NOT NULL,
	"os" text NOT NULL,
	"arch" text NOT NULL,
	"status" text NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"resources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "computers_status_chk" CHECK ("computers"."status" in ('enrolling','online','offline','disabled'))
);
--> statement-breakpoint
CREATE TABLE "context_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text,
	"payload" jsonb NOT NULL,
	"source_memory_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "effort_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"effort" text NOT NULL,
	"max_runtime_minutes" integer NOT NULL,
	"max_cost_usd" numeric(10, 2),
	"max_tool_calls" integer,
	"retry_budget" integer DEFAULT 0 NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "effort_profiles_org_name" UNIQUE("organization_id","name"),
	CONSTRAINT "effort_profiles_effort_chk" CHECK ("effort_profiles"."effort" in ('low','medium','high','max'))
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" text PRIMARY KEY NOT NULL,
	"position" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"schema_version" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"task_id" text,
	"room_id" text,
	"run_id" text,
	"correlation_id" text NOT NULL,
	"idempotency_key" text,
	"sequence" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "event_log_position_unique" UNIQUE("position")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_json" jsonb,
	"event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "idempotency_keys_pk" UNIQUE("scope","key")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"room_id" text NOT NULL,
	"task_id" text,
	"run_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "messages_actor_type_chk" CHECK ("messages"."actor_type" in ('user','agent','system','bridge'))
);
--> statement-breakpoint
CREATE TABLE "model_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"context_window" integer,
	"cost_tier" text NOT NULL,
	"latency_tier" text NOT NULL,
	"capability_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_profiles_org_name" UNIQUE("organization_id","name"),
	CONSTRAINT "model_profiles_cost_tier_chk" CHECK ("model_profiles"."cost_tier" in ('low','medium','high','premium')),
	CONSTRAINT "model_profiles_latency_tier_chk" CHECK ("model_profiles"."latency_tier" in ('fast','normal','slow'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"default_workspace" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text,
	"task_id" text,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rooms_type_chk" CHECK ("rooms"."type" in ('dm','project','sprint','task','agent_team','incident'))
);
--> statement-breakpoint
CREATE TABLE "run_event_ingest" (
	"node_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_event_ingest_unique" UNIQUE("node_id","run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"computer_id" text NOT NULL,
	"agent_instance_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"scheduler_decision_id" text,
	"model_profile_id" text,
	"effort_profile_id" text,
	"status" text NOT NULL,
	"context_pack_id" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"failure_reason" text,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "runs_status_chk" CHECK ("runs"."status" in ('queued','starting','running','awaiting_input','paused','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "scheduler_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"selected_computer_id" text NOT NULL,
	"selected_agent_instance_id" text NOT NULL,
	"selected_model_profile_id" text,
	"selected_effort_profile_id" text,
	"mode" text NOT NULL,
	"score" integer NOT NULL,
	"reason" text NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scheduler_decisions_mode_chk" CHECK ("scheduler_decisions"."mode" in ('auto','manual'))
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"from_task_id" text NOT NULL,
	"to_task_id" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_deps_unique" UNIQUE("from_task_id","to_task_id","type"),
	CONSTRAINT "task_deps_type_chk" CHECK ("task_dependencies"."type" in ('blocks','artifact_required'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"parent_task_id" text,
	"room_id" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"priority" text DEFAULT 'p2' NOT NULL,
	"assignee_type" text,
	"assignee_id" text,
	"required_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_model_profile_id" text,
	"preferred_effort" text,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tasks_status_chk" CHECK ("tasks"."status" in ('backlog','ready','assigned','running','awaiting_approval','blocked','review','done','cancelled')),
	CONSTRAINT "tasks_assignee_type_chk" CHECK ("tasks"."assignee_type" is null or "tasks"."assignee_type" in ('user','agent','agent_team')),
	CONSTRAINT "tasks_preferred_effort_chk" CHECK ("tasks"."preferred_effort" is null or "tasks"."preferred_effort" in ('low','medium','high','max')),
	CONSTRAINT "tasks_created_by_type_chk" CHECK ("tasks"."created_by_type" in ('user','agent','system'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_chk" CHECK ("users"."role" in ('owner','admin','member'))
);
--> statement-breakpoint
ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instances" ADD CONSTRAINT "agent_instances_effort_profile_id_effort_profiles_id_fk" FOREIGN KEY ("effort_profile_id") REFERENCES "public"."effort_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtimes" ADD CONSTRAINT "agent_runtimes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtimes" ADD CONSTRAINT "agent_runtimes_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effort_profiles" ADD CONSTRAINT "effort_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_profiles" ADD CONSTRAINT "model_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_effort_profile_id_effort_profiles_id_fk" FOREIGN KEY ("effort_profile_id") REFERENCES "public"."effort_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_decisions" ADD CONSTRAINT "scheduler_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_decisions" ADD CONSTRAINT "scheduler_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_decisions" ADD CONSTRAINT "scheduler_decisions_selected_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("selected_model_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_decisions" ADD CONSTRAINT "scheduler_decisions_selected_effort_profile_id_effort_profiles_id_fk" FOREIGN KEY ("selected_effort_profile_id") REFERENCES "public"."effort_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_from_task_id_tasks_id_fk" FOREIGN KEY ("from_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_to_task_id_tasks_id_fk" FOREIGN KEY ("to_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_instances_status_computer_idx" ON "agent_instances" USING btree ("status","computer_id");--> statement-breakpoint
CREATE INDEX "agent_instances_profiles_idx" ON "agent_instances" USING btree ("model_profile_id","effort_profile_id","status");--> statement-breakpoint
CREATE INDEX "approvals_status_expires_idx" ON "approvals" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "computers_status_heartbeat_idx" ON "computers" USING btree ("status","last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "effort_profiles_lookup_idx" ON "effort_profiles" USING btree ("organization_id","enabled","effort");--> statement-breakpoint
CREATE INDEX "event_log_correlation_idx" ON "event_log" USING btree ("correlation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "event_log_task_idx" ON "event_log" USING btree ("task_id","occurred_at");--> statement-breakpoint
CREATE INDEX "messages_room_created_idx" ON "messages" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "model_profiles_lookup_idx" ON "model_profiles" USING btree ("organization_id","enabled","cost_tier");--> statement-breakpoint
CREATE INDEX "runs_task_status_created_idx" ON "runs" USING btree ("task_id","status","created_at");--> statement-breakpoint
CREATE INDEX "task_deps_to_idx" ON "task_dependencies" USING btree ("to_task_id");--> statement-breakpoint
CREATE INDEX "tasks_project_status_updated_idx" ON "tasks" USING btree ("project_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_task_id");
