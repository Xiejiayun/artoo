import { ChevronRight, FolderOpen, Menu, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useProject } from "../app/useProject.js";
import { useGoalContext } from "../app/useGoalContext.js";
import { NotificationsButton } from "./NotificationsPanel.js";
import { ThemeControl } from "./ThemeControl.js";
import { CommandPalette } from "./CommandPalette.js";

const TABS = [
  { to: "/channels", label: "Thread", number: "01" },
  { to: "/goals", label: "Plan", number: "02" },
  { to: "/", label: "Workspace", number: "03" },
  { to: "/board", label: "Board", number: "04" },
  { to: "/release", label: "Release", number: "05" },
];
const TITLES: Record<string, string> = {
  "/computers": "Machines & agents",
  "/agents": "Agent library",
  "/skills": "Skills",
  "/memory": "Memory",
  "/runs": "Run history",
  "/settings": "Settings",
};

export function ProductHeader({
  onToggleMenu,
  menuOpen,
  detailsOpen,
  onToggleDetails,
  connectionIndicator,
}: {
  onToggleMenu: () => void;
  menuOpen: boolean;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  connectionIndicator?: ReactNode;
}): React.ReactNode {
  const { pathname, search } = useLocation();
  const { project, bootstrap } = useProject();
  const title = /^\/agents\/[^/]+\/history$/.test(pathname) ? "Agent history" : TITLES[pathname];
  const { goal } = useGoalContext(
    pathname === "/goals" || pathname === "/release",
    !title && (pathname !== "/channels" || new URLSearchParams(search).has("goal")),
  );
  const destination = (to: string): string =>
    !goal
      ? to
      : to === "/channels"
        ? goal.room_id
          ? `/channels?goal=${encodeURIComponent(goal.id)}&room=${encodeURIComponent(goal.room_id)}&project=${encodeURIComponent(goal.project_id)}`
          : to
        : `${to}?goal=${encodeURIComponent(goal.id)}`;
  const user = bootstrap.data?.user;
  return (
    <header className="os-header">
      <button
        type="button"
        className="os-icon-button os-menu-toggle"
        onClick={onToggleMenu}
        aria-label="Toggle navigation"
        aria-expanded={menuOpen}
        aria-controls="primary-navigation"
      >
        <Menu size={18} aria-hidden="true" />
      </button>
      <div className="os-breadcrumb">
        <FolderOpen size={16} aria-hidden="true" />
        <span>{project?.name ?? "Workspace"}</span>
        <ChevronRight size={13} aria-hidden="true" />
        <strong>{title ?? TABS.find((tab) => tab.to === pathname)?.label.toLowerCase() ?? "Task detail"}</strong>
      </div>
      {!title && (
        <nav className="os-tabs" aria-label="Project views">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={destination(tab.to)}
              end={tab.to === "/"}
              className={({ isActive }) => `os-tab${isActive ? " is-active" : ""}`}
            >
              <span className="os-tab-number" aria-hidden="true">
                {tab.number}
              </span>
              {tab.label}
            </NavLink>
          ))}
        </nav>
      )}
      <div className="os-header-actions">
        {connectionIndicator}
        <CommandPalette blocked={menuOpen} />
        <NotificationsButton />
        <ThemeControl />
        {pathname === "/" && (
          <button
            type="button"
            className="os-icon-button"
            aria-label="Toggle task details"
            aria-pressed={detailsOpen}
            onClick={onToggleDetails}
          >
            <PanelRight size={16} aria-hidden="true" />
          </button>
        )}
        {user && (
          <span className="os-user-avatar" title={user.display_name}>
            {Array.from(user.display_name)[0]?.toLocaleUpperCase() ?? "A"}
          </span>
        )}
      </div>
    </header>
  );
}
