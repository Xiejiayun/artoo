ALTER TABLE "devices"
  DROP CONSTRAINT "devices_platform_chk",
  ADD CONSTRAINT "devices_platform_chk"
    CHECK ("devices"."platform" in ('windows','macos','linux','android','ios'));
--> statement-breakpoint
ALTER TABLE "pairing_codes"
  DROP CONSTRAINT "pairing_codes_platform_chk",
  ADD CONSTRAINT "pairing_codes_platform_chk"
    CHECK ("pairing_codes"."intended_platform" is null
      or "pairing_codes"."intended_platform" in ('windows','macos','linux','android','ios'));
