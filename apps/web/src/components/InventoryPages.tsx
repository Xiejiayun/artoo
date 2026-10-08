import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Bot, Box, Laptop, Monitor, Plus, SearchX, ShieldCheck, type LucideIcon } from "lucide-react";
import { CAPABILITIES, PERMISSION_CATEGORIES, SKILL_API_VERSION } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Badge, Button, EmptyState, ErrorState, Icon, SearchInput, Select, Skeleton, type Tone } from "../ui/index.js";
import { AgentEnabledControl, AgentRegistration, SkillInstallForm, SkillPermissionSummary } from "./InventorySetup.js";
import { AgentWorkspaceAllocation } from "./AgentWorkspaceAllocation.js";
import { DaemonBadge } from "./DaemonBadge.js";
import { CAPABILITY_LABELS } from "./taskPresentation.js";
import "../ui/resource-management.css";

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
  const [search, setSearch] = useState("");
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap(), refetchInterval: 10000 });
  const computers = bootstrap.data?.computers ?? [];
  const runtimeQueries = useQueries({ queries: computers.map((computer) => ({ queryKey: queryKeys.computerRuntimes(computer.id), queryFn: () => api.listComputerRuntimes(computer.id), enabled: bootstrap.data !== undefined, refetchInterval: 10000 })) });
  if (bootstrap.isLoading) return <InventoryLoading label="Loading computers" />;
  if (bootstrap.isError || !bootstrap.data) return <section className="inventory-page resources-page" aria-label="Computers"><ErrorState title="Failed to load computers" action={<Button onClick={() => void bootstrap.refetch()}>Try again</Button>} /></section>;
  const filtered = computers.map((computer, index) => ({ computer, runtimes: runtimeQueries[index] })).filter(({ computer, runtimes }) => matches(search, computer.display_name, computer.hostname, computer.os, computer.arch, ...computer.capabilities, ...(runtimes?.data?.runtimes.map((runtime) => runtime.runtime) ?? [])));
  return <section className="inventory-page resources-page" aria-label="Computers">
    <ResourceHeader title="Computers" description="The machines that bring your team's work to life." icon={Laptop}><Link className="ui-btn ui-btn--primary ui-btn--md" to="/settings"><Plus size={16} aria-hidden="true" />Connect a computer</Link></ResourceHeader>
    <div className="resources-guide"><Monitor size={18} aria-hidden="true" /><p><strong>Your execution fleet</strong> Connect the desktop app, enroll its computer in Settings, then register an agent workspace below.</p><span>{computers.length} registered</span></div>
    <ResourceSearch title="computers" search={search} onSearch={setSearch} count={filtered.length} />
    {computers.length === 0 ? <EmptyState icon={Laptop} title="No computers registered." description="Connect a Mac or Windows computer to run tasks with your team." /> : filtered.length === 0 ? <NoMatches onClear={() => setSearch("")} /> : <div className="resources-grid">
      {filtered.map(({ computer, runtimes: runtimeQuery }) => {
        const runtimes = runtimeQuery?.data?.runtimes ?? [];
        return <article key={computer.id} aria-label={computer.display_name} className="resource-card">
          <header className="resource-card__header"><span className="resource-avatar resource-avatar--computer"><Monitor size={22} aria-hidden="true" /></span><div><h2>{computer.display_name}</h2><p>{computer.hostname} · {computer.os} / {computer.arch}</p></div></header>
          <DaemonBadge computerId={computer.id} />
          <section className="resource-runtimes" aria-label={`${computer.display_name} runtimes`}><div className="resource-section-heading"><h3>Installed runtimes</h3><span>{runtimes.length}</span></div>
            {runtimeQuery?.isLoading && <p role="status">Loading runtimes...</p>}
            {runtimeQuery?.isError && <div className="resource-inline-error" role="alert"><span>Failed to load runtimes.</span><Button size="sm" onClick={() => void runtimeQuery.refetch()}>Retry runtimes</Button></div>}
            {!runtimeQuery?.isLoading && !runtimeQuery?.isError && runtimes.length === 0 && <p className="resource-muted">No runtimes reported yet. Start the worker on this computer to discover them.</p>}
            <ul className="resource-runtime-list">{runtimes.map((runtime) => <li key={runtime.id}><div><strong>{runtime.runtime}</strong><span>{runtime.version || "Version not reported"}</span></div><Badge tone={invTone(runtime.status)}>{runtime.status}</Badge></li>)}</ul>
          </section>
          <details className="resource-details"><summary>Computer details</summary><dl className="inv-meta"><Row label="Computer ID"><code>{computer.id}</code></Row><Row label="Capabilities">{list(computer.capabilities)}</Row>{runtimes.map((runtime) => <Row key={runtime.id} label={`${runtime.runtime} last seen`}><time dateTime={runtime.last_seen_at ?? undefined}>{timestamp(runtime.last_seen_at)}</time><p>{list(runtime.capabilities)}</p></Row>)}</dl></details>
          <footer className="resource-card__footer"><AgentRegistration computerId={computer.id} computerName={computer.display_name} runtimes={runtimes} /></footer>
        </article>;
      })}
    </div>}
  </section>;
}
export function AgentsPage(): React.ReactNode {
  const api = useApi();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap(), refetchInterval: 10000 });
  if (bootstrap.isLoading) return <InventoryLoading label="Loading agents" />;
  if (!bootstrap.data) return <section className="inventory-page resources-page" aria-label="Agents"><ErrorState title="Failed to load agents" action={<Button onClick={() => void bootstrap.refetch()}>Try again</Button>} /></section>;
  const role = bootstrap.data.user.role;
  const agents = new Map(bootstrap.data.agents.map((agent) => [agent.id, agent]));
  const computers = new Map(bootstrap.data.computers.map((computer) => [computer.id, computer]));
  const models = new Map(bootstrap.data.model_profiles.map((profile) => [profile.id, profile]));
  const efforts = new Map(bootstrap.data.effort_profiles.map((profile) => [profile.id, profile]));
  const instances = bootstrap.data.agent_instances;
  const disabled = (instance: typeof instances[number]): boolean => instance.config.enabled === false || instance.status === "disabled";
  const filtered = instances.filter((instance) => (filter === "all" || (filter === "disabled" ? disabled(instance) : filter === "enabled" ? !disabled(instance) : ["running", "queued", "stopping"].includes(instance.status))) && matches(search, agents.get(instance.agent_id)?.display_name, computers.get(instance.computer_id)?.display_name, instance.id, instance.runtime, instance.workspace_root, ...(agents.get(instance.agent_id)?.capabilities ?? [])));
  return <section className="inventory-page resources-page" aria-label="Agents">
    <ResourceHeader title="Agents" description="Find the right teammate for the next piece of work." icon={Bot}><Link className="ui-btn ui-btn--primary ui-btn--md" to="/computers"><Plus size={16} aria-hidden="true" />Register an agent</Link></ResourceHeader>
    {bootstrap.isError && <div className="resource-inline-error" role="alert"><span>Agent settings could not be refreshed. Showing the last loaded settings.</span><Button size="sm" onClick={() => void bootstrap.refetch()}>Retry agent settings</Button></div>}
    <div className="resources-stats"><div><strong>{instances.length}</strong><span>Agent workspaces</span></div><div><strong>{instances.filter((instance) => !disabled(instance)).length}</strong><span>Enabled for work</span></div><div><strong>{instances.filter((instance) => ["running", "queued", "stopping"].includes(instance.status)).length}</strong><span>Work in progress</span></div></div>
    <ResourceSearch title="agents" search={search} onSearch={setSearch} count={filtered.length}><Select label="Agent state" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All states</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option><option value="working">Working</option></Select></ResourceSearch>
    {instances.length === 0 ? <EmptyState icon={Bot} title="No agent instances registered." description="Open Computers to register a runtime and workspace for your first agent." /> : filtered.length === 0 ? <NoMatches onClear={() => { setSearch(""); setFilter("all"); }} /> : <div className="resources-grid">
      {filtered.map((instance) => {
        const agent = agents.get(instance.agent_id), computer = computers.get(instance.computer_id), model = models.get(instance.model_profile_id ?? ""), effort = efforts.get(instance.effort_profile_id ?? "");
        return <article key={instance.id} aria-label={agent?.display_name ?? instance.id} className="resource-card">
          <header className="resource-card__header"><span className="resource-avatar"><Bot size={22} aria-hidden="true" /></span><div><h2>{agent?.display_name ?? instance.id}</h2><p>{instance.runtime} · {computer?.display_name ?? instance.computer_id}</p></div><Badge tone={disabled(instance) ? "neutral" : "success"}>{disabled(instance) ? "Disabled" : "Enabled"}</Badge></header>
          <div className="resource-work-state"><span>Work state</span><Badge tone={invTone(instance.status)}>{instance.status.replaceAll("_", " ")}</Badge><span>{disabled(instance) ? "New assignments paused" : instance.status === "idle" ? "No active assignment" : instance.status === "failed" ? "Last execution failed" : "Execution in progress"}</span></div>
          <DaemonBadge computerId={instance.computer_id} />
          <dl className="resource-highlights"><div><dt>Model</dt><dd>{model?.name ?? "Not configured"}</dd></div><div><dt>Effort</dt><dd>{effort ? `${effort.effort} · ${effort.max_runtime_minutes}m limit` : "Not configured"}</dd></div></dl>
          <ul className="resource-chips" aria-label="Agent capabilities">{agent?.capabilities.map((capability) => <li key={capability} title={capability}>{CAPABILITY_LABELS[capability] ?? capability}</li>)}</ul>
          <details className="resource-details"><summary>Workspace & configuration</summary><dl className="inv-meta"><Row label="Instance"><code>{instance.id}</code></Row><Row label="Workspace root"><code>{value(instance.workspace_root)}</code></Row><Row label="Model profile">{model ? `${model.name} (${model.provider}/${model.model})` : "Not configured"}</Row><Row label="Effort profile">{effort?.name ?? "Not configured"}</Row></dl><AgentWorkspaceAllocation instance={instance} role={role} computerOs={computer?.os} /></details>
          <footer className="resource-card__footer"><AgentEnabledControl instance={instance} /></footer>
        </article>;
      })}
    </div>}
  </section>;
}
export function SkillsPage(): React.ReactNode {
  const api = useApi();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const skillsQuery = useQuery({ queryKey: queryKeys.skillInstalls, queryFn: () => api.listSkillInstalls() });
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const skills = skillsQuery.data?.skills ?? [];
  const filtered = skills.filter((skill) => (filter === "all" || (filter === "enabled" ? skill.enabled : filter === "disabled" ? !skill.enabled : skill.permission_summary.risk === "high")) && matches(search, skill.name, skill.skill_id, skill.manifest.description, ...skill.capabilities, ...skill.compatible_runtimes));
  return <section className="inventory-page resources-page" aria-label="Skills">
    <ResourceHeader title="Skills" description="Shared capabilities, with clear permissions and scope." icon={Box}><SkillInstallForm /></ResourceHeader>
    <div className="resources-guide"><ShieldCheck size={19} aria-hidden="true" /><p><strong>Know what a skill can access</strong> Review its files, network destinations and approval requirements before installing.</p><span>{skills.length} installed</span></div>
    <ResourceSearch title="skills" search={search} onSearch={setSearch} count={filtered.length}><Select label="Skill state" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All skills</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option><option value="high">High risk</option></Select></ResourceSearch>
    <section aria-label="Installed skills">
      {skillsQuery.isLoading ? <div role="status" className="resource-card">Loading skills...</div> : skillsQuery.isError ? <ErrorState title="Failed to load skills." action={<Button onClick={() => void skillsQuery.refetch()}>Try again</Button>} /> : skills.length === 0 ? <EmptyState icon={Box} title="No skills installed." description="Install a skill to add capabilities to compatible agents in your workspace." /> : filtered.length === 0 ? <NoMatches onClear={() => { setSearch(""); setFilter("all"); }} /> : <div className="resources-grid">
        {filtered.map((skill) => <article key={skill.id} aria-label={skill.name} className="resource-card">
          <header className="resource-card__header"><span className="resource-avatar resource-avatar--skill"><Box size={22} aria-hidden="true" /></span><div><h2>{skill.name}</h2><p>Version {skill.version} · {skill.project_id ? bootstrap.data?.projects.find((project) => project.id === skill.project_id)?.name ?? "Project" : "Organization"}</p></div><Badge tone={skill.enabled ? "success" : "neutral"}>{skill.enabled ? "enabled" : "disabled"}</Badge></header>
          <p className="resource-description">{skill.manifest.description || "Adds shared capabilities to compatible agent runtimes."}</p>
          <ul className="resource-chips" aria-label="Skill capabilities">{skill.capabilities.map((capability) => <li key={capability} title={capability}>{CAPABILITY_LABELS[capability] ?? capability}</li>)}</ul>
          <div className="resource-skill-meta"><span>Works with <strong>{list(skill.compatible_runtimes)}</strong></span><Badge tone={invTone(skill.permission_summary.risk)}>{skill.permission_summary.risk} risk</Badge></div>
          <details className="resource-details"><summary>Permissions & access <span>{skill.permission_summary.categories.length} categories</span></summary><SkillPermissionSummary permissions={skill.permission_summary} /></details>
          <details className="resource-details"><summary>Installation details</summary><dl className="inv-meta"><Row label="Scope">{skill.project_id ?? "organization"}</Row><Row label="Skill id"><code>{skill.skill_id}</code></Row><Row label="Capabilities">{list(skill.capabilities)}</Row><Row label="Permission categories">{list(skill.permission_summary.categories)}</Row><Row label="Installed by">{skill.installed_by_type}:{skill.installed_by_id}</Row><Row label="Updated"><time dateTime={skill.updated_at}>{timestamp(skill.updated_at)}</time></Row></dl></details>
        </article>)}
      </div>}
    </section>
    <details className="resource-reference"><summary>Manifest reference</summary><div><section aria-label="Skill manifest contract"><h2>Manifest contract</h2><p>API version <code>{SKILL_API_VERSION}</code>. Capabilities and compatible runtimes determine where a skill can be used.</p></section><section aria-label="Permission categories"><h2>Permission categories</h2><ul className="resource-chips">{PERMISSION_CATEGORIES.map((category) => <li key={category}>{category}</li>)}</ul></section><section aria-label="Known capabilities"><h2>Known capabilities</h2><ul className="resource-chips">{CAPABILITIES.map((capability) => <li key={capability}>{capability}</li>)}</ul></section></div></details>
  </section>;
}
