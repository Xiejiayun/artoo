import type { Run } from "@artoo/domain";
import { memo, useMemo, useState } from "react";

import { Button, RunStatusBadge } from "../ui/index.js";
import { WorkspaceRetention, type RetentionComputer } from "./WorkspaceRetention.js";

export const RUN_TIMELINE_PAGE_SIZE = 20;

export interface RunTimelineProps {
  runs: Run[];
  /** run_id -> stdout/stderr lines, derived from run.output events. */
  outputsByRun?: Record<string, string[]>;
  renderUsage?: (run: Run) => React.ReactNode;
  computers?: readonly RetentionComputer[];
}

const EMPTY_OUTPUT: string[] = [];

const RunEntry = memo(function RunEntry({
  run,
  output,
  renderUsage,
  computers,
}: {
  run: Run;
  output: readonly string[];
  renderUsage?: (run: Run) => React.ReactNode;
  computers?: readonly RetentionComputer[];
}): React.ReactNode {
  const failed = run.failure_reason !== null && run.failure_reason !== undefined;
  return (
    <li className="run-entry" data-status={run.status} data-run-id={run.id} aria-label={`Run ${run.id}`}>
      <header className="run-header">
        <span className="run-label">Run</span>
        <RunStatusBadge status={run.status} />
      </header>
      <code className="run-id">{run.id}</code>
      <time className="t-subtle" dateTime={run.created_at} title={run.created_at}>{new Date(run.created_at).toLocaleString()}</time>
      {failed ? <p className="run-failure">{run.failure_reason}</p> : null}
      <WorkspaceRetention run={run} computers={computers} />
      {renderUsage?.(run)}
      {output.length > 0 ? (
        <details className="run-output">
          <summary>{output.length} output lines</summary>
          <pre>{output.join("\n")}</pre>
        </details>
      ) : null}
    </li>
  );
}, (prev, next) =>
  prev.run === next.run &&
  prev.renderUsage === next.renderUsage &&
  prev.computers === next.computers &&
  prev.output.length === next.output.length &&
  prev.output.every((line, index) => line === next.output[index]),
);

/**
 * Right-pane run timeline (#74). A task has 1..N runs (retry creates a new run);
 * newest first. Each run is a step card with a semantic status badge; failure
 * reasons surface inline and output is collapsed by default so high-frequency
 * stdout never floods the panel.
 */
export function RunTimeline({ runs, outputsByRun = {}, renderUsage, computers }: RunTimelineProps): React.ReactNode {
  const [visibleLimit, setVisibleLimit] = useState(RUN_TIMELINE_PAGE_SIZE);
  const ordered = useMemo(() => [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at)), [runs]);

  if (runs.length === 0) {
    return <p className="no-runs">No runs yet.</p>;
  }

  const visible = ordered.slice(0, visibleLimit);
  const remaining = ordered.length - visible.length;

  return (
    <>
      <ol aria-label="Run timeline" className="run-timeline">
        {visible.map((run) => (
          <RunEntry
            key={run.id}
            run={run}
            output={outputsByRun[run.id] ?? EMPTY_OUTPUT}
            renderUsage={renderUsage}
            computers={computers}
          />
        ))}
      </ol>
      {remaining > 0 ? (
        <Button size="sm" variant="ghost" onClick={() => setVisibleLimit((limit) => limit + RUN_TIMELINE_PAGE_SIZE)}>
          Show older runs ({remaining} more)
        </Button>
      ) : null}
    </>
  );
}
