import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DEPENDENCY_TYPES, type DependencyType, type Task } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Badge, Button, Select } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

export function TaskDependencies({ task }: { task: Task }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const [prerequisite, setPrerequisite] = useState("");
  const [type, setType] = useState<DependencyType>("blocks");
  const dependencies = useQuery({ queryKey: ["dependencies", task.id], queryFn: () => api.listDependencies(task.id) });
  const tasks = useQuery({ queryKey: queryKeys.tasks(task.project_id), queryFn: () => api.listTasks(task.project_id) });
  const leases = useQuery({ queryKey: ["leases", task.project_id], queryFn: () => api.listLeases(task.project_id), refetchInterval: 10000 });
  const refresh = async (): Promise<void> => { await query.invalidateQueries({ queryKey: ["dependencies", task.id] }); };
  const add = useMutation({ mutationFn: () => api.createDependency(task.id, { depends_on_task_id: prerequisite, type }, newIdempotencyKey()), onSuccess: async () => { setPrerequisite(""); await refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteDependency(task.id, id, newIdempotencyKey()), onSuccess: refresh });
  const title = (id: string): string => tasks.data?.tasks.find((item) => item.id === id)?.title ?? id;
  return <section className="task-detail__section u-stack-sm" aria-label="Dependencies and leases"><h3>Dependencies</h3><ActionError error={dependencies.error ?? tasks.error ?? add.error ?? remove.error} />
    {dependencies.isLoading && <p role="status">Loading dependencies…</p>}{dependencies.data?.dependencies.length === 0 && <p>No dependencies.</p>}
    {dependencies.data?.dependencies.map((dependency) => <div className="product-card u-stack-sm" key={dependency.id}><span>{title(dependency.from_task_id)} → {title(dependency.to_task_id)}</span><Badge>{dependency.type}</Badge><Button size="sm" disabled={remove.isPending} onClick={() => remove.mutate(dependency.id)}>Remove dependency</Button></div>)}
    <form className="u-stack-sm" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}><Select label="Prerequisite task" value={prerequisite} required onChange={(event) => setPrerequisite(event.target.value)}><option value="">Choose task</option>{tasks.data?.tasks.filter((item) => item.id !== task.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</Select><Select label="Dependency type" value={type} onChange={(event) => setType(event.target.value as DependencyType)}>{DEPENDENCY_TYPES.map((value) => <option key={value}>{value}</option>)}</Select><Button type="submit" disabled={!prerequisite} loading={add.isPending}>Add dependency</Button></form>
    <h3>Workspace leases</h3><ActionError error={leases.error} />{leases.isLoading && <p role="status">Loading leases…</p>}{leases.data?.leases.filter((lease) => lease.task_id === task.id).length === 0 && <p>No workspace leases for this task.</p>}{leases.data?.leases.filter((lease) => lease.task_id === task.id).map((lease) => <div className="product-card" key={lease.id}><code>{lease.path}</code><p>{lease.mode} · {lease.status}</p>{lease.expires_at && <p>Expires {new Date(lease.expires_at).toLocaleString()}</p>}</div>)}
  </section>;
}
