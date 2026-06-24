import type { Run } from "@artoo/domain";

import { RunStatusBadge } from "../ui/index.js";

export interface RunTimelineProps {
  runs: Run[];
  /** run_id -> stdout/stderr lines, derived from run.output events. */
  outputsByRun?: Record<string, string[]>;
}

/**
 * Right-pane run timeline (#74). A task has 1..N runs (retry creates a new run);
 * newest first. Each run is a step card with a semantic status badge; failure
 * reasons surface inline and output is collapsed by default so high-frequency
 * stdout never floods the panel.
 */
export function RunTimeline({ runs, outputsByRun = {} }: RunTimelineProps): React.ReactNode {
  if (runs.length === 0) {
    return <p className="no-runs">No runs yet.</p>;
  }

  const ordered = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <ol aria-label="Run timeline" className="run-timeline">
      {ordered.map((run, index) => {
        const output = outputsByRun[run.id] ?? [];
        const failed = run.failure_reason !== null && run.failure_reason !== undefined;
        return (
          <li key={run.id} className="run-entry" data-status={run.status}>
            <header className="run-header">
              <span className="run-label">Run {ordered.length - index}</span>
              <RunStatusBadge status={run.status} />
            </header>
            {failed ? <p className="run-failure">{run.failure_reason}</p> : null}
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
