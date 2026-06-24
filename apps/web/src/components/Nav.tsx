import { NavLink } from "react-router-dom";

import { Icon, Activity, Bot, Brain, LayoutGrid, ListTodo, Puzzle, Server } from "../ui/Icon.js";
import "../ui/nav.css";
import { LogoutButton } from "./LogoutButton.js";

const LINKS = [
  { to: "/", label: "Workspace", end: true, icon: ListTodo },
  { to: "/board", label: "Board", end: false, icon: LayoutGrid },
  { to: "/runs", label: "Runs", end: false, icon: Activity },
  { to: "/memory", label: "Memory", end: false, icon: Brain },
  { to: "/agents", label: "Agents", end: false, icon: Bot },
  { to: "/computers", label: "Computers", end: false, icon: Server },
  { to: "/skills", label: "Skills", end: false, icon: Puzzle },
];

/**
 * Primary product navigation (#69 app shell). A sticky top bar: brand + global
 * surface switcher built on the ui nav primitive (icon + active pill + focus
 * ring), then the account/logout action. Surface IA per
 * docs/production-ui-gate.md §6 (desktop global nav).
 */
export function Nav(): React.ReactNode {
  return (
    <nav className="app-nav" aria-label="Primary">
      <span className="brand">artoo</span>
      <ul className="app-nav__links">
        {LINKS.map((link) => (
          <li key={link.to}>
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
      <span className="app-nav__spacer" />
      <LogoutButton />
    </nav>
  );
}
