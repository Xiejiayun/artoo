CREATE TABLE "file_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text,
	"holder_type" text NOT NULL,
	"holder_id" text NOT NULL,
	"path" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "file_leases_mode_chk" CHECK ("file_leases"."mode" in ('read','write')),
	CONSTRAINT "file_leases_status_chk" CHECK ("file_leases"."status" in ('held','released','expired')),
	CONSTRAINT "file_leases_holder_type_chk" CHECK ("file_leases"."holder_type" in ('run','task','agent','system'))
);
--> statement-breakpoint
CREATE TABLE "integration_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"sequence" integer NOT NULL,
	"artifact_ref" text,
	"enqueued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "integration_queue_status_chk" CHECK ("integration_queue"."status" in ('queued','integrating','done','failed'))
);
--> statement-breakpoint
ALTER TABLE "file_leases" ADD CONSTRAINT "file_leases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_leases" ADD CONSTRAINT "file_leases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_leases" ADD CONSTRAINT "file_leases_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_leases" ADD CONSTRAINT "file_leases_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_queue" ADD CONSTRAINT "integration_queue_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_queue" ADD CONSTRAINT "integration_queue_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_queue" ADD CONSTRAINT "integration_queue_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_queue" ADD CONSTRAINT "integration_queue_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_leases_project_status_idx" ON "file_leases" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "file_leases_path_idx" ON "file_leases" USING btree ("path");--> statement-breakpoint
CREATE INDEX "integration_queue_project_status_idx" ON "integration_queue" USING btree ("project_id","status");