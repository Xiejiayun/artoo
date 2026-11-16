import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight, Bot, Monitor, Plus, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { useApi } from "../app/ApiContext.js";
import { useProject } from "../app/useProject.js";
import { useProjectControlView } from "../app/useProjectControlView.js";
import { useDaemons } from "../app/useDaemons.js";
import { useProjectSquad } from "../app/useProjectSquad.js";
import { Button, EmptyState, ErrorState, StatusBadge } from "../ui/index.js";
import { ControlTaskFacts } from "./ControlTaskFacts.js";
import { ActionError } from "./ActionError.js";

const ACTIVE_RUNS = new Set(["queued", "starting", "running", "awaiting_input", "paused", "cancelling"]);

/** Global counts and paged evidence have separate, explicit scopes. */
export function OverviewPage(): React.ReactNode {
  const api = useApi();
  const { bootstrap, project, projectId } = useProject();
  const squad = useProjectSquad(projectId, bootstrap.data);
  const control = useProjectControlView(projectId);
  const presence = useDaemons({ enabled: !!bootstrap.data });
  // Reservation aggregation is requested by the user, never per card or poll.
  const capacity = useMutation({ mutationFn: (id: string) => api.getProjectControlView(id, { limit: 1, capacity: true }) });
  const capacityObservation = capacity.variables === projectId ? capacity.data : undefined;
  const capacityError = capacity.variables === projectId ? capacity.error : null;
  const machines = bootstrap.data?.computers ?? [];
  const active = control.entries.filter((entry) => (entry.latest_run && ACTIVE_RUNS.has(entry.latest_run.status)) || (entry.execution_lease && !entry.execution_lease.closed_at));
  const attention = control.entries.filter(({ task, latest_run }) => ["awaiting_approval", "blocked", "review"].includes(task.status) || latest_run?.status === "awaiting_input");
  const summary = control.view?.summary;
  const metrics = [
    { label: "Project tasks", value: summary?.total_tasks },
    { label: "Execution requests", value: summary?.pending_execution_requests },
    { label: "Active leases", value: summary?.active_execution_leases },
    { label: "Running tasks", value: summary?.tasks_by_status.running },
    { label: "Need attention", value: summary ? summary.tasks_by_status.awaiting_approval + summary.tasks_by_status.blocked + summary.tasks_by_status.review : undefined },
  ];
  const instances = squad.instances;
  if (bootstrap.isLoading) return <div className="cowork-page" role="status">Loading mission control…</div>;
  if (bootstrap.isError) return <ErrorState title="Mission control unavailable" description={bootstrap.error.message} action={<Button onClick={() => void bootstrap.refetch()}>Retry</Button>} />;
  return <div className="cowork-page cowork-overview">
    <header className="cowork-page-heading"><div><span className="os-eyebrow">Project team · {project?.name ?? "Workspace"}</span><h1>Mission control</h1><p>See who is working on each machine, what the team is waiting for, and where the next handoff belongs.</p></div><Link className="os-secondary-link" to="/goals"><Plus size={14} aria-hidden="true" />Plan together</Link></header>
    {!projectId ? <EmptyState title="Create your first project" description="Add a project to plan work and connect your agent team." action={<Link to="/settings">Open project settings</Link>} /> : <>
      {control.isError && <ErrorState title="Project observations unavailable" description={control.error.message} action={<Button onClick={() => void control.refetch()}>Retry observations</Button>} />}
      <p className="cowork-snapshot-note">{control.view ? `Project-wide totals · observed ${new Date(control.view.observed_at).toLocaleString()}. Detail lists contain ${control.entries.length} loaded tasks${control.hasNextPage ? " with more available" : ""}.` : "Loading project-wide observations…"}</p>
      <div className="cowork-metrics">{metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{control.isError ? "Unknown" : metric.value ?? "—"}</strong></div>)}<div><span>Workspace machines online</span><strong>{presence.data && !presence.isError ? `${presence.data.daemons.filter((node) => node.connected && node.status === "online").length}/${machines.length}` : "Unknown"}</strong></div></div>
      <section className="cowork-surface"><header><h2><Users size={15} aria-hidden="true" />Team across machines</h2><Link to={`/agents?project=${encodeURIComponent(projectId)}`}>Manage squad <ArrowUpRight size={13} aria-hidden="true" /></Link></header><div className="cowork-team-grid">{instances.map((instance) => {
        const agent = bootstrap.data?.agents.find((item) => item.id === instance.agent_id);
        const machine = machines.find((item) => item.id === instance.computer_id);
        const work = active.filter((entry) => entry.latest_run?.agent_instance_id === instance.id);
        return <article key={instance.id}><span className="os-agent-avatar"><Bot size={16} aria-hidden="true" /></span><div><strong>{agent?.display_name ?? instance.runtime}</strong><small>{machine?.display_name ?? instance.computer_id} · {instance.runtime}</small>{work.map((entry) => <Link key={entry.task.id} to={`/board?task=${encodeURIComponent(entry.task.id)}&project=${encodeURIComponent(projectId)}`}>{entry.task.title}</Link>)}{work.length === 0 && <small>{control.isError ? "Current work unavailable" : "No active work in loaded observations"}</small>}</div></article>;
      })}{squad.agents.filter((agent) => !instances.some((instance) => instance.agent_id === agent.id)).map((agent) => <article key={agent.id}><span className="os-agent-avatar"><Bot size={16} aria-hidden="true" /></span><div><strong>{agent.display_name}</strong><small>Team member · no scoped execution instance</small><Link to={`/computers?agent=${encodeURIComponent(agent.id)}`}>Configure a machine instance</Link></div></article>)}</div><ActionError error={squad.error} />{squad.squad?.agent_ids.length === 0 && <p className="cowork-panel-empty">Configure logical Agents in this project's Squad to build a team across machines.</p>}</section>
      <div className="cowork-overview-grid"><div>
        <section className="cowork-surface"><header><h2>Active work & retained leases</h2><Link to="/board">Open board <ArrowUpRight size={13} aria-hidden="true" /></Link></header>{control.isLoading ? <p className="cowork-panel-empty" role="status">Loading active work…</p> : active.length === 0 ? <p className="cowork-panel-empty">{control.isError ? "Observations unavailable." : "No active work in loaded observations."}</p> : <ul className="cowork-task-rows">{active.map((entry) => <li key={entry.task.id}><Link to={`/board?task=${encodeURIComponent(entry.task.id)}&project=${encodeURIComponent(projectId)}`}><span><strong>{entry.task.title}</strong><ControlTaskFacts entry={entry} bootstrap={bootstrap.data} /></span><StatusBadge status={entry.task.status} /></Link></li>)}</ul>}</section>
        <section className="cowork-surface"><header><h2>Needs your attention</h2><Link to="/board">View tasks <ArrowUpRight size={13} aria-hidden="true" /></Link></header>{attention.length === 0 ? <p className="cowork-panel-empty">{control.isError ? "Observations unavailable." : "No approvals, questions, blockers or reviews in loaded observations."}</p> : <ul className="cowork-task-rows">{attention.map(({ task }) => <li key={task.id}><Link to={`/board?task=${encodeURIComponent(task.id)}&project=${encodeURIComponent(projectId)}`}><span><strong>{task.title}</strong><small>{task.priority.toUpperCase()}</small></span><StatusBadge status={task.status} /></Link></li>)}</ul>}</section>
        {control.hasNextPage && <Button loading={control.isFetchingNextPage} onClick={() => void control.fetchNextPage()}>Load more project observations</Button>}
      </div><aside><section className="cowork-surface"><header><h2><Monitor size={15} aria-hidden="true" />Workspace fleet</h2><Link to="/computers">Manage</Link></header>{presence.isError && <p className="cowork-panel-empty" role="status">Live machine presence unavailable.</p>}{machines.map((machine) => { const node = presence.data?.daemons.find((entry) => entry.computer_id === machine.id); const status = machine.status === "disabled" ? "disabled" : presence.isError ? "unknown" : node ? node.connected ? node.status : "offline" : "unknown"; return <Link key={machine.id} to="/computers" className="cowork-machine-row"><span className="os-status-dot" data-status={status} /><span><strong>{machine.display_name}</strong><small>{machine.os} · {status}</small></span></Link>; })}{machines.length === 0 && <p className="cowork-panel-empty">No connected machines yet.</p>}<Link className="cowork-panel-link" to="/computers?connect=1"><Plus size={13} aria-hidden="true" />Connect a machine</Link></section>
        <section className="cowork-surface"><header><h2>Scheduling capacity</h2></header><div className="cowork-panel-empty"><p>{control.view?.project_policy ? `Configured project limit: ${control.view.project_policy.max_concurrent_runs} runs.` : "Project limit: not configured or unknown."}</p><p>{control.view ? control.view.capacity.project_quota_enabled ? "Project quota enforcement is enabled." : "Project quota enforcement is disabled." : "Quota enforcement is unknown."}</p><p>Observed occupied slots: {capacityObservation?.capacity.occupied ?? "Unknown"}</p>{capacityObservation && <small>Observed {new Date(capacityObservation.observed_at).toLocaleString()}; retained reservations are included.</small>}<ActionError error={capacityError} /><Button size="sm" loading={capacity.isPending} onClick={() => capacity.mutate(projectId)}>Observe occupied capacity</Button><p>Exact cost metering is required. Cost budgets remain disabled.</p></div></section>
      </aside></div>
    </>}
  </div>;
}
