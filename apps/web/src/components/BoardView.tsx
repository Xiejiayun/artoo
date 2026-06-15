import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import type { TaskStatus } from "@artoo/domain";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { useSelection } from "../app/SelectionContext.js";

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

/**
 * Board: a read model over the project's tasks (`tasks(project)`), grouped into
 * status columns with a priority filter. Card click selects the task and returns
 * to the Workspace. Refreshes in realtime via the `project:` subscription.
 * Consumes only v0.1 task fields — no DAG/sprint/agent enrichment here.
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
    return <p role="status">Loading board…</p>;
  }
  if (bootstrap.isError || tasks.isError || tasks.data === undefined) {
    return <p role="alert">Failed to load board.</p>;
  }

  const visible = tasks.data.tasks.filter((task) => priority === "all" || task.priority === priority);

  function openTask(taskId: string): void {
    setSelectedTaskId(taskId);
    navigate("/");
  }

  return (
    <div className="board">
      <header className="board-header">
        <h1>Board</h1>
        <label>
          Priority
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as (typeof PRIORITIES)[number])}
          >
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value === "all" ? "All" : value}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="board-columns">
        {COLUMNS.map(({ status, label }) => {
          const items = visible.filter((task) => task.status === status);
          return (
            <section key={status} className="board-column" data-status={status} aria-label={label}>
              <h2>
                {label} <span className="count">{items.length}</span>
              </h2>
              <ul>
                {items.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      className="board-card"
                      data-status={task.status}
                      onClick={() => openTask(task.id)}
                    >
                      <span className="title">{task.title}</span>
                      <span className="priority">{task.priority}</span>
                      {task.assignee_id !== null && task.assignee_id !== undefined ? (
                        <span className="assignee">
                          {task.assignee_type}:{task.assignee_id}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
