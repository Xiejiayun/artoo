import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

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
  const [approvalFilterProject, setApprovalFilterProject] = useState<string | null>(null);
  const tasks = useQuery({ queryKey: queryKeys.tasks(projectId), queryFn: () => api.listTasks(projectId) });
  const approvals = useQuery({
    queryKey: queryKeys.approvals("pending"),
    queryFn: () => api.listApprovals("pending"),
  });
  const needsInfo = useQuery({ queryKey: queryKeys.approvals("needs_more_info"), queryFn: () => api.listApprovals("needs_more_info") });
  // Approvals are organization-scoped. Join against this project's actual task
  // IDs; execution approvals can belong to ready tasks, before any run exists.
  const unresolved = useMemo(() => {
    const projectTasks = new Set(tasks.data?.tasks.filter((task) => task.project_id === projectId).map((task) => task.id));
    const records = new Map([...(approvals.data?.approvals ?? []), ...(needsInfo.data?.approvals ?? [])]
      .map((approval) => [approval.id, approval]));
    return [...records.values()]
      .filter((approval) => projectTasks.has(approval.task_id) && approval.payload_ref !== "execution-gate/superseded"
        && (approval.status === "pending" || approval.status === "needs_more_info"));
  }, [tasks.data, approvals.data, needsInfo.data, projectId]);
  const unresolvedCount = unresolved.length;
  const approvalTaskIds = useMemo(() => new Set(unresolved.map((approval) => approval.task_id)), [unresolved]);
  const showApprovals = approvalFilterProject === projectId;

  return (
    <div className="left-rail u-stack">
      <header className="left-rail-header">
        <h1 className="t-h2 u-truncate">{projectName}</h1>
        {unresolvedCount > 0 ? (
          <Button size="sm" variant="ghost" aria-label={`${unresolvedCount} pending approvals`} aria-pressed={showApprovals}
            onClick={() => {
              setApprovalFilterProject(showApprovals ? null : projectId);
              setFilter("");
              if (!showApprovals && unresolved[0]) onSelectTask(unresolved[0].task_id);
            }}>
            <Badge tone="danger">{unresolvedCount}</Badge>
          </Button>
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
      {showApprovals && <div className="u-stack-sm"><p role="status">Showing tasks with pending approvals.</p>
        <Button size="sm" variant="ghost" onClick={() => setApprovalFilterProject(null)}>Show all tasks</Button></div>}
      <TaskList
        projectId={projectId}
        selectedTaskId={selectedTaskId}
        onSelectTask={onSelectTask}
        filter={filter}
        taskIds={showApprovals ? approvalTaskIds : undefined}
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
