import type { TaskAuditBundle } from "@artoo/domain";

import { Badge, PriorityBadge, RunStatusBadge, StatusBadge, toneFor } from "../ui/index.js";

function Count({ n }: { n: number }): React.ReactNode {
  return <Badge tone="neutral">{n}</Badge>;
}

/**
 * Read-only render of a {@link TaskAuditBundle} as product evidence: task
 * summary, scheduler decisions, runs, artifacts, approvals, messages, and the
 * ordered event log (sorted by numeric `position`). Renders existing evidence
 * only — it makes no claim about audit/release completeness (#17 owns that).
 * Strictly read-only: this view renders no interactive controls.
 */
export function AuditBundleView({ bundle }: { bundle: TaskAuditBundle }): React.ReactNode {
  const events = [...bundle.events].sort((a, b) => a.position - b.position);

  return (
    <div className="audit-bundle-view">
      <section className="audit-section" aria-label="Task summary">
        <header className="audit-section__head">
          <h2 className="t-h3">{bundle.task.title}</h2>
          <StatusBadge status={bundle.task.status} />
          <PriorityBadge priority={bundle.task.priority} />
        </header>
        {bundle.task.assignee_id != null ? (
          <p className="t-small t-subtle">
            Assignee {bundle.task.assignee_type}:{bundle.task.assignee_id}
          </p>
        ) : null}
      </section>

      <section className="audit-section" aria-label="Scheduler decisions">
        <h3 className="audit-section__title">
          Scheduler decisions <Count n={bundle.scheduler_decisions.length} />
        </h3>
        <ul className="audit-list">
          {bundle.scheduler_decisions.map((decision) => (
            <li key={decision.id}>
              <span className="t-mono">{decision.mode}</span> · score {decision.score} · {decision.reason}
            </li>
          ))}
        </ul>
      </section>

      <section className="audit-section" aria-label="Runs">
        <h3 className="audit-section__title">
          Runs <Count n={bundle.runs.length} />
        </h3>
        <ul className="audit-list">
          {bundle.runs.map((run) => (
            <li key={run.id} data-status={run.status} className="audit-row">
              <span className="run-id t-mono">{run.id}</span>
              <RunStatusBadge status={run.status} />
              <span className="t-subtle">{run.runtime_id}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="audit-section" aria-label="Artifacts">
        <h3 className="audit-section__title">
          Artifacts <Count n={bundle.artifacts.length} />
        </h3>
        <ul className="audit-list">
          {bundle.artifacts.map((artifact) => (
            <li key={artifact.id} className="audit-row">
              <Badge tone="neutral">{artifact.type}</Badge>
              <span className="uri t-mono">{artifact.uri}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="audit-section" aria-label="Approvals">
        <h3 className="audit-section__title">
          Approvals <Count n={bundle.approvals.length} />
        </h3>
        <ul className="audit-list">
          {bundle.approvals.map((approval) => (
            <li key={approval.id} className="audit-row">
              <span className="t-mono">{approval.action}</span>
              <Badge tone={toneFor.risk(approval.risk)}>{approval.risk}</Badge>
              <Badge tone={toneFor.approval(approval.status)}>{approval.status}</Badge>
            </li>
          ))}
        </ul>
      </section>

      <section className="audit-section" aria-label="Messages">
        <h3 className="audit-section__title">
          Messages <Count n={bundle.messages.length} />
        </h3>
        <ul className="audit-list">
          {bundle.messages.map((message) => (
            <li key={message.id}>
              <span className="t-mono">
                {message.actor_type}:{message.actor_id}
              </span>{" "}
              · {message.kind}
              {message.body !== "" ? ` · ${message.body}` : ""}
            </li>
          ))}
        </ul>
      </section>

      <section className="audit-section" aria-label="Event log">
        <h3 className="audit-section__title">
          Event log <Count n={events.length} />
        </h3>
        <ol className="audit-events">
          {events.map((entry) => (
            <li key={entry.id} data-position={entry.position} className="audit-event">
              <span className="position t-mono">#{entry.position}</span>
              <span className="type">{entry.type}</span>
              <span className="actor t-subtle">
                {entry.actor.type}:{entry.actor.id}
              </span>
              <span className="at t-subtle">{entry.occurred_at}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
