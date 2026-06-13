import { useQuery } from "@tanstack/react-query";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";

export interface TaskListProps {
  projectId: string;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

/** Left-rail task list. Pure projection of the `listTasks` snapshot. */
export function TaskList({ projectId, selectedTaskId, onSelectTask }: TaskListProps): React.ReactNode {
  const api = useApi();
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.tasks(projectId),
    queryFn: () => api.listTasks(projectId),
  });

  if (isLoading) {
    return <p role="status">Loading tasks…</p>;
  }
  if (isError || data === undefined) {
    return <p role="alert">Failed to load tasks.</p>;
  }
  if (data.tasks.length === 0) {
    return <p>No tasks yet.</p>;
  }

  return (
    <ul aria-label="Tasks" className="task-list">
      {data.tasks.map((task) => (
        <li key={task.id}>
          <button
            type="button"
            aria-current={task.id === selectedTaskId}
            onClick={() => onSelectTask(task.id)}
          >
            <span className="task-title">{task.title}</span>
            <span className="task-status" data-status={task.status}>
              {task.status}
            </span>
            <span className="task-priority">{task.priority}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
