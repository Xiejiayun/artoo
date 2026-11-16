import { RunActivityPayloadSchema, type Run, type TaskAuditBundle } from "@artoo/domain";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { usePollMs, useSubscription } from "../app/RealtimeContext.js";
import type { RunOutputChunk } from "../app/runOutputs.js";
import type { BootstrapResponse } from "../api/types.js";
import { Button, EmptyState, ErrorState, RunStatusBadge, Select } from "../ui/index.js";
import { TaskRoom } from "./TaskRoom.js";
import { CancelRun } from "./CancelRun.js";

/** Durable paged events reconcile with the bounded live output cache by event id. */
export function TaskExecutionConsole({
  bundle,
  bootstrap,
}: {
  bundle: TaskAuditBundle;
  bootstrap?: BootstrapResponse;
}): React.ReactNode {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<"output" | "conversation">("output");
  const requested = params.get("run");
  const runs = [...bundle.runs].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const run = requested ? runs.find((item) => item.id === requested) : runs[0];
  return (
    <section className="cowork-run-console" aria-label="Run console">
      <header>
        <h2>Runs</h2>
        <div className="action-row">
          <Button size="sm" aria-pressed={tab === "output"} onClick={() => setTab("output")}>
            Output & events
          </Button>
          <Button size="sm" aria-pressed={tab === "conversation"} onClick={() => setTab("conversation")}>
            Questions & handoffs
          </Button>
        </div>
      </header>
      {runs.length > 0 && (
        <Select
          label="Execution attempt"
          value={requested ?? run?.id ?? ""}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            next.set("run", event.target.value);
            setParams(next);
          }}
        >
          {requested && !run && <option value={requested}>Requested run unavailable</option>}
          {runs.map((item) => (
            <option key={item.id} value={item.id}>
              {item.runtime_id} · {item.status} · {item.id}
            </option>
          ))}
        </Select>
      )}
      {requested && !run && (
        <ErrorState
          title="Run unavailable for this task"
          description="Choose a recorded execution attempt for this task."
        />
      )}
      {tab === "conversation" ? (
        <TaskRoom taskId={bundle.task.id} />
      ) : run ? (
        <RunConsole key={run.id} run={run} bundle={bundle} bootstrap={bootstrap} />
      ) : (
        !requested && (
          <EmptyState
            title="No execution attempts yet"
            description="Recorded runs and their output will appear here."
          />
        )
      )}
      <CancelRun runs={bundle.runs} taskId={bundle.task.id} projectId={bundle.task.project_id} />
    </section>
  );
}

function RunConsole({
  run,
  bundle,
  bootstrap,
}: {
  run: Run;
  bundle: TaskAuditBundle;
  bootstrap?: BootstrapResponse;
}): React.ReactNode {
  const api = useApi();
  const instance = bootstrap?.agent_instances.find((item) => item.id === run.agent_instance_id);
  const agentId = instance?.agent_id;
  const agent = bootstrap?.agents.find((item) => item.id === agentId);
  const machine = bootstrap?.computers.find((item) => item.id === run.computer_id);
  useSubscription([`task:${bundle.task.id}`, `run:${run.id}`]);
  const history = useInfiniteQuery({
    queryKey: queryKeys.agentHistoryRun(agentId ?? "unavailable", run.id),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.agentHistoryRun(agentId!, run.id, { before: pageParam }),
    getNextPageParam: (page) => page.next_before ?? undefined,
    enabled: !!agentId,
    refetchInterval: usePollMs(5000),
  });
  const live = useQuery<RunOutputChunk[]>({
    queryKey: queryKeys.runOutputs(bundle.task.id),
    queryFn: async () => [],
    enabled: false,
  });
  const durable =
    history.data?.pages.flatMap((page) => page.events) ?? bundle.events.filter((event) => event.run_id === run.id);
  const byId = new Map(durable.map((event) => [event.id, event]));
  const ordered = [...byId.values()].sort((a, b) => a.position - b.position);
  const liveOnly = live.data?.filter((chunk) => chunk.runId === run.id && !byId.has(chunk.eventId)) ?? [];
  const output = ordered
    .filter((event) => event.type === "run.output" && typeof event.payload.text === "string")
    .map((event) => String(event.payload.text));
  output.push(...liveOnly.map((chunk) => chunk.text));
  return (
    <div className="cowork-console-body">
      <div className="cowork-console-identity">
        <strong>{agent?.display_name ?? run.runtime_id}</strong>
        <span>{machine?.display_name ?? run.computer_id}</span>
        <RunStatusBadge status={run.status} />
      </div>
      <p className="cowork-snapshot-note">
        Run {run.id} · recorded public output and events. Live output is bounded; older evidence uses the history
        cursor.
      </p>
      {run.failure_reason && <p className="insights-warning">{run.failure_reason}</p>}
      {history.isError && (
        <ErrorState
          title="Execution history could not be refreshed"
          description={history.error.message}
          action={<Button onClick={() => void history.refetch()}>Retry run history</Button>}
        />
      )}
      {!agentId && <p role="status">The historical Agent identity is unavailable. Showing recorded task evidence.</p>}
      <pre className="cowork-terminal" aria-label="Recorded run output">
        {output.length > 0 ? output.join("\n") : "No public output has been recorded for this run."}
      </pre>
      <details className="cowork-recorded-events">
        <summary>Recorded events · {ordered.length}</summary>
        <ol>
          {ordered.map((event) => {
            const activity = RunActivityPayloadSchema.safeParse(event.payload.activity);
            return (
              <li key={event.id}>
                <strong>{event.type}</strong>
                <small>
                  #{event.position} · {new Date(event.occurred_at).toLocaleString()}
                </small>
                {"response_text" in event && typeof event.response_text === "string" && (
                  <pre>{event.response_text}</pre>
                )}
                {activity.success &&
                  activity.data.operations.map((operation) => (
                    <details key={operation.call_id}>
                      <summary>
                        {operation.name} · {operation.phase}
                      </summary>
                      {operation.request !== undefined && <pre>{operation.request}</pre>}
                      {operation.response !== undefined && <pre>{operation.response}</pre>}
                    </details>
                  ))}
              </li>
            );
          })}
        </ol>
      </details>
      {history.hasNextPage && (
        <Button size="sm" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          Load older run events
        </Button>
      )}
    </div>
  );
}
