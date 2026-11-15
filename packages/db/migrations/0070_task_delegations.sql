CREATE TABLE task_delegations (
  task_id text PRIMARY KEY REFERENCES tasks(id),
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  parent_task_id text NOT NULL REFERENCES tasks(id),
  root_task_id text NOT NULL REFERENCES tasks(id),
  version integer NOT NULL DEFAULT 1,
  depth integer NOT NULL,
  initiated_by_user_id text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  CONSTRAINT task_delegation_version_chk CHECK (version = 1),
  CONSTRAINT task_delegation_depth_chk CHECK (depth BETWEEN 1 AND 3),
  CONSTRAINT task_delegation_identity_chk CHECK (
    task_id <> parent_task_id AND task_id <> root_task_id AND
    ((depth = 1 AND parent_task_id = root_task_id) OR (depth > 1 AND parent_task_id <> root_task_id))
  )
);
--> statement-breakpoint
CREATE INDEX task_delegation_root_idx ON task_delegations(root_task_id, depth, task_id);
--> statement-breakpoint
CREATE FUNCTION guard_task_delegation_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_edge task_delegations%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Explicit task delegation history is immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tasks WHERE id=NEW.task_id AND organization_id=NEW.organization_id
    AND project_id=NEW.project_id AND parent_task_id=NEW.parent_task_id)
    OR NOT EXISTS (SELECT 1 FROM tasks WHERE id=NEW.parent_task_id AND organization_id=NEW.organization_id AND project_id=NEW.project_id)
    OR NOT EXISTS (SELECT 1 FROM tasks WHERE id=NEW.root_task_id AND organization_id=NEW.organization_id AND project_id=NEW.project_id)
    OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.initiated_by_user_id AND organization_id=NEW.organization_id)
    OR EXISTS (SELECT 1 FROM task_delegations WHERE task_id=NEW.root_task_id OR root_task_id=NEW.task_id)
  THEN RAISE EXCEPTION 'Invalid explicit task delegation scope or root'; END IF;
  SELECT * INTO parent_edge FROM task_delegations WHERE task_id=NEW.parent_task_id;
  IF (FOUND AND (parent_edge.root_task_id<>NEW.root_task_id OR parent_edge.depth+1<>NEW.depth
      OR parent_edge.organization_id<>NEW.organization_id OR parent_edge.project_id<>NEW.project_id))
    OR (NOT FOUND AND (NEW.parent_task_id<>NEW.root_task_id OR NEW.depth<>1))
  THEN RAISE EXCEPTION 'Invalid explicit task delegation lineage'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_delegation_history BEFORE INSERT OR UPDATE OR DELETE ON task_delegations
FOR EACH ROW EXECUTE FUNCTION guard_task_delegation_history();
--> statement-breakpoint
CREATE FUNCTION guard_task_delegation_task_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.parent_task_id IS DISTINCT FROM NEW.parent_task_id AND EXISTS (SELECT 1 FROM task_delegations WHERE task_id=OLD.id))
    OR ((OLD.organization_id IS DISTINCT FROM NEW.organization_id OR OLD.project_id IS DISTINCT FROM NEW.project_id)
      AND EXISTS (SELECT 1 FROM task_delegations WHERE task_id=OLD.id OR parent_task_id=OLD.id OR root_task_id=OLD.id))
  THEN RAISE EXCEPTION 'Explicit task delegation identity is immutable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_delegation_task_identity BEFORE UPDATE OF parent_task_id, organization_id, project_id ON tasks
FOR EACH ROW EXECUTE FUNCTION guard_task_delegation_task_identity();
