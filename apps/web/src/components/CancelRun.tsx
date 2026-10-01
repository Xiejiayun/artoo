import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Run } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

export function CancelRun({ runs, taskId, projectId }: { runs: Run[]; taskId: string; projectId: string }): React.ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();
  const active = runs.find((run) => ["queued", "starting", "running", "awaiting_input", "paused", "cancelling"].includes(run.status));
  const [confirmedRunId, setConfirmedRunId] = useState<string | null>(null);
  // A task can finish one execution and start another while this control stays
  // mounted. A confirmation belongs only to the execution the user selected.
  useEffect(() => { setConfirmedRunId(null); }, [active?.id]);
  const mutation = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId, newIdempotencyKey()),
    onSuccess: async () => {
      setConfirmedRunId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks(projectId) }),
      ]);
    },
  });
  if (!active) return null;
  return <section className="u-stack-sm" aria-label="Run control">
    <ActionError error={mutation.error} />
    {confirmedRunId === active.id ? <div className="u-stack-sm" role="group" aria-label="Confirm cancellation">
      <p>Stop this run and cancel its task? Work already written to the workspace is retained.</p>
      <p className="run-id">Run {confirmedRunId}</p>
      <div className="action-row">
        <Button variant="danger" loading={mutation.isPending} onClick={() => mutation.mutate(confirmedRunId)}>Confirm stop</Button>
        <Button disabled={mutation.isPending} onClick={() => setConfirmedRunId(null)}>Keep running</Button>
      </div>
    </div> : <Button variant="danger" disabled={mutation.isPending} onClick={() => setConfirmedRunId(active.id)}>Stop run</Button>}
  </section>;
}
