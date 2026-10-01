import { useProject } from "../app/useProject.js";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import type { TaskStatus } from "@artoo/domain";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { useSelection } from "../app/SelectionContext.js";
import { Button, EmptyState, ErrorState, PriorityBadge, SearchInput, Select, Skeleton, StatusBadge } from "../ui/index.js";
import { ListChecks, Plus, UserRound } from "lucide-react";
import { CreateTaskModal } from "./CreateTaskModal.js";
import { PRIORITY_LABELS, taskAssigneeName } from "./taskPresentation.js";
import "../ui/work-management.css";

// GitHub Projects / Linear stage grouping; each card preserves its exact status.
const COLUMNS: { key: string; statuses: TaskStatus[]; label: string; empty: string }[] = [
  { key: "backlog", statuses: ["backlog", "ready"], label: "Backlog", empty: "New and ready tasks appear here" },
  { key: "running", statuses: ["assigned", "running"], label: "In progress", empty: "Assigned work appears here" },
  { key: "blocked", statuses: ["awaiting_approval", "blocked"], label: "Needs attention", empty: "No work waiting on you" },
  { key: "review", statuses: ["review"], label: "Review", empty: "Results ready for review appear here" },
  { key: "done", statuses: ["done", "cancelled"], label: "Closed", empty: "Completed and cancelled tasks appear here" },
];

const PRIORITIES = ["all", "p0", "p1", "p2", "p3"] as const;

function BoardSkeleton(): React.ReactNode {
  return (
    <div className="board work-board">
      <p className="board-loading-label" role="status" aria-label="Loading board">
        Loading board...
      </p>
      <div className="board-header">
        <Skeleton height={24} width={120} />
      </div>
      <div className="board-columns" aria-hidden="true">
        {COLUMNS.map(({ key }) => (
          <section key={key} className="board-column">
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
 * grouped into work stages with title and priority filters. Card click selects the
 * task and returns to the Workspace. Refreshes in realtime via the `project:`
 * subscription. Implements ui-system-spec §2, §4–7 and production-ui-gate
 * §3, §5, §8–9 with the existing task and bootstrap contracts.
 */
export function BoardView(): React.ReactNode {
  const api = useApi();
  const navigate = useNavigate();
  const { setSelectedTaskId } = useSelection();
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("all");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

  const { bootstrap, projectId } = useProject();
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
      <div className="board work-board">
        <ErrorState title="Failed to load board" description="The board could not be reached. Try again." action={<Button onClick={() => { void bootstrap.refetch(); void tasks.refetch(); }}>Retry</Button>} />
      </div>
    );
  }

  const all = tasks.data.tasks;
  const query = search.trim().toLowerCase();
  const visible = all.filter((task) => (priority === "all" || task.priority === priority) && (!query || task.title.toLowerCase().includes(query)));
  const filtering = priority !== "all" || query !== "";
  const needsAttention = all.filter((task) => ["awaiting_approval", "blocked", "review"].includes(task.status)).length;

  function openTask(taskId: string): void {
    setSelectedTaskId(taskId);
    navigate("/");
  }

  return (
    <div className="board work-board">
      <header className="board-header">
        <div className="work-board__heading"><span className="work-eyebrow">{bootstrap.data?.projects.find((project) => project.id === projectId)?.name ?? "Workspace"}</span><h1 className="t-h1">Board <span className="work-count">{all.length}</span></h1><p>Keep work moving, from the first brief to the final review.</p></div>
        <Button variant="primary" iconLeft={Plus} disabled={!projectId} onClick={() => setCreating(true)}>Create task</Button>
      </header>
      <div className="work-board__toolbar">
        <SearchInput aria-label="Search board" placeholder="Search tasks…" value={search} onChange={(event) => setSearch(event.target.value)} onClear={() => setSearch("")} />
        <Select
          label="Priority"
          className="board-filter"
          value={priority}
          onChange={(event) => setPriority(event.target.value as (typeof PRIORITIES)[number])}
        >
          {PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {value === "all" ? "All priorities" : `${value.toUpperCase()} · ${PRIORITY_LABELS[value]}`}
            </option>
          ))}
        </Select>
        {filtering ? <Button size="sm" variant="ghost" onClick={() => { setSearch(""); setPriority("all"); }}>Clear filters</Button> : null}
        <span className="work-board__summary">{filtering ? `${visible.length} of ${all.length} tasks` : needsAttention > 0 ? `${needsAttention} ${needsAttention === 1 ? "task needs" : "tasks need"} attention` : "No reviews or blockers"}</span>
      </div>
      {all.length === 0 ? (
        <div className="board-empty">
          <EmptyState icon={ListChecks} title="No tasks yet" description="Give your team a clear outcome, then assign the work to an agent." action={<Button iconLeft={Plus} onClick={() => setCreating(true)}>Create your first task</Button>} />
        </div>
      ) : visible.length === 0 ? (
        <div className="board-empty"><EmptyState title="No matching tasks" description="Try a different title or priority to find the work you need." /></div>
      ) : (
        <div className="board-columns">
          {COLUMNS.map(({ key, statuses, label, empty }) => {
            const items = visible.filter((task) => statuses.includes(task.status));
            return (
              <section key={key} className="board-column" data-status={key} aria-label={label}>
                <h2 className="board-column__title">
                  <span className="work-board__status-dot" aria-hidden="true" />{label} <span className="count">{items.length}</span>
                </h2>
                {items.length === 0 ? (
                  <p className="board-column__empty">{empty}</p>
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
                          <span className="work-board-card__top"><StatusBadge status={task.status} /><PriorityBadge priority={task.priority} /></span>
                          <span className="board-card__title" title={task.title}>{task.title}</span>
                          {task.description ? <span className="work-board-card__description" title={task.description}>{task.description}</span> : null}
                          <span className="board-card__meta">
                            <span className="board-card__assignee" title={taskAssigneeName(task, bootstrap.data)}><UserRound size={13} aria-hidden="true" /><span className="u-truncate">{taskAssigneeName(task, bootstrap.data)}</span></span>
                            {task.acceptance_criteria.length > 0 ? <span className="work-board-card__criteria" title={`${task.acceptance_criteria.length} acceptance criteria`}><ListChecks size={14} aria-hidden="true" />{task.acceptance_criteria.length}</span> : null}
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
      {creating && projectId ? <CreateTaskModal projectId={projectId} onClose={() => setCreating(false)} onCreated={openTask} /> : null}
    </div>
  );
}
