import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { CreateTaskModal } from "./CreateTaskModal.js";
import { TaskList } from "./TaskList.js";

export interface LeftRailProps {
  projectId: string;
  projectName: string;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

/** Left rail: project header, pending-approval inbox badge, task list, create. */
export function LeftRail({
  projectId,
  projectName,
  selectedTaskId,
  onSelectTask,
}: LeftRailProps): React.ReactNode {
  const api = useApi();
  const [creating, setCreating] = useState(false);
  const approvals = useQuery({
    queryKey: queryKeys.approvals("pending"),
    queryFn: () => api.listApprovals("pending"),
  });
  const pendingCount = approvals.data?.approvals.length ?? 0;

  return (
    <div className="left-rail">
      <header className="left-rail-header">
        <h1>{projectName}</h1>
        {pendingCount > 0 ? (
          <span className="inbox-badge" aria-label={`${pendingCount} pending approvals`}>
            {pendingCount}
          </span>
        ) : null}
      </header>
      <button type="button" className="new-task" onClick={() => setCreating(true)}>
        New Task
      </button>
      <TaskList
        projectId={projectId}
        selectedTaskId={selectedTaskId}
        onSelectTask={onSelectTask}
      />
      {creating ? (
        <CreateTaskModal
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={onSelectTask}
        />
      ) : null}
    </div>
  );
}
