import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { LeftRail } from "./LeftRail.js";

/**
 * Three-pane workspace shell (codex Round 15): left rail (project / tasks /
 * inbox), center (task room), right (task detail + run timeline + approvals +
 * artifacts). Center/right panels are filled in by later Phase 1 components.
 */
export function WorkspaceLayout(): React.ReactNode {
  const api = useApi();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });

  if (bootstrap.isLoading) {
    return <p role="status">Loading workspace…</p>;
  }
  if (bootstrap.isError || bootstrap.data === undefined) {
    return <p role="alert">Failed to load workspace.</p>;
  }

  const { project } = bootstrap.data;

  return (
    <div className="workspace">
      <aside className="pane pane-left">
        <LeftRail
          projectId={project.id}
          projectName={project.name}
          selectedTaskId={selectedTaskId}
          onSelectTask={setSelectedTaskId}
        />
      </aside>
      <main className="pane pane-center" aria-label="Task room">
        {selectedTaskId === null ? (
          <p className="empty">Select a task to view its room.</p>
        ) : (
          <section data-testid="task-room-placeholder">Task room: {selectedTaskId}</section>
        )}
      </main>
      <aside className="pane pane-right" aria-label="Task detail">
        {selectedTaskId === null ? null : (
          <section data-testid="task-detail-placeholder">Task detail: {selectedTaskId}</section>
        )}
      </aside>
    </div>
  );
}
