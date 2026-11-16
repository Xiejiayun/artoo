import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useApi } from "./ApiContext.js";
import { queryKeys } from "./queryKeys.js";
import { usePollMs, useSubscription } from "./RealtimeContext.js";

/** Paged observations only; never a second writable task or scheduler store. */
export function useProjectControlView(projectId: string | undefined) {
  const api = useApi();
  useSubscription(projectId ? [`project:${projectId}`] : []);
  const query = useInfiniteQuery({
    queryKey: [...queryKeys.projectControlView(projectId), "pages", 100],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const view = await api.getProjectControlView(projectId!, {
        limit: 100,
        ...(pageParam ? { after: pageParam } : {}),
      });
      if (view.project_id !== projectId || view.tasks.some((entry) => entry.task.project_id !== projectId))
        throw new Error("Project observations returned a different project. Retry this view.");
      return view;
    },
    enabled: !!projectId,
    getNextPageParam: (page) => (page.page.has_more ? (page.page.next_after ?? undefined) : undefined),
    refetchInterval: usePollMs(5000),
    retry: false,
  });
  const entries = useMemo(() => {
    const seen = new Set<string>();
    return (
      query.data?.pages
        .flatMap((page) => page.tasks)
        .filter((entry) => {
          if (seen.has(entry.task.id)) return false;
          seen.add(entry.task.id);
          return true;
        }) ?? []
    );
  }, [query.data]);
  return { ...query, view: query.data?.pages[0], entries };
}
