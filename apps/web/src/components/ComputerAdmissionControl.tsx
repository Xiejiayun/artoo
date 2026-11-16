import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { usePollMs } from "../app/RealtimeContext.js";
import { Badge, Button } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

export function ComputerAdmissionControl({ computerId, role }: { computerId: string; role: string }): React.ReactNode {
  const api = useApi(),
    query = useQueryClient();
  const admission = useQuery({
    queryKey: queryKeys.computerAdmission(computerId),
    queryFn: () => api.getComputerAdmission(computerId),
    refetchInterval: usePollMs(10000),
  });
  const update = useMutation({
    mutationFn: () => {
      if (!admission.data) throw new Error("Observe the current admission setting before changing it.");
      return api.putComputerAdmission(
        computerId,
        admission.data.admission.revision,
        admission.data.admission.state === "accepting" ? "draining" : "accepting",
      );
    },
    onSuccess: async (result) => {
      query.setQueryData(queryKeys.computerAdmission(computerId), result);
      await Promise.all([
        query.invalidateQueries({ queryKey: queryKeys.bootstrap }),
        query.invalidateQueries({ queryKey: queryKeys.projectControlView() }),
      ]);
    },
    onError: () => admission.refetch(),
  });
  const state = admission.data?.admission.state;
  return (
    <section className="cowork-admission" aria-label="Machine task admission">
      <div className="action-row">
        <strong>New task admission</strong>
        <Badge tone={state === "draining" ? "warning" : state === "accepting" ? "success" : "neutral"}>
          {state === "draining" ? "Paused for new tasks" : state === "accepting" ? "Accepting new tasks" : "Unknown"}
        </Badge>
        {["owner", "admin"].includes(role) && (
          <Button
            size="sm"
            disabled={!admission.data || admission.isError}
            loading={update.isPending}
            onClick={() => update.mutate()}
          >
            {state === "draining" ? "Resume new tasks" : "Pause new tasks"}
          </Button>
        )}
      </div>
      <p>
        Pausing preserves existing Runs, processes and occupied capacity. It only prevents new admission on this
        machine.
      </p>
      <ActionError error={admission.error ?? update.error} />
      {admission.isError && (
        <Button size="sm" onClick={() => void admission.refetch()}>
          Reload admission
        </Button>
      )}
      {update.isSuccess && <p role="status">Admission setting saved.</p>}
    </section>
  );
}
