import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bot, Laptop, Monitor, Plus, SearchX, type LucideIcon } from "lucide-react";
import { useApi } from "../app/ApiContext.js";
import { useDaemons } from "../app/useDaemons.js";
import { usePollMs } from "../app/RealtimeContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Badge, Button, EmptyState, ErrorState, Icon, SearchInput, Select, Skeleton, type Tone } from "../ui/index.js";
import { AgentEnabledControl, AgentRegistration } from "./InventorySetup.js";
import { AgentProjectControl } from "./AgentProjectControl.js";
import { AgentWorkspaceAllocation } from "./AgentWorkspaceAllocation.js";
import { AgentSkills, SkillCatalogPage, agentSkillSearchText, useSkillInventory } from "./SkillInventory.js";
import { matchesSkillSearch } from "./skill-inventory-model.js";
import { DeleteResource, ResourceLifetime } from "./ResourceLifecycleControls.js";
import { DaemonBadge } from "./DaemonBadge.js";
import { ConnectNodeDialog } from "./ConnectNodeDialog.js";
import { CAPABILITY_LABELS } from "./taskPresentation.js";
import "../ui/resource-management.css";
import "./machine-management.css";

const matches = (search: string, ...values: (string | undefined | null)[]): boolean => values.join(" ").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
const value = (input: string | null | undefined): string => input || "Not configured";
const list = (values: readonly string[] | undefined): string => values?.length ? values.join(", ") : "None declared";
const timestamp = (input: string | null | undefined): string => input && !Number.isNaN(Date.parse(input)) ? new Date(input).toLocaleString() : "Not reported";
function invTone(status: string): Tone {
  if (["online", "available", "enabled", "active", "ready", "completed", "low"].includes(status)) return "success";
  if (["stale", "degraded", "awaiting_input", "paused", "pending", "medium", "queued", "stopping"].includes(status)) return "warning";
  if (["error", "failed", "revoked", "blocked", "high"].includes(status)) return "danger";
  if (["busy", "running", "starting"].includes(status)) return "info";
  return "neutral";
}
function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return <div className="inv-row"><dt>{label}</dt><dd>{children}</dd></div>;
}
function ResourceHeader({ title, description, icon, children }: { title: string; description: string; icon: LucideIcon; children?: React.ReactNode }): React.ReactNode {
  return <header className="resources-header"><div className="resources-header__identity"><span className="resources-icon"><Icon icon={icon} size={23} /></span><div><p className="resources-eyebrow">Workspace resources</p><h1>{title}</h1><p>{description}</p></div></div><div className="resources-header__actions">{children}</div></header>;
}
function ResourceSearch({ title, search, onSearch, count, children }: { title: string; search: string; onSearch: (value: string) => void; count: number; children?: React.ReactNode }): React.ReactNode {
  return <div className="resources-toolbar"><SearchInput aria-label={`Search ${title}`} placeholder={`Search ${title}…`} value={search} onChange={(event) => onSearch(event.target.value)} onClear={() => onSearch("")} />{children}<span className="resources-count" role="status">{count} {count === 1 ? "result" : "results"}</span></div>;
}
function NoMatches({ onClear }: { onClear: () => void }): React.ReactNode {
  return <EmptyState icon={SearchX} title="No matching resources" description="Try a different name, runtime or capability." action={<Button onClick={onClear}>Clear filters</Button>} />;
}
function InventoryLoading({ label }: { label: string }): React.ReactNode {
  return <section className="inventory-page resources-page"><p className="inventory-loading-label" role="status" aria-label={label}>{label}</p><Skeleton height={80} /><div className="resources-grid" aria-hidden="true">{[0, 1].map((i) => <div key={i} className="resource-card"><Skeleton height={22} width="55%" /><Skeleton height={96} /></div>)}</div></section>;
}
export function ComputersPage(): React.ReactNode {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const connectOpen = params.get("connect") === "1";
  const [createOnMachine, setCreateOnMachine] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const poll10s = usePollMs(10000);
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap(), refetchInterval: poll10s });
  const presence = useDaemons();
  const computers = bootstrap.data?.computers ?? [];
  const runtimeQueries = useQueries({ queries: computers.map((computer) => ({ queryKey: queryKeys.computerRuntimes(computer.id), queryFn: () => api.listComputerRuntimes(computer.id), enabled: bootstrap.data !== undefined, refetchInterval: poll10s })) });
  if (bootstrap.isLoading) return <InventoryLoading label="Loading computers" />;
  if (bootstrap.isError || !bootstrap.data) return <section className="inventory-page resources-page" aria-label="Computers"><ErrorState title="Failed to load computers" action={<Button onClick={() => void bootstrap.refetch()}>Try again</Button>} /></section>;
  const filtered = computers.map((computer, index) => ({ computer, runtimes: runtimeQueries[index] })).filter(({ computer, runtimes }) => matches(search, computer.display_name, computer.hostname, computer.os, computer.arch, ...computer.capabilities, ...(runtimes?.data?.runtimes.map((runtime) => runtime.runtime) ?? [])));
  const openConnect = (): void => { const next = new URLSearchParams(params); next.set("connect", "1"); setParams(next); };
  const closeConnect = (): void => { const next = new URLSearchParams(params); next.delete("connect"); setParams(next, { replace: true }); };
  const onlineCount = presence.data?.daemons.filter((machine) => machine.status === "online" && machine.connected).length;
  return <section className="inventory-page resources-page machines-page" aria-label="Computers">
    <ResourceHeader title="Machines & agents" description="Connect your computers. Give your agents a place to work." icon={Laptop}><Button variant="primary" iconLeft={Plus} onClick={openConnect}>Connect Local Node</Button></ResourceHeader>
    <div className="machines-overview">
      <div className="machines-summary"><span>{computers.length} {computers.length === 1 ? "machine" : "machines"}</span><span>{onlineCount === undefined ? "Checking connections…" : `${onlineCount} online`}</span><span>{bootstrap.data.agent_instances.length} {bootstrap.data.agent_instances.length === 1 ? "instance" : "instances"}</span></div>
      <div className="machines-runtime-summary" aria-label="Installed runtimes by machine">{["codex", "claude-code"].map((kind) => <span key={kind}><span className="runtime-dot" aria-hidden="true" />{kind === "codex" ? "Codex" : "Claude Code"}<strong>{runtimeQueries.some((result) => !result.data || result.isError) ? "—" : runtimeQueries.filter((result) => result.data?.runtimes.some((runtime) => runtime.runtime === kind && runtime.status === "available")).length}</strong><small>machines</small></span>)}</div>
    </div>
    <ResourceSearch title="computers" search={search} onSearch={setSearch} count={filtered.length} />
    {computers.length === 0 ? <EmptyState icon={Laptop} title="Bring your first machine online" description="Run one command locally, then choose an Agent to create its first instance." action={<Button variant="primary" onClick={openConnect}>Connect Local Node</Button>} /> : filtered.length === 0 ? <NoMatches onClear={() => setSearch("")} /> : <div className="machines-list">
      {filtered.map(({ computer, runtimes: runtimeQuery }) => {
        const runtimes = runtimeQuery?.data?.runtimes ?? [];
        const instances = bootstrap.data!.agent_instances.filter((instance) => instance.computer_id === computer.id);
        const folders = presence.data?.daemons.find((machine) => machine.computer_id === computer.id)?.workspace_roots?.paths ?? [];
        return <article key={computer.id} aria-label={computer.display_name} className="resource-card machine-card">
          <header className="resource-card__header"><span className="resource-avatar resource-avatar--computer"><Monitor size={22} aria-hidden="true" /></span><div><h2>{computer.display_name}</h2><p>{computer.hostname} · {computer.os} / {computer.arch}</p></div><DaemonBadge computerId={computer.id} compact /></header>
          {computer.lifecycle?.state === "expired" && <p className="machine-expiry-notice"><Badge tone="warning">Expired</Badge>Reconnect this computer and its runtime to restore availability.</p>}
          <section className="resource-runtimes" aria-label={`${computer.display_name} runtimes`}><div className="resource-section-heading"><h3>Installed runtimes</h3><span>{runtimes.length}</span></div>
            {runtimeQuery?.isLoading && <p role="status">Loading runtimes...</p>}
            {runtimeQuery?.isError && <div className="resource-inline-error" role="alert"><span>Failed to load runtimes.</span><Button size="sm" onClick={() => void runtimeQuery.refetch()}>Retry runtimes</Button></div>}
            {!runtimeQuery?.isLoading && !runtimeQuery?.isError && runtimes.length === 0 && <p className="resource-muted">No runtimes reported yet. Start the worker on this computer to discover them.</p>}
            <ul className="resource-runtime-list">{runtimes.map((runtime) => <li key={runtime.id}><div><strong>{runtime.runtime}</strong><span>{runtime.version || "Version not reported"}</span></div><Badge tone={invTone(runtime.status)}>{runtime.status}</Badge></li>)}</ul>
          </section>
          <section className="machine-instances" aria-label={`${computer.display_name} instances`}><div className="resource-section-heading"><h3>Agent instances</h3><span>{instances.length}</span><div className="machine-instance-actions"><AgentRegistration computerId={computer.id} computerName={computer.display_name} runtimes={runtimes} allowedRoots={folders} preferredAgentId={params.get("agent") ?? undefined} openRequest={createOnMachine === computer.id || params.get("create") === computer.id} onOpened={() => { setCreateOnMachine(null); if (params.has("create")) { const next = new URLSearchParams(params); next.delete("create"); setParams(next, { replace: true }); } }} /></div></div>
            {instances.length === 0 ? <p className="resource-muted">No instances yet. Create one to give an Agent a workspace here.</p> : <ul>{instances.map((instance) => {
              const agent = bootstrap.data!.agents.find((item) => item.id === instance.agent_id);
              return <li key={instance.id}><span className="machine-instance-avatar"><Bot size={16} aria-hidden="true" /></span><div><Link to={`/agents?instance=${encodeURIComponent(instance.id)}`}>{agent?.display_name ?? "Agent"}</Link><span>{instance.runtime}</span></div><Badge tone={invTone(instance.status)}>{instance.status}</Badge></li>;
            })}</ul>}
          </section>
          <details className="resource-details machine-details"><summary>Computer details</summary><div className="machine-details__content">
            <ResourceLifetime lifecycle={computer.lifecycle} />
            <dl className="inv-meta"><Row label="Computer ID"><code>{computer.id}</code></Row><Row label="Capabilities">{list(computer.capabilities)}</Row>{runtimes.map((runtime) => <Row key={runtime.id} label={`${runtime.runtime} last seen`}><time dateTime={runtime.last_seen_at ?? undefined}>{timestamp(runtime.last_seen_at)}</time><p>{list(runtime.capabilities)}</p></Row>)}{instances.map((instance) => <Row key={instance.id} label={`${bootstrap.data!.agents.find((agent) => agent.id === instance.agent_id)?.display_name ?? "Agent"} workspace`}><code>{instance.workspace_root || "Workspace not set"}</code></Row>)}</dl>
            <div className="machine-details__actions"><DeleteResource kind="computer" id={computer.id} name={computer.display_name} role={bootstrap.data!.user.role} /></div>
          </div></details>
        </article>;
      })}
    </div>}
    <ConnectNodeDialog open={connectOpen} onClose={closeConnect} onCreateInstance={(id) => { setSearch(""); setCreateOnMachine(id); }} />
  </section>;
}
export function AgentsPage(): React.ReactNode {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const selectedInstance = params.get("instance");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap(), refetchInterval: usePollMs(10000) });
  const skillInventory = useSkillInventory(bootstrap.data);
  if (bootstrap.isLoading) return <InventoryLoading label="Loading agents" />;
  if (!bootstrap.data) return <section className="inventory-page resources-page" aria-label="Agents"><ErrorState title="Failed to load agents" action={<Button onClick={() => void bootstrap.refetch()}>Try again</Button>} /></section>;
  const role = bootstrap.data.user.role;
  const agents = new Map(bootstrap.data.agents.map((agent) => [agent.id, agent]));
  const computers = new Map(bootstrap.data.computers.map((computer) => [computer.id, computer]));
  const models = new Map(bootstrap.data.model_profiles.map((profile) => [profile.id, profile]));
  const efforts = new Map(bootstrap.data.effort_profiles.map((profile) => [profile.id, profile]));
  const instances = bootstrap.data.agent_instances;
  const selected = instances.find((instance) => instance.id === selectedInstance);
  const clearInstanceFilters = (): void => {
    setSearch("");
    setFilter("all");
    const next = new URLSearchParams(params);
    next.delete("instance");
    next.delete("project");
    setParams(next, { replace: true });
  };
  const disabled = (instance: typeof instances[number]): boolean => instance.config.enabled === false || instance.status === "disabled";
  const projectScope = params.get("project") ?? "all";
  const emptySquad = bootstrap.data.projects.some((project) => project.id === projectScope)
    && !instances.some((instance) => instance.project_id === projectScope);
  const filtered = instances.filter((instance) => (projectScope === "all" || (projectScope === "unassigned" ? !instance.project_id : instance.project_id === projectScope)) && (!selectedInstance || instance.id === selectedInstance) && (filter === "all" || (filter === "expired" ? instance.lifecycle?.state === "expired" : filter === "disabled" ? disabled(instance) : filter === "enabled" ? !disabled(instance) : ["running", "queued", "stopping"].includes(instance.status))) && matchesSkillSearch(search, agents.get(instance.agent_id)?.display_name, computers.get(instance.computer_id)?.display_name, instance.id, instance.runtime, instance.workspace_root, agentSkillSearchText(skillInventory, instance), ...(agents.get(instance.agent_id)?.capabilities ?? [])));
  return <section className="inventory-page resources-page agents-page" aria-label="Agents">
    <ResourceHeader title="Agents" description="Reusable teammates, with an instance wherever they work." icon={Bot}>{["owner", "admin"].includes(role) && <Link className="ui-btn ui-btn--primary ui-btn--md" to="/computers"><Plus size={16} aria-hidden="true" />Create an instance</Link>}</ResourceHeader>
    {bootstrap.isError && <div className="resource-inline-error" role="alert"><span>Agent settings could not be refreshed. Showing the last loaded settings.</span><Button size="sm" onClick={() => void bootstrap.refetch()}>Retry agent settings</Button></div>}
    <div className="resources-stats"><div><strong>{instances.length}</strong><span>Agent workspaces</span></div><div><strong>{instances.filter((instance) => !disabled(instance) && instance.lifecycle?.state !== "expired").length}</strong><span>Enabled for work</span></div><div><strong>{instances.filter((instance) => ["running", "queued", "stopping"].includes(instance.status)).length}</strong><span>Work in progress</span></div></div>
    <section className="agent-library" aria-label="Agent library">
      <div className="resource-section-heading"><h2>Agent library</h2><span>{agents.size} identities</span></div>
      <p className="resource-muted">Choose an Agent to create an instance on a machine or workspace.</p>
      <div className="agent-library__list">{[...agents.values()].map((agent) => <div key={agent.id} className="agent-library__card">
        <div className="agent-library__identity"><span className="machine-instance-avatar"><Bot size={17} aria-hidden="true" /></span><div><strong>{agent.display_name}</strong><span>{instances.filter((instance) => instance.agent_id === agent.id).length} instances · {agent.kind}</span></div>{agent.lifecycle?.state === "expired" && <Badge tone="warning">Expired</Badge>}</div>
        {["owner", "admin"].includes(role) && <Link className="ui-btn ui-btn--secondary ui-btn--sm" to={`/computers?agent=${encodeURIComponent(agent.id)}`}>Create instance</Link>}
        <Link className="ui-btn ui-btn--secondary ui-btn--sm" to={`/agents/${encodeURIComponent(agent.id)}/history`}>View history</Link>
        {(agent.lifecycle || ["owner", "admin"].includes(role)) && <details className="resource-details agent-library__details"><summary>Agent details</summary><ResourceLifetime lifecycle={agent.lifecycle} /><DeleteResource kind="agent" id={agent.id} name={agent.display_name} role={role} /></details>}
      </div>)}</div>
    </section>
    <section className="agent-instances" aria-label="Agent instances">
    <div className="resource-section-heading"><h2>Instances</h2><span>Workspaces and runtime settings</span></div>
    <ResourceSearch title="agents" search={search} onSearch={setSearch} count={filtered.length}><Select label="Project scope" value={projectScope} onChange={(event) => { const next = new URLSearchParams(params); next.set("project", event.target.value); next.delete("instance"); setParams(next); }}><option value="all">All projects</option><option value="unassigned">Unassigned</option>{bootstrap.data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</Select><Select label="Agent state" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All states</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option><option value="working">Working</option><option value="expired">Expired</option></Select></ResourceSearch>
    {selected && <div className="agent-selection"><p>Selected instance: <strong>{agents.get(selected.agent_id)?.display_name ?? selected.id}</strong></p><Button size="sm" onClick={clearInstanceFilters}>Show all instances</Button></div>}
    {selectedInstance && !selected ? <EmptyState icon={Bot} title="This instance is no longer available" description="It may have been removed. Choose another instance from the list." action={<Button onClick={clearInstanceFilters}>Show all instances</Button>} /> : emptySquad ? <EmptyState icon={Bot} title="This project's squad is empty" description="Create an instance for this project, or choose an existing instance and set its Project squad." action={<Button onClick={clearInstanceFilters}>Choose an existing instance</Button>} /> : instances.length === 0 ? <EmptyState icon={Bot} title="No agent instances registered." description="Open Machines to create an instance for your first Agent." /> : filtered.length === 0 ? <NoMatches onClear={clearInstanceFilters} /> : <div className="resources-grid">
      {filtered.map((instance) => {
        const agent = agents.get(instance.agent_id), computer = computers.get(instance.computer_id), model = models.get(instance.model_profile_id ?? ""), effort = efforts.get(instance.effort_profile_id ?? "");
        return <article key={instance.id} aria-label={agent?.display_name ?? instance.id} className="resource-card">
          <header className="resource-card__header"><span className="resource-avatar"><Bot size={22} aria-hidden="true" /></span><div><h2>{agent?.display_name ?? instance.id}</h2><p>{instance.runtime} · {computer?.display_name ?? instance.computer_id}</p></div><Badge tone={disabled(instance) ? "neutral" : "success"}>{disabled(instance) ? "Disabled" : "Enabled"}</Badge></header>
          <div className="resource-work-state"><span>Work state</span><Badge tone={invTone(instance.status)}>{instance.status.replaceAll("_", " ")}</Badge><span>{disabled(instance) ? "New assignments paused" : instance.status === "idle" ? "No active assignment" : instance.status === "failed" ? "Last execution failed" : "Execution in progress"}</span></div>
          <DaemonBadge computerId={instance.computer_id} />
          <dl className="resource-highlights"><div><dt>Model</dt><dd>{model?.name ?? "Not configured"}</dd></div><div><dt>Effort</dt><dd>{effort ? `${effort.effort} · ${effort.max_runtime_minutes}m limit` : "Not configured"}</dd></div></dl>
          <ul className="resource-chips" aria-label="Agent capabilities">{agent?.capabilities.map((capability) => <li key={capability} title={capability}>{CAPABILITY_LABELS[capability] ?? capability}</li>)}</ul>
          <AgentSkills inventory={skillInventory} instance={instance} />
          <details className="resource-details"><summary>Workspace & configuration</summary><dl className="inv-meta"><Row label="Instance"><code>{instance.id}</code></Row><Row label="Workspace root"><code>{value(instance.workspace_root)}</code></Row><Row label="Model profile">{model ? `${model.name} (${model.provider}/${model.model})` : "Not configured"}</Row><Row label="Effort profile">{effort?.name ?? "Not configured"}</Row></dl><AgentWorkspaceAllocation instance={instance} role={role} computerOs={computer?.os} /></details>
          <AgentProjectControl key={`${instance.id}:${instance.project_id ?? ""}`} instance={instance} projects={bootstrap.data!.projects} role={role} />
          <ResourceLifetime lifecycle={instance.lifecycle} />
          <footer className="resource-card__footer"><Link className="ui-btn ui-btn--secondary ui-btn--sm" to={`/agents/${encodeURIComponent(instance.agent_id)}/history?instance_id=${encodeURIComponent(instance.id)}`}>Instance history</Link><AgentEnabledControl instance={instance} /><DeleteResource kind="instance" id={instance.id} name={agent?.display_name ?? instance.id} role={role} /></footer>
        </article>;
      })}
    </div>}
    </section>
  </section>;
}
export function SkillsPage(): React.ReactNode {
  return <SkillCatalogPage />;
}
