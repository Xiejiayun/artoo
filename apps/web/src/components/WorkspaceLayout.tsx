import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { LeftRail } from "./LeftRail.js";
import { TaskDetailPanel } from "./TaskDetailPanel.js";
import { TaskRoom } from "./TaskRoom.js";

/**
 * Three-pane workspace shell (codex Round 15): left rail (project / tasks /
 * inbox), center (task room), right (task detail + run timeline + approvals +
 * artifacts). Center/right panels are filled in by later Phase 1 components.
 */
export function WorkspaceLayout(): React.ReactNode {
  const api = useApi();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });

  const userId = bootstrap.data?.user.id;
  useSubscription([
    ...(userId !== undefined ? [`inbox:${userId}`] : []),
    ...(selectedTaskId !== null ? [`task:${selectedTaskId}`] : []),
  ]);

  if (bootstrap.isLoading) {
    return <p role="status">Loading workspace…</p>;
  }
  if (bootstrap.isError || bootstrap.data === undefined) {
    return <p role="alert">Failed to load workspace.</p>;
  }

  const project = bootstrap.data.projects[0];
  if (project === undefined) {
    return <p role="alert">No projects available.</p>;
  }

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
          <TaskRoom taskId={selectedTaskId} />
        )}
      </main>
      <aside className="pane pane-right" aria-label="Task detail">
        {selectedTaskId === null ? null : <TaskDetailPanel taskId={selectedTaskId} />}
      </aside>
    </div>
  );
}
