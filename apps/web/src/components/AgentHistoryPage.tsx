import { RunActivityPayloadSchema, RunStatusSchema, type AgentHistoryEvent, type RunOperation } from "@artoo/domain";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { LoadingView } from "./LoadingView.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Badge, Button, EmptyState, ErrorState, RunStatusBadge, Select } from "../ui/index.js";
import "./agent-history.css";

function Operation({ operation }: { operation: RunOperation }): React.ReactNode {
  return <section className="history-operation" aria-label={`${operation.name} ${operation.phase}`}>
    <h4>{operation.name} <Badge tone={operation.phase === "failed" ? "danger" : "neutral"}>{operation.phase}</Badge></h4>
    <p>Call: <code>{operation.call_id}</code>{operation.exit_code != null ? ` · Exit code: ${operation.exit_code}` : ""}</p>
    {operation.request !== undefined && <><h5>Request{operation.request_truncated ? " (truncated)" : ""}</h5><pre>{operation.request}</pre></>}
    {operation.response !== undefined && <><h5>Response{operation.response_truncated ? " (truncated)" : ""}</h5><pre>{operation.response}</pre></>}
  </section>;
}
function HistoryEvent({ event }: { event: AgentHistoryEvent }): React.ReactNode {
  const parsed = RunActivityPayloadSchema.safeParse(event.payload.activity);
  const activity = parsed.success ? parsed.data : undefined;
  const title = event.response_text !== null ? "Final answer" : activity ? "Tool activity" : event.type === "run.output" ? "Output" : event.type;
  return <li data-position={event.position} className="history-event">
    <details><summary><strong>{title}</strong><time dateTime={event.occurred_at}>{new Date(event.occurred_at).toLocaleString()}</time><span>#{event.position}</span></summary>
      <div className="history-event-content">
        <p>{event.type} · {event.actor.type}: <code>{event.actor.id}</code>{event.sequence !== null ? ` · Sequence: ${event.sequence}` : ""}</p>
        {event.response_text !== null && <pre>{event.response_text}</pre>}
        {activity?.operations.map((operation, i) => <Operation key={`${operation.call_id}:${i}`} operation={operation} />)}
        {!!activity?.omitted_operations && <p role="status">{activity.omitted_operations} additional operations omitted from this batch.</p>}
        {event.type === "run.output" ? <details><summary>Recorded output</summary><pre>{String(event.payload.text ?? "")}</pre></details>
          : <details><summary>Event details</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>}
      </div>
    </details>
  </li>;
}

export function AgentHistoryPage(): React.ReactNode {
  const { agentId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const api = useApi();
  const instance = params.get("instance_id") ?? "", project = params.get("project_id") ?? "", status = params.get("status") ?? "";
  const runId = params.get("run_id") ?? "";
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const history = useInfiniteQuery({
    queryKey: queryKeys.agentHistory(agentId, { instance, project, status }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.agentHistory(agentId, { instance_id: instance || undefined, project_id: project || undefined,
      status: status ? RunStatusSchema.parse(status) : undefined, before_run_id: pageParam }),
    getNextPageParam: page => page.next_before_run_id ?? undefined,
  });
  const detail = useInfiniteQuery({
    queryKey: queryKeys.agentHistoryRun(agentId, runId), enabled: !!runId,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.agentHistoryRun(agentId, runId, { before: pageParam }),
    getNextPageParam: page => page.next_before ?? undefined,
  });
  const filters = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.delete("run_id"); setParams(next);
  };
  const instances = bootstrap.data?.agent_instances.filter(value => value.agent_id === agentId) ?? [];
  const executions = history.data?.pages.flatMap(page => page.runs) ?? [];
  const first = detail.data?.pages[0];
  return <section className="agent-history-page" aria-label="Agent history">
    <header className="history-header"><div><Link to="/agents">Back to Agents</Link><h1>{history.data?.pages[0]?.agent_name ?? "Agent"} history</h1><p>Requests, operations and results across this Agent's instances.</p></div>
      <Button onClick={() => { void history.refetch(); if (runId) void detail.refetch(); }} disabled={history.isFetching || detail.isFetching}>Refresh history</Button></header>
    <div className="history-filters">
      <Select label="History instance" value={instance} onChange={event => filters("instance_id", event.target.value)}><option value="">All instances</option>{instances.map(value => <option key={value.id} value={value.id}>{value.runtime} · {value.id}</option>)}{instance && !instances.some(value => value.id === instance) && <option value={instance}>{instance} (historical)</option>}</Select>
      <Select label="History project" value={project} onChange={event => filters("project_id", event.target.value)}><option value="">All projects</option>{bootstrap.data?.projects.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}{project && !bootstrap.data?.projects.some(value => value.id === project) && <option value={project}>{project}</option>}</Select>
      <Select label="History status" value={status} onChange={event => filters("status", event.target.value)}><option value="">All statuses</option>{RunStatusSchema.options.map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</Select>
    </div>
    <div className="history-layout">
      <section className="history-executions" aria-label="Agent executions"><h2>Executions</h2>
        {history.isLoading && <LoadingView label="Loading history…" shape="list" />}
        {history.isError && <ErrorState title="Could not load Agent history" action={<Button onClick={() => void history.refetch()}>Retry history</Button>} />}
        {!history.isLoading && !history.isError && !executions.length && <EmptyState title="No executions found" description="History appears when this Agent receives work. Check the filters if it has already run." />}
        <ol>{executions.map(({ run, task_title }) => <li key={run.id}><button className="history-execution" type="button" aria-pressed={runId === run.id} onClick={() => { const next = new URLSearchParams(params); next.set("run_id", run.id); setParams(next); }}><strong>{task_title}</strong><RunStatusBadge status={run.status} /><time dateTime={run.created_at}>{new Date(run.created_at).toLocaleString()}</time><code>{run.id}</code></button></li>)}</ol>
        {history.hasNextPage && <Button loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Load older executions</Button>}
      </section>
      <section className="history-detail" aria-label="Execution history">
        {!runId && <EmptyState title="Select an execution" description="Choose a run to inspect its original request and recorded activity." />}
        {runId && detail.isLoading && <LoadingView label="Loading execution…" />}
        {runId && detail.isError && <ErrorState title="Could not load execution history" action={<Button onClick={() => void detail.refetch()}>Retry execution</Button>} />}
        {first && <>
          <h2>{first.execution.task_title}</h2><RunStatusBadge status={first.execution.run.status} />
          <p>Run: <code>{runId}</code></p><p>Instance: <code>{first.execution.run.agent_instance_id}</code> · {first.execution.run.runtime_id}</p>
          {first.execution.run.failure_reason && <p className="history-failure" role="status">{first.execution.run.failure_reason}</p>}
          <details className="history-request" open><summary>Original request</summary>{first.request ? <><h3>{first.request.title}</h3><pre>{first.request.description}</pre><h4>Acceptance criteria</h4><ul>{first.request.acceptance_criteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul></> : <p>The original request is unavailable for this execution.</p>}</details>
          <h3>Recorded activity</h3><p className="history-help">Newest first. Tool details appear when reported by the runtime; older or plain-text runs may only have output.</p>
          <ol className="history-events" aria-label="Recorded events">{detail.data!.pages.flatMap(page => page.events).map(event => <HistoryEvent key={event.id} event={event} />)}</ol>
          {first.events.length === 0 && <p>No events recorded yet.</p>}
          {detail.hasNextPage && <Button loading={detail.isFetchingNextPage} onClick={() => void detail.fetchNextPage()}>Load older events</Button>}
        </>}
      </section>
    </div>
  </section>;
}
