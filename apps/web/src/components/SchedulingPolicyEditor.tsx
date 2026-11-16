import { SchedulerAgentPolicyV1Schema, SchedulerComputerPolicyV1Schema, SchedulerProjectPolicyV1Schema } from "@artoo/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import type { BootstrapResponse } from "../api/types.js";
import type { SchedulingPolicyKind, SchedulingPolicyResponse } from "../api/teamResources.js";
import { Badge, Button, Input, Select } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

const split = (value: string): string[] => value.split(",").map((item) => item.trim()).filter(Boolean);
function PolicyForm({ kind, id, initial, bootstrap }: { kind: SchedulingPolicyKind; id: string; initial: SchedulingPolicyResponse; bootstrap: BootstrapResponse }): React.ReactNode {
  const api = useApi(), query = useQueryClient();
  const policy = initial.policy?.policy;
  const [revision, setRevision] = useState(initial.policy?.revision ?? 0);
  const [saved, setSaved] = useState(initial);
  const [max, setMax] = useState(String(policy?.max_concurrent_runs ?? 1));
  const [repo, setRepo] = useState(policy && "repo_url" in policy ? policy.repo_url ?? "" : "");
  const [branch, setBranch] = useState(policy && "default_branch" in policy ? policy.default_branch : "main");
  const [pin, setPin] = useState(policy && "pinned_computer_id" in policy ? policy.pinned_computer_id ?? "" : "");
  const [runtimes, setRuntimes] = useState(policy && "required_runtimes" in policy ? policy.required_runtimes.join(", ") : "");
  const [labels, setLabels] = useState(policy && "required_labels" in policy ? policy.required_labels.join(", ") : policy && "labels" in policy ? policy.labels.join(", ") : "");
  const save = useMutation({ mutationFn: async () => {
    const common = { version: 1 as const, max_concurrent_runs: Number(max) };
    if (kind === "project") return api.putSchedulingPolicy(kind, id, revision, SchedulerProjectPolicyV1Schema.parse({ ...common, repo_url: repo.trim() || null, default_branch: branch }));
    if (kind === "agent") return api.putSchedulingPolicy(kind, id, revision, SchedulerAgentPolicyV1Schema.parse({ ...common, pinned_computer_id: pin || null, required_runtimes: split(runtimes), required_labels: split(labels) }));
    return api.putSchedulingPolicy(kind, id, revision, SchedulerComputerPolicyV1Schema.parse({ ...common, labels: split(labels) }));
  }, onSuccess: async (result) => { setSaved(result); setRevision(result.policy?.revision ?? 0); query.setQueryData(queryKeys.schedulingPolicy(kind, id), result); await query.invalidateQueries({ queryKey: queryKeys.projectControlView() }); } });
  const canManage = ["owner", "admin"].includes(bootstrap.user.role);
  return <form className="cowork-resource-form u-stack-sm" aria-label={`${kind} scheduling policy`} onSubmit={(event) => { event.preventDefault(); if (!save.isPending && canManage) save.mutate(); }}><div className="action-row"><Badge>{saved.policy ? `Saved revision ${revision}` : "No saved policy · form defaults only"}</Badge><Badge tone={saved.capacity_admission.shared_quotas_enabled ? "success" : "neutral"}>Shared quotas: {saved.capacity_admission.shared_quotas_enabled ? "enabled" : "disabled"}</Badge>{kind === "project" && <Badge>Project quota: {saved.capacity_admission.project_quota_enabled === null ? "unknown" : saved.capacity_admission.project_quota_enabled ? "enabled" : "disabled"}</Badge>}</div><p>{saved.active ? "Scheduling policy is active according to the server." : "Saving configuration does not enable automatic scheduling. Execution still requires server rollout and task authorization."}</p><fieldset disabled={save.isPending || !canManage} className="u-stack-sm"><Input label="Maximum concurrent Runs" type="number" min={1} max={64} step={1} required value={max} onChange={(event) => setMax(event.target.value)} />{kind === "project" && <><Input label="Repository URL" value={repo} maxLength={2048} onChange={(event) => setRepo(event.target.value)} /><Input label="Default branch" required value={branch} maxLength={255} onChange={(event) => setBranch(event.target.value)} /></>}{kind === "agent" && <><Select label="Pinned machine" value={pin} onChange={(event) => setPin(event.target.value)}><option value="">No configured pin</option>{pin && !bootstrap.computers.some((computer) => computer.id === pin) && <option value={pin}>{pin} (unavailable)</option>}{bootstrap.computers.map((computer) => <option key={computer.id} value={computer.id}>{computer.display_name}</option>)}</Select><Input label="Required runtimes" value={runtimes} helperText="Comma separated runtime identifiers." onChange={(event) => setRuntimes(event.target.value)} /></>}{kind !== "project" && <Input label={kind === "agent" ? "Required machine labels" : "Configured machine labels"} value={labels} helperText="Comma separated labels. These are configuration, separate from detected machine capabilities." onChange={(event) => setLabels(event.target.value)} />}{canManage && <Button type="submit" size="sm" loading={save.isPending}>Save scheduling policy</Button>}</fieldset><ActionError error={save.error} />{save.isError && <p>Your draft is retained. Close and reopen this panel to reload after a concurrent edit.</p>}{save.isSuccess && <p role="status">Scheduling policy saved.</p>}<p>Exact cost metering remains required; cost budgets are disabled.</p></form>;
}
function PolicyData({ kind, id, bootstrap }: { kind: SchedulingPolicyKind; id: string; bootstrap: BootstrapResponse }): React.ReactNode {
  const api = useApi();
  const data = useQuery({ queryKey: queryKeys.schedulingPolicy(kind, id), queryFn: () => api.getSchedulingPolicy(kind, id), refetchOnWindowFocus: false });
  return <><ActionError error={data.error} />{data.data ? <PolicyForm kind={kind} id={id} initial={data.data} bootstrap={bootstrap} /> : <Button size="sm" loading={data.isFetching} onClick={() => void data.refetch()}>Load scheduling policy</Button>}</>;
}
export function SchedulingPolicyEditor({ kind, id, bootstrap }: { kind: SchedulingPolicyKind; id: string; bootstrap: BootstrapResponse }): React.ReactNode {
  const [open, setOpen] = useState(false);
  return <details className="resource-details cowork-policy" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Scheduling policy</summary>{open && <PolicyData kind={kind} id={id} bootstrap={bootstrap} />}</details>;
}
