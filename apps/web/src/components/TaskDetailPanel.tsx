import { useQuery } from "@tanstack/react-query";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button, ErrorState, PriorityBadge, Skeleton, StatusBadge } from "../ui/index.js";
import { ApprovalInbox } from "./ApprovalInbox.js";
import { ArtifactReview } from "./ArtifactReview.js";
import { RunTimeline } from "./RunTimeline.js";
import { TaskActions } from "./TaskActions.js";

function DetailSkeleton(): React.ReactNode {
  return (
    <>
      <span className="detail-loading-label" role="status" aria-label="Loading detail">
        Loading detail...
      </span>
      <div className="task-detail" aria-hidden="true">
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
  const snapshot = useQuery({
    queryKey: queryKeys.task(taskId),
    queryFn: () => api.getTask(taskId),
  });

  if (snapshot.isLoading) {
    return <DetailSkeleton />;
  }
  if (snapshot.isError || snapshot.data === undefined) {
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
  const hasAssignee = task.assignee_id !== null && task.assignee_id !== undefined;

  return (
    <div className="task-detail">
      <header className="task-detail__header">
        <h2 className="t-h2">{task.title}</h2>
        <StatusBadge status={task.status} />
      </header>

      <dl className="task-detail__meta">
        <div className="task-detail__meta-row">
          <dt>Priority</dt>
          <dd>
            <PriorityBadge priority={task.priority} />
          </dd>
        </div>
        {hasAssignee ? (
          <div className="task-detail__meta-row">
            <dt>Assignee</dt>
            <dd className="t-mono">
              {task.assignee_type}:{task.assignee_id}
            </dd>
          </div>
        ) : null}
      </dl>

      <TaskActions task={task} />

      {task.acceptance_criteria.length > 0 ? (
        <section className="task-detail__section" aria-label="Acceptance criteria">
          <h3 className="task-detail__section-title">Acceptance criteria</h3>
          <ul className="task-detail__criteria">
            {task.acceptance_criteria.map((criterion, index) => (
              <li key={`${index}-${criterion}`}>{criterion}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <ApprovalInbox taskId={task.id} approvals={approvals} />
      <section className="task-detail__section" aria-label="Runs">
        <h3 className="task-detail__section-title">Runs</h3>
        <RunTimeline runs={runs} />
      </section>
      <ArtifactReview task={task} artifacts={artifacts} />
    </div>
  );
}
