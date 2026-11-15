import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useApi } from "../app/ApiContext.js";
import { Button } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

function duration(value: number | null): string {
  return value === null ? "No samples" : `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
}

function BaselineData({ projectId }: { projectId: string }): React.ReactNode {
  const api = useApi();
  const query = useQuery({
    queryKey: ["scheduler-observations", projectId],
    queryFn: () => api.getSchedulerObservations(projectId),
  });
  const data = query.data;
  return (
    <div className="settings-section__body u-stack">
      <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
        Refresh baseline
      </Button>
      {query.isPending && <p role="status">Loading scheduler baseline…</p>}
      <ActionError error={query.error} />
      {data && (
        <>
          <p>
            Completed measurements from {new Date(data.window.from).toLocaleString()} to{" "}
            {new Date(data.window.to).toLocaleString()}.
          </p>
          <dl>
            <dt>Mean queue time</dt>
            <dd>
              {duration(data.queue.mean_ms)} · {data.queue.samples} measured / {data.queue.assignments} assignments
            </dd>
            <dt>Mean execution time</dt>
            <dd>
              {duration(data.execution.mean_ms)} · {data.execution.samples} samples
            </dd>
            <dt>Failure rate</dt>
            <dd>
              {data.failure.rate === null ? "No samples" : `${(data.failure.rate * 100).toFixed(1)}%`} ·{" "}
              {data.failure.failed_runs} failed / {data.failure.terminal_runs} terminal runs
            </dd>
            <dt>Hanging tasks now</dt>
            <dd>
              {data.current.hanging_tasks} · active attempts older than {duration(data.hanging_after_ms)}
            </dd>
            <dt>Disconnected processes awaiting closure</dt>
            <dd>{data.current.unconfirmed_disconnect_runs}</dd>
          </dl>
          <p>
            Observed at {new Date(data.observed_at).toLocaleString()}. Missing measurements remain unknown. Paused and
            awaiting-input attempts are included in hanging tasks.
          </p>
        </>
      )}
    </div>
  );
}

/** Fetch only when the user opens this project-specific observation panel. */
export function SchedulerBaseline({ projectId }: { projectId: string }): React.ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <details className="settings-section" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Scheduler baseline · last seven days</summary>
      {open && <BaselineData key={projectId} projectId={projectId} />}
    </details>
  );
}
