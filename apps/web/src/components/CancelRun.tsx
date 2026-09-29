import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Run } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

export function CancelRun({ runs, taskId, projectId }: { runs: Run[]; taskId: string; projectId: string }): React.ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const mutation = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId, newIdempotencyKey()),
    onSuccess: async () => {
      setConfirm(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks(projectId) }),
      ]);
    },
  });
  const active = runs.find((run) => ["queued", "starting", "running", "awaiting_input", "paused", "cancelling"].includes(run.status));
  if (!active) return null;
  return <section className="u-stack-sm" aria-label="Run control">
    <ActionError error={mutation.error} />
    {confirm ? <div className="u-stack-sm" role="group" aria-label="Confirm cancellation">
      <p>Stop this run? Work already written to the workspace is retained.</p>
      <div className="action-row">
        <Button variant="danger" loading={mutation.isPending} onClick={() => mutation.mutate(active.id)}>Confirm stop</Button>
        <Button disabled={mutation.isPending} onClick={() => setConfirm(false)}>Keep running</Button>
      </div>
    </div> : <Button variant="danger" onClick={() => setConfirm(true)}>Stop run</Button>}
  </section>;
}
