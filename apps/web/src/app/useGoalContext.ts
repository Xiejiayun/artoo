import { queryKeys } from "./queryKeys.js";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { usePollMs, useSubscription } from "./RealtimeContext.js";
import { useSearchParams } from "react-router-dom";
import { useApi } from "./ApiContext.js";
import { useProject } from "./useProject.js";

/** The URL is the single selection source, including back/forward navigation. */
export function useGoalContext(defaultToFirst = false, enabled = true) {
  const api = useApi();
  const { projectId, bootstrap, setSelectedProjectId } = useProject();
  useSubscription(projectId && enabled ? [`project:${projectId}`] : []);
  const [params, setParams] = useSearchParams();
  const goals = useQuery({
    queryKey: queryKeys.goals(projectId),
    queryFn: () => api.listGoals(projectId!),
    enabled: !!projectId && enabled,
    refetchInterval: usePollMs(10000),
  });
  const requested = params.get("goal");
  const organizationId = bootstrap.data?.organization.id;
  const userId = bootstrap.data?.user.id;
  const items =
    goals.data?.goals.filter((goal) => goal.project_id === projectId && goal.organization_id === organizationId) ?? [];
  const goal = requested ? items.find((item) => item.id === requested) : defaultToFirst ? items[0] : undefined;
  const appliedLink = useRef<string | null>(null);
  const link = JSON.stringify([organizationId, userId, requested]);
  const needsLookup =
    enabled && !!requested && !!bootstrap.data && goals.isSuccess && !goal && appliedLink.current !== link;
  const linkedGoal = useQuery({
    queryKey: queryKeys.linkedGoal(requested, organizationId, userId),
    queryFn: async () => {
      const result = await api.getGoal(requested!);
      if (result.goal.id !== requested || result.goal.organization_id !== organizationId) {
        throw new Error("The requested goal could not be verified for this workspace.");
      }
      return result;
    },
    enabled: needsLookup,
    retry: false,
  });
  const destination = linkedGoal.isSuccess && !linkedGoal.isFetching ? linkedGoal.data.goal : undefined;
  const projectKnown =
    !!destination && !!bootstrap.data?.projects.some((project) => project.id === destination.project_id);
  const contextError = needsLookup
    ? (linkedGoal.error ??
      (destination && !projectKnown
        ? new Error("This goal's project is unavailable. Refresh workspace access and try again.")
        : null))
    : null;
  const contextLoading = needsLookup && !contextError;
  useEffect(() => {
    if (!requested || !enabled) {
      appliedLink.current = null;
      return;
    }
    // Apply each verified link once. An explicit project selection can navigate
    // concurrently; an old URL/response must not pull the picker back afterward.
    if (goal) appliedLink.current = link;
    else if (needsLookup && destination && projectKnown && appliedLink.current !== link) {
      appliedLink.current = link;
      setSelectedProjectId(destination.project_id);
    }
  }, [requested, enabled, goal, link, needsLookup, destination, projectKnown, setSelectedProjectId]);
  const retryContext = (): void => {
    void bootstrap.refetch();
    void linkedGoal.refetch();
  };
  const selectGoal = (id: string | null): void => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (id) next.set("goal", id);
      else next.delete("goal");
      return next;
    });
  };
  return { goals, items, goal, requested, selectGoal, contextLoading, contextError, retryContext };
}
