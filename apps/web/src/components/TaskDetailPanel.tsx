import { useQuery } from "@tanstack/react-query";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { RunTimeline } from "./RunTimeline.js";

/**
 * Right pane: task detail + run timeline. Shares the `task:` query cache with
 * TaskRoom (same key), so selecting a task triggers one snapshot fetch.
 * Approval/artifact panels are added in a later Phase 1 step.
 */
export function TaskDetailPanel({ taskId }: { taskId: string }): React.ReactNode {
  const api = useApi();
  const snapshot = useQuery({
    queryKey: queryKeys.task(taskId),
    queryFn: () => api.getTask(taskId),
  });

  if (snapshot.isLoading) {
    return <p role="status">Loading detail…</p>;
  }
  if (snapshot.isError || snapshot.data === undefined) {
    return <p role="alert">Failed to load detail.</p>;
  }

  const { task, runs } = snapshot.data;

  return (
    <div className="task-detail">
      <h2>{task.title}</h2>
      <dl className="task-fields">
        <dt>Status</dt>
        <dd data-status={task.status}>{task.status}</dd>
        <dt>Priority</dt>
        <dd>{task.priority}</dd>
        {task.assignee_id !== null && task.assignee_id !== undefined ? (
          <>
            <dt>Assignee</dt>
            <dd>
              {task.assignee_type}:{task.assignee_id}
            </dd>
          </>
        ) : null}
      </dl>
      {task.acceptance_criteria.length > 0 ? (
        <section aria-label="Acceptance criteria">
          <h3>Acceptance criteria</h3>
          <ul>
            {task.acceptance_criteria.map((criterion, index) => (
              <li key={`${index}-${criterion}`}>{criterion}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="Runs">
        <h3>Runs</h3>
        <RunTimeline runs={runs} />
      </section>
    </div>
  );
}
