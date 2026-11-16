import type { AgentInstance, ProjectSquadV1 } from "@artoo/domain";
import { useQuery } from "@tanstack/react-query";
import type { BootstrapResponse } from "../api/types.js";
import { useApi } from "./ApiContext.js";
import { queryKeys } from "./queryKeys.js";
import { usePollMs, useSubscription } from "./RealtimeContext.js";

/** Membership is observed from the server. It never grants execution permission. */
export function squadInstances(squad: ProjectSquadV1, instances: AgentInstance[]): AgentInstance[] {
  return instances.filter(
    (instance) =>
      squad.agent_ids.includes(instance.agent_id) &&
      (instance.project_id === squad.project_id || (squad.source === "configured" && instance.project_id === null)),
  );
}
export function useProjectSquad(projectId: string | undefined, bootstrap?: BootstrapResponse) {
  const api = useApi();
  useSubscription(projectId ? [`project:${projectId}`] : []);
  const query = useQuery({
    queryKey: queryKeys.projectSquad(projectId),
    queryFn: async () => {
      const result = await api.getProjectSquad(projectId!);
      if (result.squad.project_id !== projectId) throw new Error("Squad observation belongs to another project.");
      return result;
    },
    enabled: !!projectId && !!bootstrap,
    refetchInterval: usePollMs(10000),
  });
  const squad = query.data?.squad;
  return {
    ...query,
    squad,
    instances: squad && bootstrap ? squadInstances(squad, bootstrap.agent_instances) : [],
    agents: bootstrap?.agents.filter((agent) => squad?.agent_ids.includes(agent.id)) ?? [],
  };
}
