import type { Task, TaskDelegationTreeV1 } from "@artoo/domain";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { usePollMs } from "../app/RealtimeContext.js";
import { useSelection } from "../app/SelectionContext.js";
import { Button, StatusBadge } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { CreateTaskModal } from "./CreateTaskModal.js";
import "./task-delegation.css";

type TreeNode = TaskDelegationTreeV1["nodes"][number];

/** Ordinary per-Task actions remain in task detail; tree navigation grants no execution authority. */
export function TaskDelegationPanel({
  task,
  expanded,
  onExpandedChange,
  onSelectTask,
}: {
  task: Task;
  expanded: boolean;
  onExpandedChange: (value: boolean) => void;
  onSelectTask?: (id: string) => void;
}): React.ReactNode {
  const api = useApi();
  const { setSelectedTaskId } = useSelection();
  const selectTask = onSelectTask ?? setSelectedTaskId;
  const [creatingParent, setCreatingParent] = useState<Pick<Task, "id" | "title"> | null>(null);
  const helpId = useId();
  const tree = useQuery({
    queryKey: queryKeys.delegationTree(task.project_id, task.id),
    queryFn: () => api.getTaskDelegationTree(task.id),
    enabled: expanded,
    refetchInterval: usePollMs(10000),
  });
  const data = tree.data;
  const selected = data?.nodes.find((node) => node.task_id === task.id);
  const unavailable = !data || !selected || data.selected_task_id !== task.id;
  const reason = unavailable
    ? "Load the current delegation tree before creating a task."
    : !data.creation_enabled
      ? "Creating delegated tasks is disabled for this project."
      : ["done", "cancelled"].includes(selected.status) || ["done", "cancelled"].includes(task.status)
        ? "Completed or cancelled tasks cannot delegate new work."
        : selected.depth >= data.limits.max_depth
          ? `This task is at the maximum delegation depth of ${data.limits.max_depth}.`
          : data.nodes.length >= data.limits.max_tasks
            ? `This tree has reached its limit of ${data.limits.max_tasks} tasks, including completed and cancelled tasks.`
            : undefined;

  function renderNode(node: TreeNode): React.ReactNode {
    const children = data!.nodes.filter((child) => child.parent_task_id === node.task_id);
    return (
      <li key={node.task_id}>
        <div className="work-delegation__node">
          <Button
            size="sm"
            variant="ghost"
            aria-current={node.task_id === task.id ? "true" : undefined}
            onClick={() => selectTask(node.task_id)}
          >
            {node.title}
          </Button>
          <StatusBadge status={node.status} />
          <span className="work-help">Depth {node.depth}</span>
        </div>
        {children.length > 0 ? <ul>{children.map(renderNode)}</ul> : null}
      </li>
    );
  }

  return (
    <section className="task-detail__section u-stack-sm work-delegation" aria-label="Task delegation">
      <h3 className="task-detail__section-title">Task delegation</h3>
      <Button size="sm" aria-expanded={expanded} onClick={() => onExpandedChange(!expanded)}>
        {expanded ? "Hide delegation tree" : "Show delegation tree"}
      </Button>
      {expanded ? (
        <>
          <ActionError error={tree.error} />
          {tree.isLoading ? <p role="status">Loading delegation tree…</p> : null}
          {data && !unavailable ? (
            <>
              <p>
                {data.nodes.length} / {data.limits.max_tasks} tasks · Selected depth {selected.depth} /{" "}
                {data.limits.max_depth}
              </p>
              <ul aria-label="Delegation tree">
                {data.nodes.filter((node) => node.parent_task_id === null).map(renderNode)}
              </ul>
            </>
          ) : null}
          <div className="action-row">
            <Button
              size="sm"
              disabled={!!reason || tree.isFetching || tree.isError}
              aria-describedby={helpId}
              onClick={() => setCreatingParent({ id: task.id, title: task.title })}
            >
              Delegate task
            </Button>
            <Button size="sm" loading={tree.isFetching} onClick={() => void tree.refetch()}>
              Refresh delegation tree
            </Button>
          </div>
          <p id={helpId} className="work-help">
            {reason ?? "New tasks start in Backlog and need their own assignment and review."}
          </p>
          <p className="work-help">
            Select a task to review its details or stop its active run. Stopping a run affects only that task; other
            tasks continue. Parent acceptance and product release require their existing reviews.
          </p>
        </>
      ) : null}
      {creatingParent ? (
        <CreateTaskModal
          key={creatingParent.id}
          projectId={task.project_id}
          delegationParent={creatingParent}
          onClose={() => setCreatingParent(null)}
          onCreated={selectTask}
        />
      ) : null}
    </section>
  );
}
