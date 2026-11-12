import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Box, RefreshCw, SearchX } from "lucide-react";
import { CAPABILITIES, PERMISSION_CATEGORIES, SKILL_API_VERSION, type AgentInstance } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import type { BootstrapResponse } from "../api/types.js";
import { Badge, Button, EmptyState, ErrorState, SearchInput, Select } from "../ui/index.js";
import { SkillInstallForm, SkillPermissionSummary } from "./InventorySetup.js";
import { CAPABILITY_LABELS } from "./taskPresentation.js";
import { matchesSkillSearch, nativeSkillMatchesInstance, skillInstallMatchesInstance, skillInstallSearchText, type NativeSkillEntry } from "./skill-inventory-model.js";
import "./skill-inventory.css";

export function useSkillInventory(bootstrap: BootstrapResponse | undefined) {
  const api = useApi();
  const skillsQuery = useQuery({ queryKey: queryKeys.skillInstalls, queryFn: () => api.listSkillInstalls(), refetchInterval: 10000 });
  const computers = bootstrap?.computers ?? [];
  const runtimeQueries = useQueries({ queries: computers.map((computer) => ({
    queryKey: queryKeys.computerRuntimes(computer.id), queryFn: () => api.listComputerRuntimes(computer.id), refetchInterval: 10000,
  })) });
  const native: NativeSkillEntry[] = computers.flatMap((computer, index) =>
    (runtimeQueries[index]?.data?.runtimes ?? []).flatMap((runtime) =>
      (runtime.native_skills?.skills ?? []).map((skill) => ({ skill, runtime, computer }))));
  return { skillsQuery, runtimeQueries, computers, native, installs: skillsQuery.data?.skills ?? [] };
}
type Inventory = ReturnType<typeof useSkillInventory>;

export function agentSkillSearchText(inventory: Inventory, instance: AgentInstance): string {
  return [...inventory.native.filter((entry) => nativeSkillMatchesInstance(entry, instance)).map(({ skill }) => `${skill.id} ${skill.name} ${skill.description}`),
    ...inventory.installs.filter((skill) => skillInstallMatchesInstance(skill, instance)).map(skillInstallSearchText)].join(" ");
}

export function AgentSkills({ inventory, instance }: { inventory: Inventory; instance: AgentInstance }): React.ReactNode {
  const native = inventory.native.filter((entry) => nativeSkillMatchesInstance(entry, instance));
  const installed = inventory.installs.filter((skill) => skillInstallMatchesInstance(skill, instance));
  const runtimeQuery = inventory.runtimeQueries[inventory.computers.findIndex((computer) => computer.id === instance.computer_id)];
  const runtime = runtimeQuery?.data?.runtimes.find((entry) => entry.runtime === instance.runtime);
  return <section className="agent-skills" aria-label="Agent skills">
    <div className="resource-section-heading"><h3>Skills</h3><span>{native.length} native · {installed.length} installed</span><Link to="/skills">Browse skills</Link></div>
    {runtimeQuery?.isLoading ? <p role="status">Loading native skills…</p> : runtimeQuery?.isError ? <p role="alert">Could not refresh native skills. <Button size="sm" onClick={() => void runtimeQuery.refetch()}>Retry native skills</Button></p> : !runtime?.native_skills ? <p className="resource-muted">Native skills not reported. Reconnect this machine with the updated daemon.</p> : <>
      <p className="resource-muted">Discovered on this machine; runtime settings determine which skills load.{runtime.status !== "available" ? ` Runtime is ${runtime.status}.` : ""}</p>
      {native.length === 0 && <p className="resource-muted">No native skills discovered for this workspace.</p>}
      {(runtime.native_skills.truncated || runtime.native_skills.unreadable_count > 0) && <p className="resource-muted">Discovery is incomplete. Some folders or manifests could not be included.</p>}
    </>}
    {native.length > 0 && <ul className="agent-skills__list">{native.map(({ skill }) => <li key={skill.path}><strong>{skill.name}</strong><Badge>Native · {skill.scope}</Badge><p>{skill.description}</p></li>)}</ul>}
    {inventory.skillsQuery.isLoading ? <p role="status">Loading installed skills…</p> : inventory.skillsQuery.isError ? <p role="alert">Could not refresh installed skills. <Button size="sm" onClick={() => void inventory.skillsQuery.refetch()}>Retry installed skills</Button></p> : installed.length === 0 && <p className="resource-muted">No Artoo skill manifests match this runtime and project.</p>}
    {installed.length > 0 && <><p className="resource-muted">Artoo manifests register capabilities and access; runtime tools and instructions require separate configuration.</p><ul className="agent-skills__list">{installed.map((skill) => <li key={skill.id}><strong>{skill.name}</strong><Badge tone={skill.enabled ? "success" : "neutral"}>{skill.enabled ? "Installed" : "Disabled"}</Badge><p>{skill.manifest.description}</p></li>)}</ul></>}
  </section>;
}

