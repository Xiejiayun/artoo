import { useQuery } from "@tanstack/react-query";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { useSelection } from "../app/SelectionContext.js";
import { Button, EmptyState, ErrorState, Skeleton } from "../ui/index.js";
import { Icon, ListTodo } from "../ui/Icon.js";
import { LeftRail } from "./LeftRail.js";
import { TaskDetailPanel } from "./TaskDetailPanel.js";
import { TaskRoom } from "./TaskRoom.js";

/** Left-rail skeleton shown during boot — matches the final rail layout. */
function RailSkeleton(): React.ReactNode {
  return (
    <div className="u-stack" aria-hidden="true">
      <Skeleton height={20} width="55%" />
      <Skeleton height={32} />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="u-stack-sm rail-skeleton-item">
          <Skeleton height={14} width="70%" />
          <Skeleton height={12} width="35%" />
        </div>
      ))}
    </div>
  );
}

/**
 * Three-pane workspace shell (#70): left rail (project / tasks / inbox), center
 * (task room / activity), right (task detail + run timeline + approvals +
 * artifacts). Selection is shared via SelectionContext so the Board can
 * deep-link into a task. Loading/error/empty states use the ui primitives.
 */
export function WorkspaceLayout(): React.ReactNode {
  const api = useApi();
  const { selectedTaskId, setSelectedTaskId } = useSelection();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });

  const userId = bootstrap.data?.user.id;
  const projectId = bootstrap.data?.projects[0]?.id;
  useSubscription([
    ...(userId !== undefined ? [`inbox:${userId}`] : []),
    ...(projectId !== undefined ? [`project:${projectId}`] : []),
    ...(selectedTaskId !== null ? [`task:${selectedTaskId}`] : []),
  ]);

  if (bootstrap.isLoading) {
    return (
      <div className="workspace">
        <span className="workspace-loading-label" role="status" aria-label="Loading workspace">
          Loading workspace...
        </span>
        <aside className="pane pane-left">
          <RailSkeleton />
        </aside>
        <main className="pane pane-center" aria-label="Task room" aria-busy="true" />
        <aside className="pane pane-right" aria-label="Task detail" />
      </div>
    );
  }
  if (bootstrap.isError || bootstrap.data === undefined) {
    return (
      <div className="workspace-state">
        <ErrorState
          title="Failed to load workspace"
          description="The server could not be reached. Check the connection and try again."
          action={
            <Button variant="primary" onClick={() => void bootstrap.refetch()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  const project = bootstrap.data.projects[0];
  if (project === undefined) {
    return (
      <div className="workspace-state">
        <EmptyState title="No projects yet" description="Create a project to start tracking agent work." />
      </div>
    );
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
          <div className="pane-placeholder">
            <EmptyState
              icon={ListTodo}
              title="No task selected"
              description="Choose a task from the rail to view its room and activity."
            />
          </div>
        ) : (
          <TaskRoom taskId={selectedTaskId} />
        )}
      </main>
      <aside className="pane pane-right" aria-label="Task detail">
        {selectedTaskId === null ? (
          <p className="pane-hint">
            <Icon icon={ListTodo} size={14} /> Task details, runs, and approvals appear here.
          </p>
        ) : (
          <TaskDetailPanel taskId={selectedTaskId} />
        )}
      </aside>
    </div>
  );
}
