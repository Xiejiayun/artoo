import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  Bot,
  Brain,
  ChevronDown,
  Hash,
  LayoutDashboard,
  Monitor,
  Plus,
  Puzzle,
  Settings2,
  Terminal,
} from "lucide-react";
import { useProject } from "../app/useProject.js";
import { useDaemons } from "../app/useDaemons.js";
import { useProjectSquad } from "../app/useProjectSquad.js";
import { LogoutButton } from "./LogoutButton.js";

const RESOURCES = [
  { to: "/skills", label: "Skills", icon: Puzzle },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/runs", label: "Run history", icon: Activity },
];
const PROJECT_PATHS = new Set(["/", "/board", "/goals", "/runs", "/release", "/review", "/channels"]);

/** Project navigation and registered machine inventory share the bootstrap snapshot. */
export function Nav({ onNavigate }: { onNavigate?: () => void } = {}): React.ReactNode {
  const { bootstrap, project, projectId, setSelectedProjectId } = useProject();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const data = bootstrap.data;
  const presence = useDaemons({ enabled: !!data });
  const user = data?.user;
  const canManage = user?.role === "owner" || user?.role === "admin";
  const squad = useProjectSquad(projectId, data);
  const instances = squad.instances;
  const computers = data?.computers ?? [];
  function selectProject(id: string): void {
    setSelectedProjectId(id);
    // Keep the user's view, but drop the previous project's task/goal identity.
    navigate(PROJECT_PATHS.has(pathname) ? pathname : "/board");
    onNavigate?.();
  }
  return (
    <nav className="app-nav" id="primary-navigation" aria-label="Primary">
      <NavLink to="/overview" className="brand" aria-label="ARTOO home" onClick={onNavigate}>
        <span className="brand-mark" aria-hidden="true" />
        <strong>artoo OS</strong>
        <ChevronDown size={14} aria-hidden="true" />
      </NavLink>
      <div className="os-nav-scroll">
        <section className="os-control-plane" aria-label="Control plane">
          <div className="os-section-label">
            <span>Control plane</span>
          </div>
          <ul className="app-nav__links">
            <li>
              <NavLink
                to="/overview"
                onClick={onNavigate}
                className={({ isActive }) => `os-nav-link${isActive ? " is-active" : ""}`}
              >
                <LayoutDashboard size={15} aria-hidden="true" />
                <span>Overview</span>
              </NavLink>
            </li>
            <li>
              <NavLink
                to="/computers"
                onClick={onNavigate}
                className={({ isActive }) => `os-nav-link${isActive ? " is-active" : ""}`}
              >
                <Monitor size={15} aria-hidden="true" />
                <span>Machines</span>
                <span className="os-nav-count">
                  {presence.data
                    ? `${presence.data.daemons.filter((node) => node.connected && node.status === "online").length}/${computers.length}`
                    : "—"}
                </span>
              </NavLink>
            </li>
            <li>
              <NavLink
                to="/agents"
                onClick={onNavigate}
                className={({ isActive }) => `os-nav-link${isActive ? " is-active" : ""}`}
              >
                <Bot size={15} aria-hidden="true" />
                <span>Agents</span>
                <span className="os-nav-count">{data ? data.agents.length : "—"}</span>
              </NavLink>
            </li>
          </ul>
        </section>
        <section className="os-projects" aria-label="Projects">
          <div className="os-section-label">
            <span>Projects</span>
            {canManage && (
              <Link
                to="/settings?create=project"
                className="os-icon-button"
                aria-label="New project"
                onClick={onNavigate}
              >
                <Plus size={14} aria-hidden="true" />
              </Link>
            )}
          </div>
          <ul className="os-project-list">
            {data?.projects.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`os-project${item.id === projectId ? " is-active" : ""}`}
                  aria-label={item.name}
                  aria-describedby={`project-workspace-${item.id}`}
                  aria-pressed={item.id === projectId}
                  onClick={() => selectProject(item.id)}
                  onPointerLeave={(event) => {
                    if (event.pointerType !== "mouse" || item.id !== projectId) return;
                    setSelectedProjectId(null);
                    if (PROJECT_PATHS.has(pathname)) navigate("/overview");
                  }}
                >
                  <Hash size={15} aria-hidden="true" />
                  <span className="os-project-identity">
                    <strong title={item.name}>{item.name}</strong>
                    <small id={`project-workspace-${item.id}`} title={item.default_workspace ?? undefined}>
                      {item.default_workspace || "No default workspace"}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {bootstrap.isLoading && <p className="os-nav-empty">Loading projects…</p>}
          {bootstrap.error && <p className="os-nav-empty">Projects unavailable.</p>}
          {canManage && data?.projects.length === 0 && (
            <Link className="os-nav-empty" to="/settings?create=project" onClick={onNavigate}>
              Create your first project
            </Link>
          )}
        </section>
        <section className="os-resources" aria-label="Workspace resources">
          <div className="os-section-label">
            <span>Workspace tools</span>
          </div>
          <ul className="app-nav__links">
            {RESOURCES.map(({ to, label, icon: ResourceIcon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  onClick={onNavigate}
                  className={({ isActive }) => `os-nav-link${isActive ? " is-active" : ""}`}
                >
                  <ResourceIcon size={16} aria-hidden="true" />
                  <span>{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </section>
        <section className="os-squad" aria-label="Agent Squad">
          <div className="os-section-label">
            <span>Agent Squad</span>
            <span>{squad.squad?.agent_ids.length ?? "—"}</span>
            {projectId && (
              <Link
                to={`/agents?project=${encodeURIComponent(projectId)}`}
                className="os-icon-button"
                aria-label="Manage project squad"
                onClick={onNavigate}
              >
                <Settings2 size={14} aria-hidden="true" />
              </Link>
            )}
          </div>
          <p className="os-squad-description">
            {project ? `Agents assigned to ${project.name}` : "Select a project to see its squad"}
          </p>
          {computers
            .filter((computer) => instances.some((instance) => instance.computer_id === computer.id))
            .map((computer) => {
              const members = instances.filter((instance) => instance.computer_id === computer.id);
              return (
                <div className="os-squad-group" key={computer.id}>
                  <Link to="/computers" className="os-squad-machine" onClick={onNavigate}>
                    <span className="os-status-dot" data-status={computer.status} aria-label={computer.status} />
                    <span>{computer.display_name}</span>
                    <small>{members.length}</small>
                  </Link>
                  {members.map((instance) => {
                    const agent = data?.agents.find((item) => item.id === instance.agent_id);
                    return (
                      <Link
                        key={instance.id}
                        to={`/agents?instance=${encodeURIComponent(instance.id)}`}
                        className="os-squad-agent"
                        onClick={onNavigate}
                      >
                        <span className="os-agent-avatar" aria-hidden="true">
                          <Bot size={13} />
                        </span>
                        <span>
                          <strong>{agent?.display_name ?? instance.runtime}</strong>
                          <small>{instance.runtime}</small>
                        </span>
                        <span
                          className="os-status-dot"
                          data-status={computer.status === "online" ? instance.status : "offline"}
                          title={computer.status === "online" ? instance.status : "Machine offline"}
                        />
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          {squad.agents
            .filter((agent) => !instances.some((instance) => instance.agent_id === agent.id))
            .map((agent) => (
              <Link
                key={agent.id}
                to={`/agents?project=${encodeURIComponent(projectId!)}`}
                className="os-squad-agent"
                onClick={onNavigate}
              >
                <Bot size={13} aria-hidden="true" />
                <span>
                  <strong>{agent.display_name}</strong>
                  <small>No scoped execution instance</small>
                </span>
              </Link>
            ))}
          {squad.isError && <p className="os-nav-empty">Squad observation unavailable.</p>}
          {data && projectId && squad.squad?.agent_ids.length === 0 && (
            <Link to={`/agents?project=${encodeURIComponent(projectId)}`} className="os-nav-empty" onClick={onNavigate}>
              No agents assigned. Set up this project's squad.
            </Link>
          )}
        </section>
      </div>
      <div className="os-nav-footer">
        <section className="os-fleet" aria-label="Fleet">
          <div className="os-section-label">
            <span>Fleet</span>
            <span>{computers.length} machines</span>
          </div>
          <div className="os-fleet-list">
            {computers.map((computer) => {
              const node = presence.data?.daemons.find((entry) => entry.computer_id === computer.id);
              const state =
                computer.status === "disabled"
                  ? "disabled"
                  : node
                    ? node.connected
                      ? node.status
                      : "offline"
                    : "unknown";
              return (
                <Link key={computer.id} to="/computers" onClick={onNavigate} className="os-fleet-machine">
                  <span className="os-status-dot" data-status={state} aria-label={state} />
                  <span>{computer.display_name}</span>
                  <small>{state}</small>
                </Link>
              );
            })}
          </div>
        </section>
        <Link to="/computers?connect=1" className="os-connect-button" onClick={onNavigate}>
          <Terminal size={15} aria-hidden="true" />
          Connect Local Node
          <Plus size={14} aria-hidden="true" />
        </Link>
        <details className="os-account">
          <summary>
            <span className="os-user-avatar">{Array.from(user?.display_name ?? "A")[0]?.toLocaleUpperCase()}</span>
            <span>
              <strong>{user?.display_name ?? "Account"}</strong>
              <small>{data?.organization.name ?? "Workspace"}</small>
            </span>
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <div className="os-account-menu">
            <Link to="/settings" onClick={onNavigate}>
              <Settings2 size={14} aria-hidden="true" />
              Settings
            </Link>
            <LogoutButton />
          </div>
        </details>
      </div>
    </nav>
  );
}
