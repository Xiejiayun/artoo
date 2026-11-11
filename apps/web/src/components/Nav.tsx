import { Link, NavLink, useNavigate } from "react-router-dom";
import { Activity, Bot, Brain, ChevronDown, FolderGit2, Hash, Monitor, Plus, Puzzle, Settings2, Terminal } from "lucide-react";
import { useProject } from "../app/useProject.js";
import { LogoutButton } from "./LogoutButton.js";

const RESOURCES = [
  { to: "/computers", label: "Machines", icon: Monitor },
  { to: "/agents", label: "Agent library", icon: Bot },
  { to: "/skills", label: "Skills", icon: Puzzle },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/runs", label: "Run history", icon: Activity },
];

/** Project navigation and registered machine inventory share the bootstrap snapshot. */
export function Nav({ onNavigate }: { onNavigate?: () => void } = {}): React.ReactNode {
  const { bootstrap, project, projectId, setSelectedProjectId } = useProject();
  const navigate = useNavigate();
  const data = bootstrap.data;
  const user = data?.user;
  const instances = data?.agent_instances ?? [];
  const computers = data?.computers ?? [];
  function selectProject(id: string): void {
    setSelectedProjectId(id);
    navigate("/channels");
    onNavigate?.();
  }
  return <nav className="app-nav" id="primary-navigation" aria-label="Primary">
    <NavLink to="/channels" className="brand" aria-label="Artoo home" onClick={onNavigate}><span className="brand-mark" aria-hidden="true" /><strong>artoo <span>OS</span></strong></NavLink>
    <div className="os-nav-scroll">
      <section className="os-projects" aria-label="Projects">
        <div className="os-section-label"><span>Projects</span><Link to="/settings" className="os-icon-button" aria-label="Manage projects" onClick={onNavigate}><Plus size={14} aria-hidden="true" /></Link></div>
        <ul className="os-project-list">{data?.projects.map((item) => <li key={item.id}><button type="button" className={`os-project${item.id === projectId ? " is-active" : ""}`} aria-pressed={item.id === projectId} onClick={() => selectProject(item.id)}><Hash size={16} aria-hidden="true" /><span>{item.name}</span>{item.id === projectId && <span className="os-project-indicator" aria-hidden="true" />}</button></li>)}</ul>
        {bootstrap.isLoading && <p className="os-nav-empty">Loading projects…</p>}
        {bootstrap.error && <p className="os-nav-empty">Projects unavailable.</p>}
        {data && data.projects.length === 0 && <Link className="os-nav-empty" to="/settings" onClick={onNavigate}>Create your first project</Link>}
      </section>
      <section className="os-resources" aria-label="Workspace resources"><div className="os-section-label"><span>Workspace</span></div><ul className="app-nav__links">{RESOURCES.map(({ to, label, icon: ResourceIcon }) => <li key={to}><NavLink to={to} onClick={onNavigate} className={({ isActive }) => `os-nav-link${isActive ? " is-active" : ""}`}><ResourceIcon size={16} aria-hidden="true" /><span>{label}</span>{to === "/computers" && data && <span className="os-nav-count" aria-hidden="true">{computers.length}</span>}</NavLink></li>)}</ul></section>
      {project?.default_workspace && <div className="os-workspace-context"><FolderGit2 size={15} aria-hidden="true" /><div><strong>{project.name}</strong><code title={project.default_workspace}>{project.default_workspace}</code></div></div>}
      <section className="os-squad" aria-label="Agent Squad"><div className="os-section-label"><span>Agent Squad</span><span>{instances.length}</span></div>
        <p className="os-squad-description">Agents on your connected machines</p>
        {computers.map((computer) => {
          const members = instances.filter((instance) => instance.computer_id === computer.id);
          return <div className="os-squad-group" key={computer.id}><Link to="/computers" className="os-squad-machine" onClick={onNavigate}><span className="os-status-dot" data-status={computer.status} aria-label={computer.status} /><span>{computer.display_name}</span><small>{members.length}</small></Link>
            {members.map((instance) => {
              const agent = data?.agents.find((item) => item.id === instance.agent_id);
              return <Link key={instance.id} to="/agents" className="os-squad-agent" onClick={onNavigate}><span className="os-agent-avatar" aria-hidden="true"><Bot size={13} /></span><span><strong>{agent?.display_name ?? instance.runtime}</strong><small>{instance.runtime}</small></span><span className="os-status-dot" data-status={computer.status === "online" ? instance.status : "offline"} title={computer.status === "online" ? instance.status : "Machine offline"} /></Link>;
            })}
            {members.length === 0 && <span className="os-squad-empty">No instances yet</span>}
          </div>;
        })}
        {data && computers.length === 0 && <p className="os-nav-empty">Connect a machine to bring your agents online.</p>}
      </section>
    </div>
    <div className="os-nav-footer"><Link to="/computers?connect=1" className="os-connect-button" onClick={onNavigate}><Terminal size={15} aria-hidden="true" />Connect Local Node<Plus size={14} aria-hidden="true" /></Link>
      <details className="os-account"><summary><span className="os-user-avatar">{Array.from(user?.display_name ?? "A")[0]?.toLocaleUpperCase()}</span><span><strong>{user?.display_name ?? "Account"}</strong><small>{data?.organization.name ?? "Workspace"}</small></span><ChevronDown size={14} aria-hidden="true" /></summary><div className="os-account-menu"><Link to="/settings" onClick={onNavigate}><Settings2 size={14} aria-hidden="true" />Settings</Link><LogoutButton /></div></details>
    </div>
  </nav>;
}
