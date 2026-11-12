import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AgentInstance } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import type { BootstrapResponse } from "../api/types.js";
import { Button, Select } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

export function AgentProjectControl({ instance, projects, role }: {
  instance: AgentInstance; projects: BootstrapResponse["projects"]; role: string;
}): React.ReactNode {
  const api = useApi(), query = useQueryClient();
  const [projectId, setProjectId] = useState(instance.project_id ?? "");
  const mutation = useMutation({ mutationFn: () => api.setAgentProject(instance.id, projectId || null, newIdempotencyKey()),
    onSuccess: async () => { await query.invalidateQueries({ queryKey: queryKeys.bootstrap }); } });
  const name = projects.find((project) => project.id === instance.project_id)?.name ?? "Unassigned";
  if (!["owner", "admin"].includes(role)) return <p>Project squad: {name}</p>;
  return <div className="resource-form u-stack-sm">
    <Select label="Project squad" value={projectId} disabled={mutation.isPending} onChange={(event) => { setProjectId(event.target.value); mutation.reset(); }}>
      <option value="">Unassigned</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </Select>
    <p className="resource-muted">Changing the project keeps this workspace path. Stop active work before moving an instance.</p>
    <Button size="sm" disabled={projectId === (instance.project_id ?? "")} loading={mutation.isPending} onClick={() => mutation.mutate()}>Save project squad</Button>
    <ActionError error={mutation.error} />
  </div>;
}
