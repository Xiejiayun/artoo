import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { Task } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi, useCommands } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button } from "../ui/index.js";

/**
 * Status-aware task lifecycle controls. Drives the happy path from the UI:
 * backlog → Mark ready → ready → Assign → running …; blocked → Retry. Each
 * mutation runs through the canonical @artoo/client command queue (#27 dogfood)
 * with a stable idempotency key, so a flaky/offline send is queued and replayed
 * once on reconnect rather than lost or double-applied. Then it refreshes the
 * task snapshot + project list.
 */
export function TaskActions({ task }: { task: Task }): React.ReactNode {
  const api = useApi();
  const commands = useCommands();
  const queryClient = useQueryClient();

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.tasks(task.project_id) });
  };

  const ready = useMutation({
    mutationFn: () => {
      const key = newIdempotencyKey();
      return commands.submit(() => api.markReady(task.id, key), { key });
    },
    onSuccess: invalidate,
  });
  const assign = useMutation({
    mutationFn: () => {
      const key = newIdempotencyKey();
      return commands.submit(() => api.assignTask(task.id, { mode: "auto" }, key), { key });
    },
    onSuccess: invalidate,
  });
  const retry = useMutation({
    mutationFn: () => {
      const key = newIdempotencyKey();
      return commands.submit(() => api.retryTask(task.id, {}, key), { key });
    },
    onSuccess: invalidate,
  });

  const busy = ready.isPending || assign.isPending || retry.isPending;

  if (task.status !== "backlog" && task.status !== "ready" && task.status !== "blocked") {
    return null;
  }

  return (
    <div className="task-actions">
      {task.status === "backlog" ? (
        <Button variant="primary" loading={ready.isPending} disabled={busy} onClick={() => ready.mutate()}>
          Mark ready
        </Button>
      ) : null}
      {task.status === "ready" ? (
        <Button variant="primary" loading={assign.isPending} disabled={busy} onClick={() => assign.mutate()}>
          Assign
        </Button>
      ) : null}
      {task.status === "blocked" ? (
        <Button variant="primary" loading={retry.isPending} disabled={busy} onClick={() => retry.mutate()}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
