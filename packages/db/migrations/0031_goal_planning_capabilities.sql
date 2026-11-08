ALTER TABLE goal_automations ADD COLUMN planning_capability_snapshot jsonb
  CONSTRAINT goal_automations_planning_capability_snapshot_chk CHECK (
    planning_capability_snapshot IS NULL OR
    (jsonb_typeof(planning_capability_snapshot) = 'object' AND planning_capability_snapshot -> 'version' = '1'::jsonb) IS TRUE
  );
