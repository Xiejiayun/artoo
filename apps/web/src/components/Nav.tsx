import { NavLink } from "react-router-dom";
import { Hash, Settings, Target } from "lucide-react";
import { useProject } from "../app/useProject.js";

import { Icon, Activity, Bot, Brain, LayoutGrid, ListTodo, Puzzle, Server } from "../ui/Icon.js";
import "../ui/nav.css";
import { LogoutButton } from "./LogoutButton.js";
import { ProjectPicker } from "./ProjectPicker.js";
import { NotificationsButton } from "./NotificationsPanel.js";

const LINKS = [
  { to: "/channels", label: "Channels", end: false, icon: Hash },
  { to: "/", label: "Workspace", end: true, icon: ListTodo },
  { to: "/board", label: "Board", end: false, icon: LayoutGrid },
  { to: "/goals", label: "Goals", end: false, icon: Target },
  { to: "/runs", label: "Runs", end: false, icon: Activity },
  { to: "/memory", label: "Memory", end: false, icon: Brain },
  { to: "/agents", label: "Agents", end: false, icon: Bot },
  { to: "/computers", label: "Computers", end: false, icon: Server },
  { to: "/skills", label: "Skills", end: false, icon: Puzzle },
  { to: "/settings", label: "Settings", end: false, icon: Settings },
];

/**
 * Primary product navigation (#69 app shell). A sticky top bar: brand + global
 * surface switcher built on the ui nav primitive (icon + active pill + focus
 * ring), then the account/logout action. Surface IA per
 * docs/production-ui-gate.md §6 (desktop global nav).
 */
export function Nav(): React.ReactNode {
  const { bootstrap } = useProject();
  const user = bootstrap.data?.user;
  return (
    <nav className="app-nav" aria-label="Primary">
      <NavLink to="/channels" className="brand" aria-label="Artoo home"><span className="brand-mark" aria-hidden="true">a</span><span>artoo</span></NavLink>
      <div className="app-nav__project"><span className="app-nav__eyebrow">Your workspace</span><ProjectPicker /></div>
      <ul className="app-nav__links">
        {LINKS.map((link) => (
          <li key={link.to} className={link.to === "/runs" ? "app-nav__section-start" : undefined}>
            <NavLink
              to={link.to}
              end={link.end}
              className={({ isActive }) => `ui-nav-item${isActive ? " is-active" : ""}`}
            >
              <Icon icon={link.icon} size={16} />
              <span className="ui-nav-item__label">{link.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="app-nav__account">
        <NotificationsButton />
        {user && <div className="account-identity"><span className="account-avatar" aria-hidden="true">{Array.from(user.display_name)[0]?.toLocaleUpperCase() ?? "A"}</span><span><strong>{user.display_name}</strong><small>{bootstrap.data?.organization.name ?? "Team workspace"}</small></span></div>}
        <LogoutButton />
      </div>
    </nav>
  );
}
