import type { Task, TaskDelegationTreeV1 } from "@artoo/domain";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { usePollMs } from "../app/RealtimeContext.js";
import { Button, ErrorState, Select, StatusBadge } from "../ui/index.js";

/** Load explicit server delegation; parent_task_id alone may mean conversation history. */
export function BoardDelegationView({
  tasks,
  projectId,
  onSelectTask,
}: {
  tasks: Task[];
  projectId: string;
  onSelectTask: (id: string) => void;
}): React.ReactNode {
  const api = useApi();
  const [selected, setSelected] = useState("");
  const root = tasks.some((task) => task.id === selected) ? selected : tasks[0]?.id;
  const tree = useQuery({
    queryKey: queryKeys.delegationTree(projectId, root ?? "none"),
    queryFn: () => api.getTaskDelegationTree(root!),
    enabled: !!root,
    refetchInterval: usePollMs(10000),
  });
  const nodes = tree.data?.nodes ?? [];
  function node(item: TaskDelegationTreeV1["nodes"][number], visited: Set<string>): React.ReactNode {
    if (visited.has(item.task_id)) return <li key={item.task_id}>Invalid delegation cycle reported.</li>;
    const seen = new Set(visited).add(item.task_id);
    const children = nodes.filter((entry) => entry.parent_task_id === item.task_id);
    return (
      <li key={item.task_id}>
        <div>
          <Button variant="ghost" onClick={() => onSelectTask(item.task_id)}>
            {item.title}
          </Button>
          <StatusBadge status={item.status} />
          <small>Depth {item.depth}</small>
        </div>
        {children.length > 0 && <ul>{children.map((child) => node(child, seen))}</ul>}
      </li>
    );
  }
  return (
    <section className="cowork-delegation-view" aria-label="Delegation tree">
      <Select label="Inspect task delegation" value={root ?? ""} onChange={(event) => setSelected(event.target.value)}>
        {tasks.map((task) => (
          <option key={task.id} value={task.id}>
            {task.title}
          </option>
        ))}
      </Select>
      <p>Explicit delegation relationships. Plan dependencies remain in Plan and task details.</p>
      {tree.isLoading && <p role="status">Loading delegation tree…</p>}
      {tree.isError && (
        <ErrorState
          title="Delegation unavailable"
          description={tree.error.message}
          action={<Button onClick={() => void tree.refetch()}>Retry delegation</Button>}
        />
      )}
      {tree.data && (
        <>
          <p>
            {nodes.length} / {tree.data.limits.max_tasks} tasks · maximum depth {tree.data.limits.max_depth}
          </p>
          <ul>{nodes.filter((item) => item.parent_task_id === null).map((item) => node(item, new Set()))}</ul>
        </>
      )}
    </section>
  );
}
