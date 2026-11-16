import type { ProjectControlTaskV1 } from "@artoo/domain";
import type { BootstrapResponse } from "../api/types.js";

const at = (value: string): string => new Date(value).toLocaleString();

/** Explicit evidence from a bounded observation, not inferred claim eligibility. */
export function ControlTaskFacts({ entry, bootstrap }: { entry: ProjectControlTaskV1; bootstrap?: BootstrapResponse }): React.ReactNode {
  const run = entry.latest_run;
  const lease = entry.execution_lease;
  const instance = bootstrap?.agent_instances.find((item) => item.id === run?.agent_instance_id);
  const agent = bootstrap?.agents.find((item) => item.id === instance?.agent_id);
  const computerId = lease?.computer_id ?? run?.computer_id;
  const computer = bootstrap?.computers.find((item) => item.id === computerId);
  const queue = entry.queue_metadata?.metadata;
  return <span className="cowork-control-facts">
    {run && <span>{agent?.display_name ?? instance?.runtime ?? run.runtime_id} · {computer?.display_name ?? computerId ?? "Machine unknown"}</span>}
    {run && <span>Latest run: {run.status.replaceAll("_", " ")}{run.failure_reason ? ` · ${run.failure_reason}` : ""}</span>}
    {lease && <span>Lease #{lease.epoch} · {lease.state} · expires {at(lease.expires_at)}{lease.closed_at ? ` · closed ${at(lease.closed_at)}` : " · closure unconfirmed"}</span>}
    {entry.execution_request?.state === "pending" && <span>Execution requested · eligibility details not reported</span>}
    {queue && queue.not_before_ms > 0 && <span>Not before {at(new Date(queue.not_before_ms).toISOString())}</span>}
    {queue?.preferred_computer_id && <span>Soft preference: {bootstrap?.computers.find((item) => item.id === queue.preferred_computer_id)?.display_name ?? queue.preferred_computer_id}{queue.prefer_until_ms ? ` until ${at(new Date(queue.prefer_until_ms).toISOString())}` : ""}</span>}
    {entry.last_assignment && <span>Last assignment: {entry.last_assignment.reason.replaceAll("_", " ")} ({entry.last_assignment.mode}, historical)</span>}
  </span>;
}
