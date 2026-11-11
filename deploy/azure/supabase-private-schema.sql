-- Provision ONLY a dedicated Artoo Supabase project, before the first startup.
-- Artoo authorizes through its own HTTP/WS backend; anon/authenticated must not
-- query its public tables or RPC functions through Supabase's Data API.
-- This does not change Supabase's auth/storage schemas or delete any data.
BEGIN;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', api_role);
      IF has_schema_privilege(api_role, 'public', 'USAGE') THEN
        RAISE EXCEPTION 'Data API role still inherits public schema access';
      END IF;
    END IF;
  END LOOP;
END $$;
COMMIT;
