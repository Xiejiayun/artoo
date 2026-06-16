CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"display_name" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text NOT NULL,
	"computer_id" text,
	"enrolled_by_user_id" text NOT NULL,
	"trust" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_platform_chk" CHECK ("devices"."platform" in ('windows','macos','android','ios')),
	CONSTRAINT "devices_trust_chk" CHECK ("devices"."trust" in ('active','revoked'))
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"device_id" text NOT NULL,
	"kind" text NOT NULL,
	"token_lookup" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_tokens_lookup" UNIQUE("token_lookup"),
	CONSTRAINT "device_tokens_kind_chk" CHECK ("device_tokens"."kind" in ('control_session','node')),
	CONSTRAINT "device_tokens_status_chk" CHECK ("device_tokens"."status" in ('active','revoked'))
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"intended_platform" text,
	"status" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_by_device_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "pairing_codes_status_chk" CHECK ("pairing_codes"."status" in ('pending','claimed','expired','cancelled')),
	CONSTRAINT "pairing_codes_platform_chk" CHECK ("pairing_codes"."intended_platform" is null or "pairing_codes"."intended_platform" in ('windows','macos','android','ios'))
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_enrolled_by_user_id_users_id_fk" FOREIGN KEY ("enrolled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_claimed_by_device_id_devices_id_fk" FOREIGN KEY ("claimed_by_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_org_trust_idx" ON "devices" USING btree ("organization_id","trust");--> statement-breakpoint
CREATE INDEX "devices_computer_idx" ON "devices" USING btree ("computer_id");--> statement-breakpoint
CREATE INDEX "device_tokens_device_idx" ON "device_tokens" USING btree ("device_id","kind","status");--> statement-breakpoint
CREATE INDEX "pairing_codes_code_hash_idx" ON "pairing_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "pairing_codes_org_status_idx" ON "pairing_codes" USING btree ("organization_id","status");