export function SkillCatalogPage(): React.ReactNode {
  const api = useApi();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap(), refetchInterval: 10000 });
  const inventory = useSkillInventory(bootstrap.data);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [state, setState] = useState("all");
  const [runtime, setRuntime] = useState("all");
  const [project, setProject] = useState("all");
  const instances = bootstrap.data?.agent_instances ?? [];
  const agentName = (instance: AgentInstance): string => bootstrap.data?.agents.find((agent) => agent.id === instance.agent_id)?.display_name ?? instance.id;
  const projectName = (id: string | null | undefined): string => bootstrap.data?.projects.find((item) => item.id === id)?.name ?? id ?? "Organization";
  const matchingNativeAgents = (entry: NativeSkillEntry) => instances.filter((instance) => nativeSkillMatchesInstance(entry, instance));
  const native = inventory.native.filter((entry) => source !== "installed" && state === "all" && (runtime === "all" || entry.runtime.runtime === runtime)
    && (project === "all" || matchingNativeAgents(entry).some((instance) => instance.project_id === project))
    && matchesSkillSearch(search, entry.skill.name, entry.skill.id, entry.skill.description, entry.skill.path, entry.runtime.runtime, entry.computer.display_name,
      ...matchingNativeAgents(entry).flatMap((instance) => [agentName(instance), projectName(instance.project_id)])));
  const installed = inventory.installs.filter((skill) => source !== "native" && (runtime === "all" || skill.compatible_runtimes.includes(runtime))
    && (project === "all" || skill.project_id == null || skill.project_id === project)
    && (state === "all" || (state === "enabled" ? skill.enabled : state === "disabled" ? !skill.enabled : skill.permission_summary.risk === "high"))
    && matchesSkillSearch(search, skillInstallSearchText(skill), projectName(skill.project_id),
      ...instances.filter((instance) => skillInstallMatchesInstance(skill, instance)).map(agentName)));
  const allRuntimes = inventory.runtimeQueries.flatMap((query) => query.data?.runtimes ?? []);
  const runtimes = [...new Set([...allRuntimes.map((entry) => entry.runtime), ...inventory.installs.flatMap((skill) => skill.compatible_runtimes)])].sort();
  const loading = bootstrap.isLoading || inventory.skillsQuery.isLoading || inventory.runtimeQueries.some((query) => query.isLoading);
  const clear = (): void => { setSearch(""); setSource("all"); setState("all"); setRuntime("all"); setProject("all"); };
  const refresh = (): void => { void bootstrap.refetch(); void inventory.skillsQuery.refetch(); inventory.runtimeQueries.forEach((query) => void query.refetch()); };
  return <section className="inventory-page resources-page" aria-label="Skills">
    <header className="resources-header"><div className="resources-header__identity"><span className="resources-icon"><Box size={23} aria-hidden="true" /></span><div><p className="resources-eyebrow">Workspace resources</p><h1>Skills</h1><p>Find native runtime skills and installed Artoo manifests, then see which agents they match.</p></div></div><div className="resources-header__actions"><Button iconLeft={RefreshCw} onClick={refresh}>Refresh skills</Button><SkillInstallForm /></div></header>
    <div className="resources-guide"><Box size={19} aria-hidden="true" /><p><strong>Skills across your machines</strong> Search by name, description, runtime, machine or agent. Native discovery does not grant tool access.</p><span>{inventory.native.length} native · {inventory.installs.length} installed</span></div>
    <div className="resources-toolbar skill-filters"><SearchInput aria-label="Search skills" placeholder="Search names, descriptions, runtimes or agents…" value={search} onChange={(event) => setSearch(event.target.value)} onClear={() => setSearch("")} />
      <Select label="Skill source" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option><option value="native">Native runtime skills</option><option value="installed">Artoo installations</option></Select>
      <Select label="Skill runtime" value={runtime} onChange={(event) => setRuntime(event.target.value)}><option value="all">All runtimes</option>{runtimes.map((name) => <option key={name}>{name}</option>)}</Select>
      <Select label="Skill project" value={project} onChange={(event) => setProject(event.target.value)}><option value="all">All projects</option>{bootstrap.data?.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>
      <Select label="Skill state" value={state} onChange={(event) => setState(event.target.value)}><option value="all">All skills</option><option value="enabled">Enabled installations</option><option value="disabled">Disabled installations</option><option value="high">High risk installations</option></Select><span className="resources-count" role="status">{native.length + installed.length} results</span>
    </div>
    {loading && <p role="status">Loading skills...</p>}
    {bootstrap.isError && <ErrorState title="Failed to load machines and agents." action={<Button onClick={() => void bootstrap.refetch()}>Retry machines</Button>} />}
    {inventory.runtimeQueries.some((query) => query.isError) && <ErrorState title="Some machines' native skills could not be refreshed." action={<Button onClick={refresh}>Retry native skills</Button>} />}
    {!loading && native.length + installed.length === 0 && (search || source !== "all" || state !== "all" || runtime !== "all" || project !== "all") && <EmptyState icon={SearchX} title="No matching resources" description="Try another skill name, description, runtime or agent." action={<Button onClick={clear}>Clear filters</Button>} />}
    {source !== "installed" && state === "all" && <section aria-label="Native runtime skills" className="skill-catalog-section"><div className="resource-section-heading"><h2>Native runtime skills</h2><span>{native.length}</span></div>
      <p className="resource-muted">Files discovered in standard skill folders. Runtime settings determine which skills load; permissions are managed by that runtime.</p>
      {allRuntimes.some((entry) => !entry.native_skills) && <p className="resource-form__notice">Some runtimes have not reported native skills. Reconnect their machines with the updated daemon.</p>}
      {allRuntimes.some((entry) => entry.native_skills?.truncated || (entry.native_skills?.unreadable_count ?? 0) > 0) && <p className="resource-form__notice">Some skill folders or manifests could not be included. Discovery is incomplete.</p>}
      {!loading && !bootstrap.isError && inventory.native.length === 0 && !inventory.runtimeQueries.some((query) => query.isError) && <p className="resource-muted">No native skills reported yet. Connect a machine with skills in its standard runtime folders.</p>}
      <div className="resources-grid">{native.map((entry) => <article key={`${entry.runtime.id}:${entry.skill.path}`} aria-label={entry.skill.name} className="resource-card">
        <header className="resource-card__header"><span className="resource-avatar resource-avatar--skill"><Box size={22} aria-hidden="true" /></span><div><h2>{entry.skill.name}</h2><p>{entry.runtime.runtime} · {entry.computer.display_name}</p></div><Badge>Native</Badge></header><p className="resource-description">{entry.skill.description}</p>
        <div className="resource-skill-meta"><span>{entry.skill.scope === "user" ? "User skill" : "Workspace skill"}</span><Badge tone={entry.computer.status === "online" && entry.runtime.status === "available" ? "info" : "neutral"}>{entry.computer.status === "online" ? entry.runtime.status : entry.computer.status}</Badge></div>
        <div className="skill-agent-links"><strong>Matching agent instances</strong>{matchingNativeAgents(entry).length ? matchingNativeAgents(entry).map((instance) => <Link key={instance.id} to={`/agents?instance=${encodeURIComponent(instance.id)}`}>{agentName(instance)}</Link>) : <span>No matching instances registered</span>}</div>
        <details className="resource-details"><summary>Discovery details</summary><dl className="inv-meta"><dt>Skill id</dt><dd>{entry.skill.id}</dd><dt>Source</dt><dd><code>{entry.skill.path}</code></dd>{entry.skill.workspace_root && <><dt>Workspace</dt><dd><code>{entry.skill.workspace_root}</code></dd></>}<dt>Observed</dt><dd><time dateTime={entry.runtime.native_skills!.observed_at}>{new Date(entry.runtime.native_skills!.observed_at).toLocaleString()}</time></dd></dl></details>
      </article>)}</div>
    </section>}
    {source !== "native" && <section aria-label="Installed skills" className="skill-catalog-section"><div className="resource-section-heading"><h2>Artoo installations</h2><span>{installed.length}</span></div><p className="resource-muted">Installed manifests describe capabilities and requested access. Runtime tools and skill instructions require separate configuration.</p>
      {inventory.skillsQuery.isError ? <ErrorState title="Failed to load skills." action={<Button onClick={() => void inventory.skillsQuery.refetch()}>Try again</Button>} /> : !inventory.skillsQuery.isLoading && inventory.installs.length === 0 && <EmptyState icon={Box} title="No skills installed." description="Install an Artoo manifest to register its capabilities and access requirements." />}
      <div className="resources-grid">{installed.map((skill) => <article key={skill.id} aria-label={skill.name} className="resource-card">
        <header className="resource-card__header"><span className="resource-avatar resource-avatar--skill"><Box size={22} aria-hidden="true" /></span><div><h2>{skill.name}</h2><p>Version {skill.version} · {projectName(skill.project_id)}</p></div><Badge tone={skill.enabled ? "success" : "neutral"}>{skill.enabled ? "enabled" : "disabled"}</Badge></header>
        <p className="resource-description">{skill.manifest.description || "No description provided."}</p><ul className="resource-chips" aria-label="Skill capabilities">{skill.capabilities.map((capability) => <li key={capability}>{CAPABILITY_LABELS[capability]}</li>)}</ul>
        <div className="resource-skill-meta"><span>Works with <strong>{skill.compatible_runtimes.join(", ")}</strong></span><Badge tone={skill.permission_summary.risk === "high" ? "danger" : skill.permission_summary.risk === "medium" ? "warning" : "success"}>{skill.permission_summary.risk} risk</Badge></div>
        <div className="skill-agent-links"><strong>Matching agent instances</strong>{instances.filter((instance) => skillInstallMatchesInstance(skill, instance)).map((instance) => <Link key={instance.id} to={`/agents?instance=${encodeURIComponent(instance.id)}`}>{agentName(instance)}</Link>)}</div>
        <details className="resource-details"><summary>Permissions & access <span>{skill.permission_summary.categories.length} categories</span></summary><SkillPermissionSummary permissions={skill.permission_summary} /></details>
        <details className="resource-details"><summary>Installation details</summary><dl className="inv-meta"><dt>Scope</dt><dd>{skill.project_id ?? "organization"}</dd><dt>Skill id</dt><dd><code>{skill.skill_id}</code></dd><dt>Capabilities</dt><dd>{skill.capabilities.join(", ")}</dd><dt>Permission categories</dt><dd>{skill.permission_summary.categories.join(", ")}</dd><dt>Installed by</dt><dd>{skill.installed_by_type}:{skill.installed_by_id}</dd><dt>Updated</dt><dd><time dateTime={skill.updated_at}>{new Date(skill.updated_at).toLocaleString()}</time></dd></dl></details>
      </article>)}</div>
    </section>}
    <details className="resource-reference"><summary>Manifest reference</summary><div><section aria-label="Skill manifest contract"><h2>Manifest contract</h2><p>API version <code>{SKILL_API_VERSION}</code>. Capabilities and compatible runtimes determine where a manifest applies.</p></section><section aria-label="Permission categories"><h2>Permission categories</h2><ul className="resource-chips">{PERMISSION_CATEGORIES.map((category) => <li key={category}>{category}</li>)}</ul></section><section aria-label="Known capabilities"><h2>Known capabilities</h2><ul className="resource-chips">{CAPABILITIES.map((capability) => <li key={capability}>{capability}</li>)}</ul></section></div></details>
  </section>;
}
