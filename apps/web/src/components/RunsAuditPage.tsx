import { useProject } from "../app/useProject.js";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Download, History } from "lucide-react";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { Button, EmptyState, ErrorState, Input, Select, StatusBadge } from "../ui/index.js";
import { AuditBundleView } from "./AuditBundleView.js";
import { ActionError } from "./ActionError.js";
import { taskUpdatedLabel } from "./taskPresentation.js";
import "../ui/work-insights.css";

/**
 * Runs & Audit (#16/#17 bridge): pick a task and inspect its server-built
 * read-only {@link TaskAuditBundle}. Strictly read-only — no actions. Refreshes
 * via the `project:` subscription (task activity invalidates its audit bundle).
 */
export function RunsAuditPage(): React.ReactNode {
  const api = useApi();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");

  const { bootstrap, projectId } = useProject();
  useEffect(() => setSelectedTaskId(null), [projectId]);
  const download = useMutation({ mutationFn: async () => {
    const result = await api.getTaskAuditBundleExport(selectedTaskId!);
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.export, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `${selectedTaskId}-audit.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  useSubscription(projectId === undefined ? [] : [`project:${projectId}`]);

  const tasks = useQuery({
    queryKey: projectId === undefined ? ["tasks", "pending"] : queryKeys.tasks(projectId),
    queryFn: () => api.listTasks(projectId as string),
    enabled: projectId !== undefined,
  });

  const bundle = useQuery({
    queryKey:
      selectedTaskId === null ? ["auditBundle", "none"] : queryKeys.auditBundle(selectedTaskId),
    queryFn: () => api.getTaskAuditBundle(selectedTaskId as string),
    enabled: selectedTaskId !== null,
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

  const taskList = tasks.data?.tasks ?? [];
  const matching = taskList.filter((task) => task.title.toLowerCase().includes(search.trim().toLowerCase()) && (filter === "all" || (filter === "attention" ? ["blocked", "awaiting_approval", "review"].includes(task.status) : ["done", "cancelled"].includes(task.status))));

  return (
    <div className="runs-audit insights-page">
      <header className="insights-page__header">
        <div><span className="insights-eyebrow"><History size={15} aria-hidden="true" /> Execution history</span><h1 className="t-h1">Runs &amp; Audit</h1><p>Follow each task from assignment to results, decisions, and recorded evidence.</p></div>
        {selectedTaskId && <Button iconLeft={Download} loading={download.isPending} onClick={() => download.mutate()}>Export task evidence</Button>}
      </header>
      <ActionError error={tasks.error ?? download.error} />
      <div className="runs-audit-body">
        <nav className="audit-task-picker" aria-label="Tasks">
          <div className="insights-picker-tools"><Input label="Search tasks" placeholder="Find a task…" value={search} onChange={(event) => setSearch(event.target.value)} /><Select label="Task view" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All tasks</option><option value="attention">Needs attention</option><option value="closed">Closed</option></Select></div>
          <p className="insights-help">{matching.length} {matching.length === 1 ? "task" : "tasks"}</p>
          {tasks.isLoading && <p role="status">Loading tasks…</p>}
          {tasks.isError && <Button size="sm" onClick={() => void tasks.refetch()}>Retry tasks</Button>}
          {!tasks.isLoading && !matching.length && <EmptyState title="No tasks found" description={search || filter !== "all" ? "Try another search or view." : "Create a task to start collecting execution evidence."} />}
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
                  <span className="insights-row-meta"><StatusBadge status={task.status} /><time dateTime={task.updated_at}>{taskUpdatedLabel(task.updated_at)}</time></span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section className="audit-bundle" aria-label="Audit bundle">
          {selectedTaskId === null ? (
            <EmptyState icon={History} title="No task selected" description="Choose a task to review its runs, outputs, and decision history." />
          ) : null}
          {selectedTaskId !== null && bundle.isLoading ? (
            <p className="runs-audit-loading-label" role="status" aria-label="Loading audit bundle">
              Loading audit bundle
            </p>
          ) : null}
          {selectedTaskId !== null && bundle.isError ? <ErrorState title="Failed to load audit bundle" action={<Button onClick={() => void bundle.refetch()}>Retry evidence</Button>} /> : null}
          {bundle.data !== undefined ? <AuditBundleView bundle={bundle.data.bundle} bootstrap={bootstrap.data} /> : null}
        </section>
      </div>
    </div>
  );
}
