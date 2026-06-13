import { normalizeMessageKind, type Message } from "@artoo/domain";

/**
 * Renders a single task-room message. The payload is opaque (Record<string,
 * unknown>) — we read it defensively and never infer lifecycle state here
 * (codex guardrail). Unknown kinds degrade to a system notice via
 * normalizeMessageKind.
 */
export function MessageCard({ message }: { message: Message }): React.ReactNode {
  const kind = normalizeMessageKind(message.kind);
  return (
    <article className="message-card" data-kind={kind} aria-label={`${kind} message`}>
      <header className="message-meta">
        <span className="actor">
          {message.actor_type}:{message.actor_id}
        </span>
        <time>{message.created_at}</time>
      </header>
      {renderBody(kind, message)}
    </article>
  );
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function renderBody(kind: ReturnType<typeof normalizeMessageKind>, message: Message): React.ReactNode {
  const payload = message.payload as Record<string, unknown>;
  switch (kind) {
    case "approval_request":
      return (
        <p className="approval-request">
          Approval requested: {readString(payload.action) ?? message.body}
        </p>
      );
    case "approval_result":
      return (
        <p className="approval-result">
          Approval {readString(payload.status) ?? "resolved"}
          {message.body ? `: ${message.body}` : ""}
        </p>
      );
    case "artifact":
      return (
        <p className="artifact-ref">
          Artifact: {readString(payload.uri) ?? readString(payload.type) ?? message.body}
        </p>
      );
    case "run_event":
      return <pre className="run-event">{message.body.length > 0 ? message.body : JSON.stringify(payload)}</pre>;
    case "system_notice":
      return <p className="system-notice">{message.body}</p>;
    default:
      return <p className="text">{message.body}</p>;
  }
}
