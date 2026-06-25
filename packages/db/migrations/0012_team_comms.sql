CREATE TABLE "decision_records" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"room_id" text NOT NULL,
	"task_id" text,
	"run_id" text,
	"goal_id" text,
	"plan_id" text,
	"source_message_id" text,
	"status" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"summary" text NOT NULL,
	"rationale" text,
	"alternatives" jsonb,
	"evidence_refs" jsonb,
	"impact_summary" text,
	"superseded_by_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "decision_records_source_message" UNIQUE("source_message_id"),
	CONSTRAINT "decision_records_status_chk" CHECK ("decision_records"."status" in ('proposed','accepted','rejected','superseded')),
	CONSTRAINT "decision_records_actor_type_chk" CHECK ("decision_records"."actor_type" in ('user','agent','system','bridge'))
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"room_id" text NOT NULL,
	"task_id" text,
	"run_id" text,
	"goal_id" text,
	"plan_id" text,
	"sender_type" text NOT NULL,
	"sender_id" text NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_id" text NOT NULL,
	"expected_action" text NOT NULL,
	"blocking_condition" text,
	"priority" text,
	"due_at" timestamp with time zone,
	"status" text NOT NULL,
	"next_action" text,
	"latest_status" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "handoffs_status_chk" CHECK ("handoffs"."status" in ('open','accepted','completed','cancelled','expired')),
	CONSTRAINT "handoffs_sender_type_chk" CHECK ("handoffs"."sender_type" in ('user','agent','system','bridge')),
	CONSTRAINT "handoffs_recipient_type_chk" CHECK ("handoffs"."recipient_type" in ('user','agent','system','bridge'))
);
--> statement-breakpoint
CREATE TABLE "blockers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"room_id" text NOT NULL,
	"task_id" text,
	"run_id" text,
	"goal_id" text,
	"plan_id" text,
	"type" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"source_kind" text,
	"source_id" text,
	"summary" text NOT NULL,
	"mitigation" text,
	"next_action" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "blockers_type_chk" CHECK ("blockers"."type" in ('approval','dependency','lease_conflict','offline_agent','stale_runtime','policy','budget','failed_run','missing_artifact','human_input')),
	CONSTRAINT "blockers_status_chk" CHECK ("blockers"."status" in ('open','mitigated','accepted_risk','resolved'))
);
--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_records_room_idx" ON "decision_records" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "handoffs_room_idx" ON "handoffs" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "handoffs_recipient_idx" ON "handoffs" USING btree ("recipient_type","recipient_id");--> statement-breakpoint
CREATE INDEX "blockers_room_idx" ON "blockers" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "blockers_source_idx" ON "blockers" USING btree ("source_kind","source_id");
