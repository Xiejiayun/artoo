import type { Task } from "@artoo/domain";
import { useQuery } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useState } from "react";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button, EmptyState, ErrorState, PriorityBadge, Skeleton, StatusBadge } from "../ui/index.js";
import { ListTodo, Search } from "../ui/Icon.js";
import { taskUpdatedLabel } from "./taskPresentation.js";
import "../ui/work-management.css";

export interface TaskListProps {
  projectId: string;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  /** Optional title filter from the rail search box. */
  filter?: string;
  /** Explicit task IDs, e.g. tasks referenced by pending approval records. */
  taskIds?: ReadonlySet<string> | undefined;
}

function TaskRowsSkeleton(): React.ReactNode {
  return (
    <>
      <span className="task-list-loading-label" role="status" aria-label="Loading tasks">
        Loading tasks...
      </span>
      <div className="task-list work-task-list" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="task-row work-task-row task-row--skeleton">
            <Skeleton height={14} width="75%" />
            <Skeleton height={16} width="48%" radius="var(--radius-pill)" />
          </div>
        ))}
      </div>
    </>
  );
}

const TaskRow = memo(function TaskRow({
  task,
  selected,
  onSelectTask,
}: {
  task: Task;
  selected: boolean;
  onSelectTask: (taskId: string) => void;
}): React.ReactNode {
  return (
    <li>
      <button
        type="button"
        className={`task-row work-task-row${selected ? " is-selected" : ""}`}
        aria-current={selected}
        onClick={() => onSelectTask(task.id)}
      >
        <span className="task-row__title" title={task.title}>{task.title}</span>
        <span className="task-row__meta">
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
          <time className="work-task-row__date" dateTime={task.updated_at} title={`Updated ${new Date(task.updated_at).toLocaleString()}`}>{taskUpdatedLabel(task.updated_at)}</time>
        </span>
      </button>
    </li>
  );
});

export const TASK_PAGE_SIZE = 50;

/** Left-rail task list (#71). Projection of `listTasks`; rows show semantic
 *  status/priority badges, support selection + keyboard focus, and filter by a
 *  title query with a distinct empty-match state. */
export function TaskList({ projectId, selectedTaskId, onSelectTask, filter = "", taskIds }: TaskListProps): React.ReactNode {
  const api = useApi();
  const [visibleLimit, setVisibleLimit] = useState(TASK_PAGE_SIZE);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.tasks(projectId),
    queryFn: () => api.listTasks(projectId),
  });
  const q = filter.trim().toLowerCase();
  useEffect(() => {
    setVisibleLimit(TASK_PAGE_SIZE);
  }, [projectId, q, taskIds]);
  const tasks = useMemo(() => {
    if (!data) return [];
    return data.tasks.filter((task) => (!taskIds || taskIds.has(task.id)) && (q === "" || task.title.toLowerCase().includes(q)));
  }, [data, q, taskIds]);
  const visibleTasks = useMemo(() => {
    if (tasks.length <= visibleLimit) return tasks;
    const selectedIndex = selectedTaskId ? tasks.findIndex((t) => t.id === selectedTaskId) : -1;
    const effectiveLimit = selectedIndex >= visibleLimit ? selectedIndex + 1 : visibleLimit;
    return tasks.slice(0, effectiveLimit);
  }, [tasks, visibleLimit, selectedTaskId]);

  if (isLoading) {
    return <TaskRowsSkeleton />;
  }
  if (isError || data === undefined) {
    return (
      <ErrorState
        title="Failed to load tasks"
        action={
          <Button size="sm" onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  if (data.tasks.length === 0) {
    return <EmptyState icon={ListTodo} title="No tasks yet" description="Create a task to start tracking work." />;
  }
  if (tasks.length === 0) {
    return <EmptyState icon={Search} title="No matching tasks" description={q ? `No tasks match "${filter.trim()}".` : "No tasks have pending approvals."} />;
  }

  const remaining = tasks.length - visibleTasks.length;

  return (
    <>
      <ul aria-label="Tasks" className="task-list work-task-list">
        {visibleTasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            selected={task.id === selectedTaskId}
            onSelectTask={onSelectTask}
          />
        ))}
      </ul>
      {remaining > 0 ? (
        <Button size="sm" variant="ghost" onClick={() => setVisibleLimit((limit) => limit + TASK_PAGE_SIZE)}>
          Show more tasks ({remaining} remaining)
        </Button>
      ) : null}
    </>
  );
}
