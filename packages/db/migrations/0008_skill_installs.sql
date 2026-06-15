CREATE TABLE "skill_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text,
	"skill_id" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"manifest" jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compatible_runtimes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"permission_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_by_type" text NOT NULL,
	"installed_by_id" text NOT NULL,
	"installed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_installs_installed_by_type_chk" CHECK ("skill_installs"."installed_by_type" in ('user','agent','system'))
);
--> statement-breakpoint
ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_installs_org_enabled_idx" ON "skill_installs" USING btree ("organization_id","enabled");--> statement-breakpoint
CREATE INDEX "skill_installs_project_enabled_idx" ON "skill_installs" USING btree ("project_id","enabled");--> statement-breakpoint
CREATE INDEX "skill_installs_skill_idx" ON "skill_installs" USING btree ("organization_id","skill_id");
