import { useProject } from "../app/useProject.js";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { Button, EmptyState, ErrorState, StatusBadge } from "../ui/index.js";
import { AuditBundleView } from "./AuditBundleView.js";
import { ActionError } from "./ActionError.js";

/**
 * Runs & Audit (#16/#17 bridge): pick a task and inspect its server-built
 * read-only {@link TaskAuditBundle}. Strictly read-only — no actions. Refreshes
 * via the `project:` subscription (task activity invalidates its audit bundle).
 */
export function RunsAuditPage(): React.ReactNode {
  const api = useApi();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

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
        <ErrorState title="Failed to load" />
      </div>
    );
  }

  const taskList = tasks.data?.tasks ?? [];

  return (
    <div className="runs-audit">
      <header className="runs-audit-header">
        <h1 className="t-h1">Runs &amp; Audit</h1>
        {selectedTaskId && <Button loading={download.isPending} onClick={() => download.mutate()}>Export task evidence</Button>}
      </header>
      <ActionError error={tasks.error ?? download.error} />
      <div className="runs-audit-body">
        <nav className="audit-task-picker" aria-label="Tasks">
          <ul>
            {taskList.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className={`audit-task${task.id === selectedTaskId ? " is-selected" : ""}`}
                  aria-pressed={task.id === selectedTaskId}
                  onClick={() => setSelectedTaskId(task.id)}
                >
                  <span className="title u-truncate">{task.title}</span>
                  <StatusBadge status={task.status} />
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section className="audit-bundle" aria-label="Audit bundle">
          {selectedTaskId === null ? (
            <EmptyState title="No task selected" description="Pick a task to inspect its read-only audit bundle." />
          ) : null}
          {selectedTaskId !== null && bundle.isLoading ? (
            <p className="runs-audit-loading-label" role="status" aria-label="Loading audit bundle">
              Loading audit bundle
            </p>
          ) : null}
          {selectedTaskId !== null && bundle.isError ? <ErrorState title="Failed to load audit bundle" /> : null}
          {bundle.data !== undefined ? <AuditBundleView bundle={bundle.data.bundle} /> : null}
        </section>
      </div>
    </div>
  );
}
