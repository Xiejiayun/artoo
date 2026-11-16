import { useProject } from "../app/useProject.js";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, History } from "lucide-react";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { Button, EmptyState, ErrorState, Input, Select, StatusBadge, useToast } from "../ui/index.js";
import { AuditBundleView } from "./AuditBundleView.js";
import { ActionError } from "./ActionError.js";
import { taskUpdatedLabel } from "./taskPresentation.js";
import { useTaskContext } from "../app/useTaskContext.js";
import { useProjectControlView } from "../app/useProjectControlView.js";
import { useGoalContext } from "../app/useGoalContext.js";
import { ControlTaskFacts } from "./ControlTaskFacts.js";
import { TaskExecutionConsole } from "./TaskExecutionConsole.js";
import "../ui/work-insights.css";

/**
 * Runs & Audit (#16/#17 bridge): pick a task and inspect its server-built
 * {@link TaskAuditBundle}, real execution console and task conversation. Refreshes
 * via the `project:` subscription (task activity invalidates its audit bundle).
 */
export function RunsAuditPage(): React.ReactNode {
  const api = useApi();
  const toast = useToast();
  const [params] = useSearchParams();
  const goals = useGoalContext(false, params.has("goal"));
  const {
    taskId: selectedTaskId,
    selectTask: setSelectedTaskId,
    contextError,
    contextLoading,
    retryContext,
  } = useTaskContext();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");

  const { bootstrap, projectId } = useProject();
  const control = useProjectControlView(projectId);
  const download = useMutation({
    mutationFn: async () => {
      const result = await api.getTaskAuditBundleExport(selectedTaskId!, "ed25519-v1");
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.export, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${selectedTaskId}-audit.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    onSuccess: () => toast.push({ tone: "success", message: "Task evidence download started." }),
  });
  useSubscription(projectId === undefined ? [] : [`project:${projectId}`]);

  const tasks = useQuery({
    queryKey: projectId === undefined ? queryKeys.tasks("pending") : queryKeys.tasks(projectId),
    queryFn: () => api.listTasks(projectId as string),
    enabled: projectId !== undefined,
  });

  const bundle = useQuery({
    queryKey: selectedTaskId === null ? ["auditBundle", "none"] : queryKeys.auditBundle(selectedTaskId),
    queryFn: () => api.getTaskAuditBundle(selectedTaskId as string),
    enabled:
      selectedTaskId !== null &&
      !contextLoading &&
      !contextError &&
      !goals.contextLoading &&
      !goals.contextError &&
      (!goals.requested || !!goals.goal),
  });

  if (bootstrap.isLoading) {
    return (
      <div className="runs-audit">
        <p className="runs-audit-loading-label" role="status" aria-label="Loading runs and audit">
          Loading runs and audit
        </p>
      </div>
    );
  }
  if (bootstrap.isError || projectId === undefined) {
    return (
      <div className="runs-audit">
        <ErrorState title="Failed to load" action={<Button onClick={() => void bootstrap.refetch()}>Retry</Button>} />
      </div>
    );
  }

  const loaded = new Map(tasks.data?.tasks.map((task) => [task.id, task]) ?? []);
  for (const entry of control.isError ? [] : control.entries) loaded.set(entry.task.id, entry.task);
  const observations = new Map(control.entries.map((entry) => [entry.task.id, entry]));
  const taskList = [...loaded.values()];
  const matching = taskList.filter(
    (task) =>
      (!goals.requested || (!!goals.goal && task.goal_id === goals.goal.id)) &&
      task.title.toLowerCase().includes(search.trim().toLowerCase()) &&
      (filter === "all" ||
        (filter === "attention"
          ? ["blocked", "awaiting_approval", "review"].includes(task.status)
          : ["done", "cancelled"].includes(task.status))),
  );
  const evidenceTask = bundle.data?.bundle.task;
  // The control projection also links independently owned review tasks to their
  // originating Goal. That observation supplies scope, never review authority.
  const evidenceGoalId =
    evidenceTask?.goal_id ?? (control.isError ? undefined : observations.get(evidenceTask?.id ?? "")?.task.goal_id);
  const evidenceInScope =
    !!evidenceTask &&
    evidenceTask.id === selectedTaskId &&
    evidenceTask.project_id === projectId &&
    evidenceTask.organization_id === bootstrap.data?.organization.id &&
    (!goals.requested || (!!goals.goal && evidenceGoalId === goals.goal.id));

  return (
    <div className="runs-audit insights-page">
      <header className="insights-page__header">
        <div>
          <span className="insights-eyebrow">
            <History size={15} aria-hidden="true" /> Execution history
          </span>
          <h1 className="t-h1">Runs &amp; Audit</h1>
          <p>Follow each task from assignment to results, decisions, and recorded evidence.</p>
        </div>
        {selectedTaskId && evidenceInScope && (
          <Button iconLeft={Download} loading={download.isPending} onClick={() => download.mutate()}>
            Export task evidence
          </Button>
        )}
      </header>
      <ActionError
        error={
          tasks.error ??
          download.error ??
          contextError ??
          goals.contextError ??
          (goals.requested ? goals.goals.error : null)
        }
      />
      {contextError && <Button onClick={retryContext}>Retry linked task</Button>}
      {goals.contextError && <Button onClick={goals.retryContext}>Retry linked goal</Button>}
      {(contextLoading || goals.contextLoading) && <p role="status">Opening linked execution context…</p>}
      {goals.requested && (
        <div className="action-row">
          <p>Goal: {goals.goal?.title ?? "Resolving shared goal…"}</p>
          <Button size="sm" onClick={() => goals.selectGoal(null)}>
            Show all project goals
          </Button>
        </div>
      )}
      {control.isError && (
        <p role="status">
          Execution observations unavailable.{" "}
          <Button size="sm" onClick={() => void control.refetch()}>
            Retry observations
          </Button>
        </p>
      )}
      <div className="runs-audit-body">
        <nav className="audit-task-picker" aria-label="Tasks">
          <div className="insights-picker-tools">
            <Input
              label="Search tasks"
              placeholder="Find a task…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select label="Task view" value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">All tasks</option>
              <option value="attention">Needs attention</option>
              <option value="closed">Closed</option>
            </Select>
          </div>
          <p className="insights-help">
            {matching.length} loaded {matching.length === 1 ? "task" : "tasks"}
            {goals.requested ? " in selected goal" : ""}
            {control.view ? ` · ${control.view.summary.total_tasks} in project` : ""}
          </p>
          {tasks.isLoading && <p role="status">Loading tasks…</p>}
          {tasks.isError && (
            <Button size="sm" onClick={() => void tasks.refetch()}>
              Retry tasks
            </Button>
          )}
          {!tasks.isLoading && !matching.length && (
            <EmptyState
              title="No tasks found"
              description={
                search || filter !== "all"
                  ? "Try another search or view."
                  : "Create a task to start collecting execution evidence."
              }
            />
          )}
          <ul>
            {matching.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className={`audit-task${task.id === selectedTaskId ? " is-selected" : ""}`}
                  aria-pressed={task.id === selectedTaskId}
                  onClick={() => setSelectedTaskId(task.id)}
                >
                  <span className="title">{task.title}</span>
                  {!control.isError && observations.has(task.id) && (
                    <ControlTaskFacts entry={observations.get(task.id)!} bootstrap={bootstrap.data} />
                  )}
                  <span className="insights-row-meta">
                    <StatusBadge status={task.status} />
                    <time dateTime={task.updated_at}>{taskUpdatedLabel(task.updated_at)}</time>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {control.hasNextPage && (
            <Button loading={control.isFetchingNextPage} onClick={() => void control.fetchNextPage()}>
              Load more tasks
            </Button>
          )}
        </nav>

        <section className="audit-bundle" aria-label="Task execution">
          {selectedTaskId === null ? (
            <EmptyState
              icon={History}
              title="No task selected"
              description="Choose a task to review its runs, outputs, and decision history."
            />
          ) : null}
          {selectedTaskId !== null && bundle.isLoading ? (
            <p className="runs-audit-loading-label" role="status" aria-label="Loading audit bundle">
              Loading audit bundle
            </p>
          ) : null}
          {selectedTaskId !== null && bundle.isError ? (
            <ErrorState
              title="Failed to load audit bundle"
              action={<Button onClick={() => void bundle.refetch()}>Retry evidence</Button>}
            />
          ) : null}
          {bundle.data !== undefined &&
            !contextLoading &&
            !contextError &&
            !goals.contextLoading &&
            !goals.contextError &&
            !evidenceInScope && (
              <EmptyState
                title="This task is outside the current execution scope"
                description="Choose a task in this project's selected goal, or show all project goals."
              />
            )}
          {bundle.data !== undefined &&
          evidenceInScope &&
          !contextLoading &&
          !contextError &&
          !goals.contextLoading &&
          !goals.contextError ? (
            <>
              <TaskExecutionConsole
                key={bundle.data.bundle.task.id}
                bundle={bundle.data.bundle}
                bootstrap={bootstrap.data}
              />
              <section aria-label="Audit bundle">
                <details className="cowork-audit-detail" open>
                  <summary>Full task audit & evidence</summary>
                  <AuditBundleView bundle={bundle.data.bundle} bootstrap={bootstrap.data} />
                </details>
              </section>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
