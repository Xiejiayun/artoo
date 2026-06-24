import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import type { TaskStatus } from "@artoo/domain";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { useSelection } from "../app/SelectionContext.js";
import { EmptyState, ErrorState, PriorityBadge, Select, Skeleton } from "../ui/index.js";

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "ready", label: "Ready" },
  { status: "assigned", label: "Assigned" },
  { status: "running", label: "Running" },
  { status: "awaiting_approval", label: "Awaiting Approval" },
  { status: "blocked", label: "Blocked" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

const PRIORITIES = ["all", "p0", "p1", "p2", "p3"] as const;

function BoardSkeleton(): React.ReactNode {
  return (
    <div className="board">
      <p className="board-loading-label" role="status" aria-label="Loading board">
        Loading board...
      </p>
      <div className="board-header">
        <Skeleton height={24} width={120} />
      </div>
      <div className="board-columns" aria-hidden="true">
        {COLUMNS.slice(0, 5).map(({ status }) => (
          <section key={status} className="board-column">
            <Skeleton height={14} width="50%" />
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} height={56} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * Board (#75): a read model over the project's tasks (`tasks(project)`),
 * grouped into status columns with a priority filter. Card click selects the
 * task and returns to the Workspace. Refreshes in realtime via the `project:`
 * subscription. Consumes only v0.1 task fields — no DAG/sprint/agent
 * enrichment here. Loading/empty/error states use the ui primitives.
 */
export function BoardView(): React.ReactNode {
  const api = useApi();
  const navigate = useNavigate();
  const { setSelectedTaskId } = useSelection();
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("all");

  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const projectId = bootstrap.data?.projects[0]?.id;
  useSubscription(projectId === undefined ? [] : [`project:${projectId}`]);

  const tasks = useQuery({
    queryKey: projectId === undefined ? ["tasks", "pending"] : queryKeys.tasks(projectId),
    queryFn: () => api.listTasks(projectId as string),
    enabled: projectId !== undefined,
  });

  if (bootstrap.isLoading || tasks.isLoading) {
    return <BoardSkeleton />;
  }
  if (bootstrap.isError || tasks.isError || tasks.data === undefined) {
    return (
      <div className="board">
        <ErrorState title="Failed to load board" description="The board could not be reached. Try again." />
      </div>
    );
  }

  const all = tasks.data.tasks;
  const visible = all.filter((task) => priority === "all" || task.priority === priority);

  function openTask(taskId: string): void {
    setSelectedTaskId(taskId);
    navigate("/");
  }

  return (
    <div className="board">
      <header className="board-header">
        <h1 className="t-h1">Board</h1>
        <Select
          label="Priority"
          className="board-filter"
          value={priority}
          onChange={(event) => setPriority(event.target.value as (typeof PRIORITIES)[number])}
        >
          {PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {value === "all" ? "All priorities" : value.toUpperCase()}
            </option>
          ))}
        </Select>
      </header>
      {all.length === 0 ? (
        <div className="board-empty">
          <EmptyState title="No tasks yet" description="Create a task to populate the board." />
        </div>
      ) : (
        <div className="board-columns">
          {COLUMNS.map(({ status, label }) => {
            const items = visible.filter((task) => task.status === status);
            return (
              <section key={status} className="board-column" data-status={status} aria-label={label}>
                <h2 className="board-column__title">
                  {label} <span className="count">{items.length}</span>
                </h2>
                {items.length === 0 ? (
                  <p className="board-column__empty">No tasks</p>
                ) : (
                  <ul className="board-column__list">
                    {items.map((task) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          className="board-card"
                          data-status={task.status}
                          onClick={() => openTask(task.id)}
                        >
                          <span className="board-card__title">{task.title}</span>
                          <span className="board-card__meta">
                            <PriorityBadge priority={task.priority} />
                            {task.assignee_id !== null && task.assignee_id !== undefined ? (
                              <span className="board-card__assignee u-truncate">
                                {task.assignee_type}:{task.assignee_id}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
