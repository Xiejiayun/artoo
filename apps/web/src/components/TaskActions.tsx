import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { Task } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";

/**
 * Status-aware task lifecycle controls. Drives the happy path from the UI:
 * backlog → Mark ready → ready → Assign → running …; blocked → Retry. Each
 * mutation carries a fresh idempotency key and refreshes the task snapshot +
 * project list.
 */
export function TaskActions({ task }: { task: Task }): React.ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.tasks(task.project_id) });
  };

  const ready = useMutation({
    mutationFn: () => api.markReady(task.id, newIdempotencyKey()),
    onSuccess: invalidate,
  });
  const assign = useMutation({
    mutationFn: () => api.assignTask(task.id, { mode: "auto" }, newIdempotencyKey()),
    onSuccess: invalidate,
  });
  const retry = useMutation({
    mutationFn: () => api.retryTask(task.id, {}, newIdempotencyKey()),
    onSuccess: invalidate,
  });

  const busy = ready.isPending || assign.isPending || retry.isPending;

  if (task.status !== "backlog" && task.status !== "ready" && task.status !== "blocked") {
    return null;
  }

  return (
    <div className="task-actions">
      {task.status === "backlog" ? (
        <button type="button" disabled={busy} onClick={() => ready.mutate()}>
          Mark ready
        </button>
      ) : null}
      {task.status === "ready" ? (
        <button type="button" disabled={busy} onClick={() => assign.mutate()}>
          Assign
        </button>
      ) : null}
      {task.status === "blocked" ? (
        <button type="button" disabled={busy} onClick={() => retry.mutate()}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
