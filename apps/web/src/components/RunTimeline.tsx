import type { Run } from "@artoo/domain";

import { RunStatusBadge } from "../ui/index.js";

export interface RunTimelineProps {
  runs: Run[];
  /** run_id -> stdout/stderr lines, derived from run.output events. */
  outputsByRun?: Record<string, string[]>;
  renderUsage?: (run: Run) => React.ReactNode;
}

/**
 * Right-pane run timeline (#74). A task has 1..N runs (retry creates a new run);
 * newest first. Each run is a step card with a semantic status badge; failure
 * reasons surface inline and output is collapsed by default so high-frequency
 * stdout never floods the panel.
 */
export function RunTimeline({ runs, outputsByRun = {}, renderUsage }: RunTimelineProps): React.ReactNode {
  if (runs.length === 0) {
    return <p className="no-runs">No runs yet.</p>;
  }

  const ordered = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <ol aria-label="Run timeline" className="run-timeline">
      {ordered.map((run) => {
        const output = outputsByRun[run.id] ?? [];
        const failed = run.failure_reason !== null && run.failure_reason !== undefined;
        return (
          <li key={run.id} className="run-entry" data-status={run.status} data-run-id={run.id} aria-label={`Run ${run.id}`}>
            <header className="run-header">
              <span className="run-label">Run</span>
              <RunStatusBadge status={run.status} />
            </header>
            <code className="run-id">{run.id}</code>
            <time className="t-subtle" dateTime={run.created_at} title={run.created_at}>{new Date(run.created_at).toLocaleString()}</time>
            {failed ? <p className="run-failure">{run.failure_reason}</p> : null}
            {renderUsage?.(run)}
            {output.length > 0 ? (
              <details className="run-output">
                <summary>{output.length} output lines</summary>
                <pre>{output.join("\n")}</pre>
              </details>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
