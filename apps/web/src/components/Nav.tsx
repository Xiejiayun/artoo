import { NavLink } from "react-router-dom";

import { LogoutButton } from "./LogoutButton.js";

const LINKS = [
  { to: "/", label: "Workspace", end: true },
  { to: "/board", label: "Board", end: false },
  { to: "/computers", label: "Computers", end: false },
  { to: "/agents", label: "Agents", end: false },
  { to: "/skills", label: "Skills", end: false },
  { to: "/memory", label: "Memory", end: false },
  { to: "/runs", label: "Runs", end: false },
];

/** Primary product navigation. */
export function Nav(): React.ReactNode {
  return (
    <nav className="app-nav" aria-label="Primary">
      <span className="brand">artoo</span>
      <ul>
        {LINKS.map((link) => (
          <li key={link.to}>
            <NavLink
              to={link.to}
              end={link.end}
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              {link.label}
            </NavLink>
          </li>
        ))}
      </ul>
      <LogoutButton />
    </nav>
  );
}
