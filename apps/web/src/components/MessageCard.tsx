import { DiscussionPlanPreviewSchema, normalizeMessageKind, type Message } from "@artoo/domain";

import { Badge, type Tone } from "../ui/index.js";

/**
 * Renders a single task-room message as an activity-feed row (#73): actor
 * avatar + identity, timestamp, and a defensively-read body. The payload is
 * opaque (Record<string, unknown>) — we read it defensively and never infer
 * lifecycle state here (codex guardrail). Unknown kinds degrade to a system
 * notice via normalizeMessageKind.
 */
export function MessageCard({ message, actorName, mentionNames = [] }: { message: Message; actorName?: string; mentionNames?: string[] }): React.ReactNode {
  const kind = normalizeMessageKind(message.kind);
  const actor = actorName ?? `${message.actor_type}:${message.actor_id}`;
  return (
    <article className="msg" data-kind={kind} aria-label={`${kind} message`}>
      <span className="msg__avatar" aria-hidden="true">
        {initials(actorName ?? message.actor_id, message.actor_type)}
      </span>
      <div className="msg__main">
        <header className="msg__meta">
          <span className="msg__actor">{actor}</span>
          {kindBadge(kind)}
          {typeof message.payload["assistant_turn_id"] === "string" && <Badge tone="accent">{message.actor_type === "agent" ? "Agent reply" : "Agent request"}</Badge>}
          <time className="msg__time" dateTime={message.created_at}>
            {formatTime(message.created_at)}
          </time>
        </header>
        {renderBody(kind, message)}
        {mentionNames.length > 0 && <p className="msg__mentions" aria-label="Mentioned people">{mentionNames.map((name) => `@${name}`).join(" ")}</p>}
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

const PLAN_DEPENDENCY_LABELS = [
  ["blocks", "Depends on"],
  ["artifact_required", "Requires artifact from"],
  ["contract_required", "Requires contract from"],
  ["review_required", "Requires review from"],
  ["soft_context", "Context from"],
] as const;

function renderBody(kind: ReturnType<typeof normalizeMessageKind>, message: Message): React.ReactNode {
  const payload = message.payload as Record<string, unknown>;
  // This is server-provided display metadata for a discussion's synthesis.
  // Message text and user-supplied payloads never identify an agent plan.
  if (message.actor_type === "agent" && message.kind === "text") {
    const preview = DiscussionPlanPreviewSchema.safeParse(payload.discussion_plan);
    if (preview.success) {
      const plan = preview.data;
      return <section className="msg__plan" aria-label="Suggested plan">
        <h3>Suggested plan</h3>
        {plan.rationale && <p className="msg__text">{plan.rationale}</p>}
        <ol className="msg__plan-tasks" aria-label="Suggested tasks">
          {plan.task_specs.map((spec, index) => <li key={index}>
            <h4>{index + 1}. {spec.title}</h4>
            {spec.description && <p className="msg__text">{spec.description}</p>}
            <p className="msg__plan-label">Acceptance criteria</p>
            <ul className="msg__plan-items">{spec.acceptance_criteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
            {PLAN_DEPENDENCY_LABELS.map(([type, label]) => {
              const dependencies = spec.dependencies.filter((dependency) => dependency.type === type);
              return dependencies.length > 0 ? <p key={type}><strong>{label}:</strong> {dependencies.map((dependency) => plan.task_specs[Number(dependency.ref)]?.title ?? dependency.ref).join(", ")}</p> : null;
            })}
            {spec.required_capabilities.length > 0 && <p><strong>Required capabilities:</strong> {spec.required_capabilities.join(", ")}</p>}
            {spec.expected_artifacts.length > 0 && <>
              <p className="msg__plan-label">Expected artifacts</p>
              <ul className="msg__plan-items">{spec.expected_artifacts.map((artifact, i) => <li key={i}><strong>{artifact.type}</strong>{artifact.description && `: ${artifact.description}`}</li>)}</ul>
            </>}
          </li>)}
        </ol>
        <details className="msg__plan-original"><summary>Show original reply</summary><pre className="msg__code">{message.body}</pre></details>
      </section>;
    }
  }
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
