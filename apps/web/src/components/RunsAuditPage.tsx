import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { AuditBundleView } from "./AuditBundleView.js";

/**
 * Runs & Audit (#16/#17 bridge): pick a task and inspect its server-built
 * read-only {@link TaskAuditBundle}. Strictly read-only — no actions. Refreshes
 * via the `project:` subscription (task activity invalidates its audit bundle).
 */
export function RunsAuditPage(): React.ReactNode {
  const api = useApi();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const projectId = bootstrap.data?.projects[0]?.id;
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
    return <p role="status">Loading…</p>;
  }
  if (bootstrap.isError || projectId === undefined) {
    return <p role="alert">Failed to load.</p>;
  }

  const taskList = tasks.data?.tasks ?? [];

  return (
    <div className="runs-audit">
      <header className="runs-audit-header">
        <h1>Runs &amp; Audit</h1>
        <p className="hint">Read-only task evidence from the server audit bundle.</p>
      </header>
      <div className="runs-audit-body">
        <nav className="audit-task-picker" aria-label="Tasks">
          <ul>
            {taskList.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="audit-task"
                  aria-pressed={task.id === selectedTaskId}
                  onClick={() => setSelectedTaskId(task.id)}
                >
                  <span className="title">{task.title}</span>
                  <span className="status">{task.status}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section className="audit-bundle" aria-label="Audit bundle">
          {selectedTaskId === null ? <p>Select a task to view its audit bundle.</p> : null}
          {selectedTaskId !== null && bundle.isLoading ? (
            <p role="status">Loading audit bundle…</p>
          ) : null}
          {selectedTaskId !== null && bundle.isError ? (
            <p role="alert">Failed to load audit bundle.</p>
          ) : null}
          {bundle.data !== undefined ? <AuditBundleView bundle={bundle.data.bundle} /> : null}
        </section>
      </div>
    </div>
  );
}
