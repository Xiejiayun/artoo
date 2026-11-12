-- Execution instances belong to one project; identities and machines remain reusable.
ALTER TABLE agent_instances ADD COLUMN project_id text REFERENCES projects(id);
--> statement-breakpoint
-- Only infer a legacy owner when workspace and historical use agree on one
-- project. Ambiguous instances stay unassigned for an administrator to review.
WITH candidates AS (
  SELECT ai.id AS instance_id, p.id AS project_id
  FROM agent_instances ai JOIN projects p ON p.organization_id = ai.organization_id
  WHERE ai.workspace_root IS NOT NULL AND ai.workspace_root = p.default_workspace
  UNION
  SELECT ai.id, t.project_id
  FROM agent_instances ai JOIN runs r ON r.agent_instance_id = ai.id AND r.organization_id = ai.organization_id
  JOIN tasks t ON t.id = r.task_id AND t.organization_id = ai.organization_id
  JOIN projects p ON p.id = t.project_id AND p.organization_id = ai.organization_id
  UNION
  SELECT ai.id, min(p.id)
  FROM agent_instances ai JOIN projects p ON p.organization_id = ai.organization_id
  GROUP BY ai.id HAVING count(*) = 1
), owners AS (
  SELECT instance_id, min(project_id) AS project_id
  FROM candidates GROUP BY instance_id HAVING count(*) = 1
)
UPDATE agent_instances ai SET project_id = owners.project_id
FROM owners WHERE ai.id = owners.instance_id;
--> statement-breakpoint
CREATE INDEX agent_instances_org_project_idx ON agent_instances(organization_id, project_id);
