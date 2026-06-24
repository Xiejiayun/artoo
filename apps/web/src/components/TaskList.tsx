import { useQuery } from "@tanstack/react-query";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button, EmptyState, ErrorState, PriorityBadge, Skeleton, StatusBadge } from "../ui/index.js";
import { ListTodo, Search } from "../ui/Icon.js";

export interface TaskListProps {
  projectId: string;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  /** Optional title filter from the rail search box. */
  filter?: string;
}

function TaskRowsSkeleton(): React.ReactNode {
  return (
    <div className="task-list" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="task-row task-row--skeleton">
          <Skeleton height={14} width="75%" />
          <Skeleton height={16} width="48%" radius="var(--radius-pill)" />
        </div>
      ))}
    </div>
  );
}

/** Left-rail task list (#71). Projection of `listTasks`; rows show semantic
 *  status/priority badges, support selection + keyboard focus, and filter by a
 *  title query with a distinct empty-match state. */
export function TaskList({ projectId, selectedTaskId, onSelectTask, filter = "" }: TaskListProps): React.ReactNode {
  const api = useApi();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.tasks(projectId),
    queryFn: () => api.listTasks(projectId),
  });

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

  const q = filter.trim().toLowerCase();
  const tasks = q === "" ? data.tasks : data.tasks.filter((t) => t.title.toLowerCase().includes(q));
  if (tasks.length === 0) {
    return <EmptyState icon={Search} title="No matching tasks" description={`No tasks match “${filter.trim()}”.`} />;
  }

  return (
    <ul aria-label="Tasks" className="task-list">
      {tasks.map((task) => {
        const selected = task.id === selectedTaskId;
        return (
          <li key={task.id}>
            <button
              type="button"
              className={`task-row${selected ? " is-selected" : ""}`}
              aria-current={selected}
              onClick={() => onSelectTask(task.id)}
            >
              <span className="task-row__title u-truncate">{task.title}</span>
              <span className="task-row__meta">
                <StatusBadge status={task.status} />
                <PriorityBadge priority={task.priority} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
