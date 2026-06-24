/**
 * Badge / lozenge (#68) + the canonical domain→tone mappings. Implements gate §7
 * (status color paired with a text label, full server enum) and ui-system-spec
 * §6 semantic vocabulary. Every surface badges through these helpers so the same
 * value never renders two ways.
 */
import type { ReactNode } from "react";

import { Icon } from "./Icon.js";
import type { LucideIcon } from "lucide-react";
import "./feedback.css";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

export interface BadgeProps {
  tone?: Tone;
  icon?: LucideIcon;
  /** Small presence/status dot instead of a full lozenge. */
  dot?: boolean;
  children: ReactNode;
  className?: string;
}

/** A compact semantic lozenge. Color is paired with the text label (gate §7). */
export function Badge({ tone = "neutral", icon, dot = false, children, className }: BadgeProps): React.ReactNode {
  const classes = ["ui-badge", `ui-badge--${tone}`, dot ? "ui-badge--dot" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes}>
      {dot ? <span className="ui-badge__dot" aria-hidden="true" /> : icon ? <Icon icon={icon} size={12} /> : null}
      <span className="ui-badge__label">{children}</span>
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * Domain → tone maps (full server enums, see docs/server-ui-contract-map.md §5).
 * Unknown values fall back to neutral so a new enum value never crashes the UI.
 * ------------------------------------------------------------------------- */
const TASK_STATUS_TONE: Record<string, Tone> = {
  backlog: "neutral", ready: "info", assigned: "neutral", running: "info",
  awaiting_approval: "warning", blocked: "danger", review: "warning",
  done: "success", cancelled: "danger",
};
const PRIORITY_TONE: Record<string, Tone> = { p0: "danger", p1: "warning", p2: "accent", p3: "neutral" };
const RUN_STATUS_TONE: Record<string, Tone> = {
  queued: "neutral", starting: "info", running: "info", awaiting_input: "warning",
  paused: "warning", completed: "success", failed: "danger", cancelled: "danger",
};
const PRESENCE_TONE: Record<string, Tone> = { online: "success", stale: "warning", offline: "neutral" };
const TRUST_TONE: Record<string, Tone> = { active: "success", revoked: "danger" };
const APPROVAL_TONE: Record<string, Tone> = {
  pending: "warning", approved: "success", rejected: "danger", needs_more_info: "warning", expired: "neutral",
};
const RISK_TONE: Record<string, Tone> = { low: "neutral", medium: "warning", high: "danger" };

export const toneFor = {
  taskStatus: (v: string): Tone => TASK_STATUS_TONE[v] ?? "neutral",
  priority: (v: string): Tone => PRIORITY_TONE[v] ?? "neutral",
  runStatus: (v: string): Tone => RUN_STATUS_TONE[v] ?? "neutral",
  presence: (v: string): Tone => PRESENCE_TONE[v] ?? "neutral",
  trust: (v: string): Tone => TRUST_TONE[v] ?? "neutral",
  approval: (v: string): Tone => APPROVAL_TONE[v] ?? "neutral",
  risk: (v: string): Tone => RISK_TONE[v] ?? "neutral",
};

const humanize = (v: string): string => v.replace(/_/g, " ");

/** Convenience badges that map a domain value to tone + readable label. */
export const StatusBadge = ({ status }: { status: string }): React.ReactNode => (
  <Badge tone={toneFor.taskStatus(status)} className="ui-badge--status">{humanize(status)}</Badge>
);
export const PriorityBadge = ({ priority }: { priority: string }): React.ReactNode => (
  <Badge tone={toneFor.priority(priority)} className="ui-badge--priority">{priority.toUpperCase()}</Badge>
);
export const RunStatusBadge = ({ status }: { status: string }): React.ReactNode => (
  <Badge tone={toneFor.runStatus(status)}>{humanize(status)}</Badge>
);
export const PresenceBadge = ({ presence }: { presence: string }): React.ReactNode => (
  <Badge tone={toneFor.presence(presence)} dot>{humanize(presence)}</Badge>
);
