import { ChevronRight, FolderOpen, Menu, PanelRight } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { useProject } from "../app/useProject.js";
import { NotificationsButton } from "./NotificationsPanel.js";
import { ThemeControl } from "./ThemeControl.js";

const TABS = [
  { to: "/channels", label: "Thread", number: "01" },
  { to: "/goals", label: "Plan", number: "02" },
  { to: "/board", label: "Board", number: "03" },
  { to: "/release", label: "Release", number: "04" },
];
const TITLES: Record<string, string> = {
  "/computers": "Machines & agents", "/agents": "Agent library", "/skills": "Skills",
  "/memory": "Memory", "/runs": "Run history", "/settings": "Settings",
};

export function ProductHeader({ onToggleMenu, menuOpen, detailsOpen, onToggleDetails }: {
  onToggleMenu: () => void; menuOpen: boolean; detailsOpen: boolean; onToggleDetails: () => void;
}): React.ReactNode {
  const { pathname } = useLocation();
  const { project, bootstrap } = useProject();
  const title = TITLES[pathname];
  const user = bootstrap.data?.user;
  return <header className="os-header">
    <button type="button" className="os-icon-button os-menu-toggle" onClick={onToggleMenu} aria-label="Toggle navigation" aria-expanded={menuOpen} aria-controls="primary-navigation"><Menu size={18} aria-hidden="true" /></button>
    <div className="os-breadcrumb"><FolderOpen size={16} aria-hidden="true" /><span>{project?.name ?? "Workspace"}</span><ChevronRight size={13} aria-hidden="true" /><strong>{title ?? TABS.find((tab) => tab.to === pathname)?.label.toLowerCase() ?? "Task detail"}</strong></div>
    {!title && <nav className="os-tabs" aria-label="Project views">{TABS.map((tab) => <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `os-tab${isActive || (tab.to === "/board" && pathname === "/") ? " is-active" : ""}`}><span className="os-tab-number" aria-hidden="true">{tab.number}</span>{tab.label}</NavLink>)}</nav>}
    <div className="os-header-actions"><NotificationsButton /><ThemeControl />{pathname === "/" && <button type="button" className="os-icon-button" aria-label="Toggle task details" aria-pressed={detailsOpen} onClick={onToggleDetails}><PanelRight size={16} aria-hidden="true" /></button>}{user && <span className="os-user-avatar" title={user.display_name}>{Array.from(user.display_name)[0]?.toLocaleUpperCase() ?? "A"}</span>}</div>
  </header>;
}
