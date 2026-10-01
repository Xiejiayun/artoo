import { useQuery } from "@tanstack/react-query";
import { Circle, ListChecks } from "lucide-react";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import type { RunOutputChunk } from "../app/runOutputs.js";
import { Button, ErrorState, PriorityBadge, Skeleton, StatusBadge } from "../ui/index.js";
import { ApprovalInbox } from "./ApprovalInbox.js";
import { ArtifactReview } from "./ArtifactReview.js";
import { RunTimeline } from "./RunTimeline.js";
import { RunUsageSummary } from "./RunUsageSummary.js";
import { TaskActions } from "./TaskActions.js";
import { CancelRun } from "./CancelRun.js";
import { TaskDependencies } from "./TaskDependencies.js";
import { ActionError } from "./ActionError.js";
import { CAPABILITY_LABELS, taskAssigneeName, taskUpdatedLabel } from "./taskPresentation.js";
import "../ui/work-management.css";

function DetailSkeleton(): React.ReactNode {
  return (
    <>
      <span className="detail-loading-label" role="status" aria-label="Loading detail">
        Loading detail...
      </span>
      <div className="task-detail work-task-detail" aria-hidden="true">
        <Skeleton height={22} width="72%" />
        <div className="task-detail__meta">
          <Skeleton height={14} width="40%" />
          <Skeleton height={14} width="55%" />
        </div>
        <Skeleton height={64} />
      </div>
    </>
  );
}

/**
 * Right pane task detail (#72): title + status, lifecycle actions, metadata,
 * and acceptance/review information. Shares the `task:` query cache with
 * TaskRoom (same key), so selecting a task triggers one snapshot fetch. The
 * room/activity (#73) and approvals/run timeline (#74) sub-surfaces are
 * rendered here but owned by their own slices.
 */
export function TaskDetailPanel({ taskId }: { taskId: string }): React.ReactNode {
  const api = useApi();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const snapshot = useQuery({
    queryKey: queryKeys.task(taskId),
    queryFn: () => api.getTask(taskId),
  });
  const outputs = useQuery<RunOutputChunk[]>({ queryKey: queryKeys.runOutputs(taskId), queryFn: async () => [], enabled: false });
  const outputsByRun: Record<string, string[]> = {};
  for (const chunk of outputs.data ?? []) (outputsByRun[chunk.runId] ??= []).push(chunk.text);

  if (snapshot.isLoading) {
    return <DetailSkeleton />;
  }
  if (snapshot.data === undefined) {
    return (
      <ErrorState
        title="Failed to load detail"
        action={
          <Button size="sm" onClick={() => void snapshot.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const { task, runs, approvals, artifacts } = snapshot.data;
  const assignee = taskAssigneeName(task, bootstrap.data);
  const latestRun = runs.reduce<(typeof runs)[number] | undefined>((latest, run) => latest === undefined || run.sequence > latest.sequence ? run : latest, undefined);
  const computer = bootstrap.data?.computers.find((item) => item.id === latestRun?.computer_id);

  return (
    <div className="task-detail work-task-detail">
      <header className="task-detail__header">
        <span className="work-eyebrow">Task details</span>
        <h2 className="t-h2">{task.title}</h2>
      </header>
      {snapshot.isError && <div className="u-stack-sm"><ActionError error={snapshot.error} /><Button size="sm" onClick={() => void snapshot.refetch()}>Retry loading task details</Button></div>}

      <dl className="task-detail__meta">
        <div className="task-detail__meta-row"><dt>Status</dt><dd><StatusBadge status={task.status} /></dd></div>
        <div className="task-detail__meta-row">
          <dt>Priority</dt>
          <dd>
            <PriorityBadge priority={task.priority} />
          </dd>
        </div>
        <div className="task-detail__meta-row"><dt>Assignee</dt><dd className="work-task-detail__assignee" title={task.assignee_id ?? undefined}><span className="work-avatar" aria-hidden="true">{task.assignee_id ? assignee.slice(0, 1).toUpperCase() : "–"}</span>{assignee}</dd></div>
        {computer ? <div className="task-detail__meta-row"><dt>Computer</dt><dd>{computer.display_name}</dd></div> : null}
        <div className="task-detail__meta-row"><dt>Updated</dt><dd><time dateTime={task.updated_at} title={new Date(task.updated_at).toLocaleString()}>{taskUpdatedLabel(task.updated_at)}</time></dd></div>
      </dl>

      <TaskActions key={`actions:${task.id}`} task={task} approvals={approvals} />
      <CancelRun key={`cancel:${task.id}`} runs={runs} taskId={task.id} projectId={task.project_id} />

      {task.description ? <section className="task-detail__section" aria-label="Description"><h3 className="task-detail__section-title">Description</h3><p className="work-task-detail__description">{task.description}</p></section> : null}
      {task.acceptance_criteria.length > 0 ? (
        <section className="task-detail__section" aria-label="Acceptance criteria">
          <h3 className="task-detail__section-title"><ListChecks size={15} aria-hidden="true" />Acceptance criteria <span className="work-count">{task.acceptance_criteria.length}</span></h3>
          <ul className="task-detail__criteria">
            {task.acceptance_criteria.map((criterion, index) => (
              <li key={`${index}-${criterion}`}><Circle size={14} aria-hidden="true" /><span>{criterion}</span></li>
            ))}
          </ul>
        </section>
      ) : null}
      {task.required_capabilities.length > 0 ? <section className="task-detail__section" aria-label="Required capabilities"><h3 className="task-detail__section-title">Required capabilities</h3><div className="work-task-detail__capabilities">{task.required_capabilities.map((capability) => <span key={capability} title={capability}>{CAPABILITY_LABELS[capability]}</span>)}</div></section> : null}

      <ApprovalInbox taskId={task.id} taskStatus={task.status} approvals={approvals} />
      <section className="task-detail__section" aria-label="Runs">
        <h3 className="task-detail__section-title">Runs <span className="work-count">{runs.length}</span></h3>
        <RunTimeline runs={runs} outputsByRun={outputsByRun} renderUsage={(run) => <RunUsageSummary run={run} />} />
      </section>
      <ArtifactReview key={`review:${task.id}`} task={task} artifacts={artifacts} reviews={snapshot.data.reviews} versionCursor={snapshot.data.version_cursor} />
      <TaskDependencies key={task.id} task={task} />
    </div>
  );
}
