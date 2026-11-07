-- Existing runs deliberately receive no row: their delivery is unknown.
CREATE TABLE assistant_run_dispatches (
  run_id text PRIMARY KEY REFERENCES runs(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  turn_id text NOT NULL REFERENCES assistant_turns(id),
  version integer NOT NULL DEFAULT 1,
  state text NOT NULL,
  created_at timestamptz NOT NULL,
  exposed_at timestamptz,
  CONSTRAINT assistant_run_dispatches_version_chk CHECK (version = 1),
  CONSTRAINT assistant_run_dispatches_state_chk CHECK (
    (state = 'prepared' AND exposed_at IS NULL) OR (state = 'exposed' AND exposed_at IS NOT NULL)
  )
);
