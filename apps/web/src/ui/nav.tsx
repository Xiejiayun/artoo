/**
 * Navigation primitives (#66): NavItem, Toolbar, Breadcrumbs. Presentational and
 * router-agnostic — surfaces (#69) wire routing/active state. Implements gate §8
 * "App nav / tabs" (active pill, focus ring, optional count badge) and
 * ui-system-spec §4 nav item states (default/hover/active/focus).
 */
import type { ElementType, ReactNode } from "react";

import { Icon } from "./Icon.js";
import type { LucideIcon } from "lucide-react";
import "./nav.css";

export interface NavItemProps {
  /** Element/component to render as (e.g. react-router NavLink). Default "a". */
  as?: ElementType;
  icon?: LucideIcon;
  active?: boolean;
  /** Optional trailing count (e.g. inbox/pending). */
  count?: number;
  children: ReactNode;
  className?: string;
  // Allow href/to/onClick and other props of the rendered element.
  [key: string]: unknown;
}

/** A single navigation entry: icon + label, with active/hover/focus states. */
export function NavItem({
  as,
  icon,
  active = false,
  count,
  children,
  className,
  ...rest
}: NavItemProps): React.ReactNode {
  const Comp = (as ?? "a") as ElementType;
  const classes = ["ui-nav-item", active ? "is-active" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <Comp className={classes} data-active={active || undefined} {...rest}>
      {icon ? <Icon icon={icon} size={16} /> : null}
      <span className="ui-nav-item__label">{children}</span>
      {typeof count === "number" && count > 0 ? <span className="ui-nav-item__count">{count}</span> : null}
    </Comp>
  );
}

export interface ToolbarProps {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

/** A horizontal action/filter bar with consistent gap and alignment. */
export function Toolbar({ children, className, ...rest }: ToolbarProps): React.ReactNode {
  return (
    <div className={["ui-toolbar", className ?? ""].filter(Boolean).join(" ")} role="toolbar" {...rest}>
      {children}
    </div>
  );
}

/** Pushes following toolbar content to the opposite edge. */
export function ToolbarSpacer(): React.ReactNode {
  return <span className="ui-toolbar__spacer" aria-hidden="true" />;
}

export interface Crumb {
  label: string;
  href?: string;
  onClick?: () => void;
}

/** Breadcrumb trail. The last crumb is the current page (not a link). */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }): React.ReactNode {
  return (
    <nav className={["ui-breadcrumbs", className ?? ""].filter(Boolean).join(" ")} aria-label="Breadcrumb">
      <ol>
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`}>
              {last || (c.href === undefined && c.onClick === undefined) ? (
                <span aria-current={last ? "page" : undefined}>{c.label}</span>
              ) : (
                <a href={c.href} onClick={c.onClick}>
                  {c.label}
                </a>
              )}
              {last ? null : <span className="ui-breadcrumbs__sep" aria-hidden="true">/</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
