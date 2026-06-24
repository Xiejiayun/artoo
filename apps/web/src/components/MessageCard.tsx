import { normalizeMessageKind, type Message } from "@artoo/domain";

import { Badge, type Tone } from "../ui/index.js";

/**
 * Renders a single task-room message as an activity-feed row (#73): actor
 * avatar + identity, timestamp, and a defensively-read body. The payload is
 * opaque (Record<string, unknown>) — we read it defensively and never infer
 * lifecycle state here (codex guardrail). Unknown kinds degrade to a system
 * notice via normalizeMessageKind.
 */
export function MessageCard({ message }: { message: Message }): React.ReactNode {
  const kind = normalizeMessageKind(message.kind);
  const actor = `${message.actor_type}:${message.actor_id}`;
  return (
    <article className="msg" data-kind={kind} aria-label={`${kind} message`}>
      <span className="msg__avatar" aria-hidden="true">
        {initials(message.actor_id, message.actor_type)}
      </span>
      <div className="msg__main">
        <header className="msg__meta">
          <span className="msg__actor">{actor}</span>
          {kindBadge(kind)}
          <time className="msg__time" dateTime={message.created_at}>
            {formatTime(message.created_at)}
          </time>
        </header>
        {renderBody(kind, message)}
      </div>
    </article>
  );
}

function initials(actorId: string, actorType: string): string {
  const source = actorId.length > 0 ? actorId : actorType;
  return source.slice(0, 2).toUpperCase();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const KIND_BADGE: Partial<Record<ReturnType<typeof normalizeMessageKind>, { tone: Tone; label: string }>> = {
  approval_request: { tone: "warning", label: "Approval" },
  approval_result: { tone: "info", label: "Approval" },
  artifact: { tone: "accent", label: "Artifact" },
  run_event: { tone: "neutral", label: "Run" },
};

function kindBadge(kind: ReturnType<typeof normalizeMessageKind>): React.ReactNode {
  const spec = KIND_BADGE[kind];
  return spec ? <Badge tone={spec.tone}>{spec.label}</Badge> : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function renderBody(kind: ReturnType<typeof normalizeMessageKind>, message: Message): React.ReactNode {
  const payload = message.payload as Record<string, unknown>;
  switch (kind) {
    case "approval_request":
      return <p className="msg__text">Approval requested: {readString(payload.action) ?? message.body}</p>;
    case "approval_result":
      return (
        <p className="msg__text">
          Approval {readString(payload.status) ?? "resolved"}
          {message.body ? `: ${message.body}` : ""}
        </p>
      );
    case "artifact":
      return (
        <p className="msg__text">
          Artifact: {readString(payload.uri) ?? readString(payload.type) ?? message.body}
        </p>
      );
    case "run_event":
      return <pre className="msg__code">{message.body.length > 0 ? message.body : JSON.stringify(payload)}</pre>;
    case "system_notice":
      return <p className="msg__text msg__text--notice">{message.body}</p>;
    default:
      return <p className="msg__text">{message.body}</p>;
  }
}
