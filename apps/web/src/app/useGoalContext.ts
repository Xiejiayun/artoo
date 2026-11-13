import { useQuery } from "@tanstack/react-query";
import { usePollMs } from "./RealtimeContext.js";
import { useSearchParams } from "react-router-dom";
import { useApi } from "./ApiContext.js";
import { useProject } from "./useProject.js";

/** The URL is the single selection source, including back/forward navigation. */
export function useGoalContext(defaultToFirst = false, enabled = true) {
  const api = useApi();
  const { projectId } = useProject();
  const [params, setParams] = useSearchParams();
  const goals = useQuery({ queryKey: ["goals", projectId], queryFn: () => api.listGoals(projectId!), enabled: !!projectId && enabled, refetchInterval: usePollMs(10000) });
  const requested = params.get("goal");
  const items = goals.data?.goals.filter((goal) => goal.project_id === projectId) ?? [];
  const goal = requested ? items.find((item) => item.id === requested) : defaultToFirst ? items[0] : undefined;
  const selectGoal = (id: string | null): void => {
    setParams((current) => { const next = new URLSearchParams(current); if (id) next.set("goal", id); else next.delete("goal"); return next; });
  };
  return { goals, items, goal, requested, selectGoal };
}
