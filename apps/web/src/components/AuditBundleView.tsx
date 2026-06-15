import type { TaskAuditBundle } from "@artoo/domain";

/**
 * Read-only render of a {@link TaskAuditBundle} as product evidence: task
 * summary, scheduler decisions, runs, artifacts, approvals, messages, and the
 * ordered event log (sorted by numeric `position`). Renders existing evidence
 * only — it makes no claim about audit/release completeness (#17 owns that).
 */
export function AuditBundleView({ bundle }: { bundle: TaskAuditBundle }): React.ReactNode {
  const events = [...bundle.events].sort((a, b) => a.position - b.position);

  return (
    <div className="audit-bundle-view">
      <section aria-label="Task summary">
        <h2>{bundle.task.title}</h2>
        <dl>
          <dt>Status</dt>
          <dd>{bundle.task.status}</dd>
          <dt>Priority</dt>
          <dd>{bundle.task.priority}</dd>
          {bundle.task.assignee_id != null ? (
            <>
              <dt>Assignee</dt>
              <dd>
                {bundle.task.assignee_type}:{bundle.task.assignee_id}
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      <section aria-label="Scheduler decisions">
        <h3>Scheduler decisions ({bundle.scheduler_decisions.length})</h3>
        <ul>
          {bundle.scheduler_decisions.map((decision) => (
            <li key={decision.id}>
              {decision.mode} · score {decision.score} · {decision.reason}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Runs">
        <h3>Runs ({bundle.runs.length})</h3>
        <ul>
          {bundle.runs.map((run) => (
            <li key={run.id} data-status={run.status}>
              <span className="run-id">{run.id}</span> · {run.status} · {run.runtime_id}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Artifacts">
        <h3>Artifacts ({bundle.artifacts.length})</h3>
        <ul>
          {bundle.artifacts.map((artifact) => (
            <li key={artifact.id}>
              {artifact.type} · <span className="uri">{artifact.uri}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Approvals">
        <h3>Approvals ({bundle.approvals.length})</h3>
        <ul>
          {bundle.approvals.map((approval) => (
            <li key={approval.id}>
              {approval.action} · {approval.risk} · {approval.status}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Messages">
        <h3>Messages ({bundle.messages.length})</h3>
        <ul>
          {bundle.messages.map((message) => (
            <li key={message.id}>
              {message.actor_type}:{message.actor_id} · {message.kind}
              {message.body !== "" ? ` · ${message.body}` : ""}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Event log">
        <h3>Event log ({events.length})</h3>
        <ol>
          {events.map((entry) => (
            <li key={entry.id} data-position={entry.position}>
              <span className="position">#{entry.position}</span>{" "}
              <span className="type">{entry.type}</span>{" "}
              <span className="actor">
                {entry.actor.type}:{entry.actor.id}
              </span>{" "}
              <span className="at">{entry.occurred_at}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
