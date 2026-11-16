import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Bot, Monitor, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { useApi } from "../app/ApiContext.js";
import { usePollMs, useSubscription } from "../app/RealtimeContext.js";
import { useProject } from "../app/useProject.js";
import { useSelection } from "../app/SelectionContext.js";
import { useDaemons } from "../app/useDaemons.js";
import { Button, EmptyState, ErrorState, StatusBadge } from "../ui/index.js";

const SNAPSHOT_LIMIT = 100;

/** A bounded project snapshot; counts describe loaded tasks, never global totals. */
export function OverviewPage(): React.ReactNode {
  const api = useApi();
  const { setSelectedTaskId } = useSelection();
  const { bootstrap, project, projectId } = useProject();
  const presence = useDaemons({ enabled: !!bootstrap.data });
  const pollMs = usePollMs(5000);
  useSubscription(projectId ? [`project:${projectId}`] : []);
  const tasks = useQuery({
    queryKey: ["tasks", projectId ?? "pending", "overview", SNAPSHOT_LIMIT],
    queryFn: () => api.listTasks(projectId as string, { limit: SNAPSHOT_LIMIT }),
    enabled: !!projectId,
    refetchInterval: pollMs,
  });
  const items = tasks.data?.tasks ?? [];
  const machines = bootstrap.data?.computers ?? [];
  const active = items.filter((task) => task.status === "assigned" || task.status === "running");
  const attention = items.filter((task) => ["awaiting_approval", "blocked", "review"].includes(task.status));
  const metrics = [
    { label: "Ready", value: items.filter((task) => task.status === "ready").length },
    { label: "Assigned", value: items.filter((task) => task.status === "assigned").length },
    { label: "Running", value: items.filter((task) => task.status === "running").length },
    { label: "Needs human", value: attention.length },
  ];
  if (bootstrap.isLoading) return <div className="cowork-page" role="status">Loading mission control…</div>;
  if (bootstrap.isError) return <ErrorState title="Mission control unavailable" description={bootstrap.error.message} action={<Button onClick={() => void bootstrap.refetch()}>Retry</Button>} />;
  return <div className="cowork-page cowork-overview">
    <header className="cowork-page-heading"><div><span className="os-eyebrow">Control plane · {project?.name ?? "Workspace"}</span><h1>Mission control</h1><p>Follow your team, connected machines and work that needs your attention.</p></div><Link className="os-secondary-link" to="/goals"><Plus size={14} aria-hidden="true" />New goal</Link></header>
    {!projectId ? <EmptyState title="Create your first project" description="Add a project to plan work and connect your agent team." action={<Link to="/settings">Open project settings</Link>} /> : <>
      <p className="cowork-snapshot-note">Project task snapshot · up to {SNAPSHOT_LIMIT} loaded tasks. Counts below describe this snapshot.</p>
      {tasks.isError ? <ErrorState title="Task snapshot unavailable" description={tasks.error.message} action={<Button onClick={() => void tasks.refetch()}>Retry</Button>} /> : tasks.isLoading ? <p role="status">Loading project tasks…</p> : <div className="cowork-metrics">{metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}<div><span>Machines connected</span><strong>{presence.data ? `${presence.data.daemons.filter((node) => node.connected && node.status === "online").length}/${machines.length}` : "Unknown"}</strong></div><div><span>Logical agents</span><strong>{bootstrap.data?.agents.length ?? "Unknown"}</strong></div></div>}
      <div className="cowork-overview-grid"><div>
        <section className="cowork-surface"><header><h2>Active work</h2><Link to="/board">Open board <ArrowUpRight size={13} aria-hidden="true" /></Link></header>{active.length === 0 ? <p className="cowork-panel-empty">{tasks.isError ? "Snapshot unavailable." : "No active work in this snapshot."}</p> : <ul className="cowork-task-rows">{active.map((task) => <li key={task.id}><Link to={`/?task=${encodeURIComponent(task.id)}&project=${encodeURIComponent(projectId)}`} onClick={() => setSelectedTaskId(task.id)}><span><strong>{task.title}</strong><small>{task.id}</small></span><StatusBadge status={task.status} /></Link></li>)}</ul>}</section>
        <section className="cowork-surface"><header><h2>Needs your attention</h2><Link to="/board">View tasks <ArrowUpRight size={13} aria-hidden="true" /></Link></header>{attention.length === 0 ? <p className="cowork-panel-empty">{tasks.isError ? "Snapshot unavailable." : "No approvals, blockers or reviews in this snapshot."}</p> : <ul className="cowork-task-rows">{attention.map((task) => <li key={task.id}><Link to={`/?task=${encodeURIComponent(task.id)}&project=${encodeURIComponent(projectId)}`} onClick={() => setSelectedTaskId(task.id)}><span><strong>{task.title}</strong><small>{task.priority.toUpperCase()}</small></span><StatusBadge status={task.status} /></Link></li>)}</ul>}</section>
      </div><aside><section className="cowork-surface"><header><h2><Monitor size={15} aria-hidden="true" />Fleet</h2><Link to="/computers">Manage</Link></header>{presence.isError && <p className="cowork-panel-empty" role="status">Live machine presence unavailable.</p>}{machines.map((machine) => { const node = presence.data?.daemons.find((entry) => entry.computer_id === machine.id); const status = machine.status === "disabled" ? "disabled" : node ? node.connected ? node.status : "offline" : "unknown"; return <Link key={machine.id} to="/computers" className="cowork-machine-row"><span className="os-status-dot" data-status={status} /><span><strong>{machine.display_name}</strong><small>{machine.os} · {status}</small></span></Link>; })}{machines.length === 0 && <p className="cowork-panel-empty">No connected machines yet.</p>}<Link className="cowork-panel-link" to="/computers?connect=1"><Plus size={13} aria-hidden="true" />Connect a machine</Link></section><section className="cowork-surface"><header><h2><Bot size={15} aria-hidden="true" />Project squad</h2><Link to="/agents">Configure</Link></header><p className="cowork-panel-empty">{bootstrap.data?.agent_instances.filter((instance) => instance.project_id === projectId).length ?? 0} execution instances assigned to this project.</p></section></aside></div>
    </>}
  </div>;
}
