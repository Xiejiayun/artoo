CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text,
	"task_id" text,
	"status" text NOT NULL,
	"scope" text NOT NULL,
	"source_task_id" text,
	"source_run_id" text,
	"source_message_id" text,
	"source_artifact_id" text,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"confidence" numeric(3, 2) DEFAULT 1 NOT NULL,
	"text" text,
	"payload" jsonb,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supersedes_id" text,
	"superseded_by_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "memories_status_chk" CHECK ("memories"."status" in ('proposed','accepted','rejected','superseded')),
	CONSTRAINT "memories_scope_chk" CHECK ("memories"."scope" in ('task','project','organization','code')),
	CONSTRAINT "memories_author_type_chk" CHECK ("memories"."author_type" in ('user','agent','system'))
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_org_status_idx" ON "memories" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "memories_project_scope_idx" ON "memories" USING btree ("project_id","scope");--> statement-breakpoint
CREATE INDEX "memories_updated_idx" ON "memories" USING btree ("updated_at");