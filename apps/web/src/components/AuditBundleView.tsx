import type { TaskAuditBundle } from "@artoo/domain";
import { Activity, FileText, ShieldCheck } from "lucide-react";

import { Badge, PriorityBadge, RunStatusBadge, StatusBadge, toneFor } from "../ui/index.js";
import type { BootstrapResponse } from "../api/types.js";
import { taskAssigneeName } from "./taskPresentation.js";
import "../ui/work-insights.css";

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
export function AuditBundleView({ bundle, bootstrap }: { bundle: TaskAuditBundle; bootstrap?: BootstrapResponse }): React.ReactNode {
  const events = [...bundle.events].sort((a, b) => a.position - b.position);

  return (
    <div className="audit-bundle-view insights-evidence">
      <section className="audit-section" aria-label="Task summary">
        <header className="audit-section__head">
          <h2 className="t-h2">{bundle.task.title}</h2>
          <StatusBadge status={bundle.task.status} />
          <PriorityBadge priority={bundle.task.priority} />
        </header>
        {bundle.task.description && <p className="insights-prose">{bundle.task.description}</p>}
        <div className="insights-evidence-summary"><span><Activity size={15} aria-hidden="true" />{bundle.runs.length} {bundle.runs.length === 1 ? "run" : "runs"}</span><span><FileText size={15} aria-hidden="true" />{bundle.artifacts.length} {bundle.artifacts.length === 1 ? "artifact" : "artifacts"}</span><span><ShieldCheck size={15} aria-hidden="true" />{bundle.approvals.length} {bundle.approvals.length === 1 ? "approval" : "approvals"}</span></div>
        {bundle.task.assignee_id != null ? (
          <p className="t-small t-subtle" title={bundle.task.assignee_id}>
            Assigned to {taskAssigneeName(bundle.task, bootstrap)}
          </p>
        ) : null}
      </section>

      <section className="audit-section" aria-label="Scheduler decisions">
        <h3 className="audit-section__title">
          Scheduler decisions <Count n={bundle.scheduler_decisions.length} />
        </h3>
        {bundle.scheduler_decisions.length === 0 && <p className="insights-help">No assignment decisions recorded.</p>}
        <ul className="audit-list">
          {bundle.scheduler_decisions.map((decision) => (
            <li key={decision.id}>
              <strong>{decision.mode === "auto" ? "Automatic assignment" : "Manual assignment"}</strong><p className="insights-help">{decision.reason.replaceAll("_", " ")}</p><details className="insights-disclosure"><summary>Decision details</summary><p>{decision.mode} · score {decision.score} · {decision.reason}</p></details>
            </li>
          ))}
        </ul>
      </section>

      <section className="audit-section" aria-label="Runs">
        <h3 className="audit-section__title">
          Runs <Count n={bundle.runs.length} />
        </h3>
        {bundle.runs.length === 0 && <p className="insights-help">No runs yet. Execution history will appear here.</p>}
        <ul className="audit-list">
          {[...bundle.runs].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((run, index) => (
            <li key={run.id} data-status={run.status} className="insights-run">
              <div className="insights-section-heading"><strong>Run {index + 1}</strong><RunStatusBadge status={run.status} /><span className="t-subtle">{run.runtime_id}</span></div>
              <time className="insights-help" dateTime={run.created_at}>{new Date(run.created_at).toLocaleString()}</time>
              {run.failure_reason && <p className="insights-warning">{run.failure_reason}</p>}
              <details className="insights-disclosure"><summary>Run references</summary><dl><dt>Run</dt><dd className="run-id t-mono">{run.id}</dd><dt>Computer</dt><dd>{run.computer_id}</dd>{run.workspace_branch && <><dt>Branch</dt><dd>{run.workspace_branch}</dd></>}</dl></details>
            </li>
          ))}
        </ul>
      </section>

      <section className="audit-section" aria-label="Artifacts">
        <h3 className="audit-section__title">
          Artifacts <Count n={bundle.artifacts.length} />
        </h3>
        {bundle.artifacts.length === 0 && <p className="insights-help">No artifacts recorded.</p>}
        <ul className="audit-list">
          {bundle.artifacts.map((artifact) => (
            <li key={artifact.id} className="audit-row">
              <Badge tone="neutral">{artifact.type}</Badge>
              <strong>{typeof artifact.metadata.filename === "string" ? artifact.metadata.filename : "Artifact"}</strong><details className="insights-disclosure"><summary>Location and origin</summary><span className="uri t-mono">{artifact.uri}</span><p>{artifact.run_id ?? "Originating run not recorded"}</p></details>
            </li>
          ))}
        </ul>
      </section>

      <section className="audit-section" aria-label="Approvals">
        <h3 className="audit-section__title">
          Approvals <Count n={bundle.approvals.length} />
        </h3>
        {bundle.approvals.length === 0 && <p className="insights-help">No approval decisions recorded.</p>}
        <ul className="audit-list">
          {bundle.approvals.map((approval) => (
            <li key={approval.id} className="audit-row">
              <span className="t-mono">{approval.action}</span>
              <Badge tone={toneFor.risk(approval.risk)}>{approval.risk} risk</Badge>
              <Badge tone={toneFor.approval(approval.status)}>{approval.status}</Badge>
              <p className="insights-prose">{approval.summary}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="audit-section" aria-label="Messages">
        <h3 className="audit-section__title">
          Messages <Count n={bundle.messages.length} />
        </h3>
        {bundle.messages.length === 0 && <p className="insights-help">No messages recorded.</p>}
        <ul className="audit-list">
          {bundle.messages.map((message) => (
            <li key={message.id} className="insights-audit-message">
              <span className="insights-help">
                {message.actor_type}:{message.actor_id}
              </span>{" "}
              · {message.kind}
              {message.body !== "" ? <p className="insights-prose">{message.body}</p> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="audit-section" aria-label="Event log">
        <h3 className="audit-section__title">
          Event log <Count n={events.length} />
        </h3>
        {events.length === 0 && <p className="insights-help">No events recorded.</p>}
        <ol className="audit-events">
          {events.map((entry) => (
            <li key={entry.id} data-position={entry.position} className="audit-event">
              <span className="position t-mono">#{entry.position}</span>
              <span className="type">{entry.type}</span>
              <span className="actor t-subtle">
                {entry.actor.type}:{entry.actor.id}
              </span>
              <time className="at t-subtle" dateTime={entry.occurred_at}>{new Date(entry.occurred_at).toLocaleString()}</time>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
