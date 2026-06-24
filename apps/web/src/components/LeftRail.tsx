import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Badge, Button, SearchInput } from "../ui/index.js";
import { Plus } from "../ui/Icon.js";
import { CreateTaskModal } from "./CreateTaskModal.js";
import { TaskList } from "./TaskList.js";

export interface LeftRailProps {
  projectId: string;
  projectName: string;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

/** Left rail (#71): project header + pending-approval badge, primary "New task"
 *  action, a title search that filters the list, then the task list. */
export function LeftRail({
  projectId,
  projectName,
  selectedTaskId,
  onSelectTask,
}: LeftRailProps): React.ReactNode {
  const api = useApi();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  const approvals = useQuery({
    queryKey: queryKeys.approvals("pending"),
    queryFn: () => api.listApprovals("pending"),
  });
  const pendingCount = approvals.data?.approvals.length ?? 0;

  return (
    <div className="left-rail u-stack">
      <header className="left-rail-header">
        <h1 className="t-h2 u-truncate">{projectName}</h1>
        {pendingCount > 0 ? (
          <span role="img" aria-label={`${pendingCount} pending approvals`}>
            <Badge tone="danger">{pendingCount}</Badge>
          </span>
        ) : null}
      </header>
      <Button
        variant="primary"
        iconLeft={Plus}
        className="left-rail-new"
        onClick={() => setCreating(true)}
      >
        New task
      </Button>
      <SearchInput
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onClear={() => setFilter("")}
        placeholder="Filter tasks"
        aria-label="Filter tasks"
      />
      <TaskList
        projectId={projectId}
        selectedTaskId={selectedTaskId}
        onSelectTask={onSelectTask}
        filter={filter}
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
