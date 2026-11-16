import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "./ApiContext.js";
import { queryKeys } from "./queryKeys.js";
import { useProject } from "./useProject.js";
import { useSelection } from "./SelectionContext.js";
import type { TasksResponse } from "../api/types.js";

/** Resolve a shareable task through the authorized API before changing context. */
export function useTaskContext() {
  const api = useApi();
  const cache = useQueryClient();
  const { bootstrap, projectId, setSelectedProjectId } = useProject();
  const { selectedTaskId, setSelectedTaskId } = useSelection();
  const [params, setParams] = useSearchParams();
  const requested = params.get("task");
  const expectedProject = params.get("project");
  const listedTask = cache.getQueryData<TasksResponse>(queryKeys.tasks(expectedProject ?? projectId ?? "pending"))?.tasks.find((item) => item.id === requested);
  const snapshot = useQuery({
    queryKey: queryKeys.task(requested ?? "no-linked-task"),
    queryFn: () => api.getTask(requested!),
    enabled: !!requested && !!bootstrap.data && !listedTask,
    retry: false,
  });
  const task = snapshot.data?.task ?? listedTask;
  const known = !!task && task.id === requested && task.organization_id === bootstrap.data?.organization.id &&
    (!expectedProject || task.project_id === expectedProject) &&
    !!bootstrap.data?.projects.some((project) => project.id === task.project_id);
  const contextError = requested ? snapshot.error ?? (task && !known ? new Error("This task could not be verified in the requested project.") : null) : null;
  const applied = useRef<string | null>(null);
  const identity = JSON.stringify([requested, expectedProject, bootstrap.data?.organization.id, bootstrap.data?.user.id]);
  useEffect(() => {
    if (!requested) { applied.current = null; return; }
    if (!known || !task || applied.current === identity) return;
    applied.current = identity;
    if (task.project_id !== projectId) setSelectedProjectId(task.project_id);
    setSelectedTaskId(task.id);
  }, [requested, identity, known, task, projectId, setSelectedProjectId, setSelectedTaskId]);
  const selectTask = (id: string | null, taskProject = projectId): void => {
    setSelectedTaskId(id);
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("run");
      if (id) { next.set("task", id); if (taskProject) next.set("project", taskProject); }
      else { next.delete("task"); next.delete("project"); }
      return next;
    });
  };
  return {
    requested,
    taskId: requested ? known ? task!.id : null : selectedTaskId,
    contextLoading: !!requested && !contextError && (!known || task?.project_id !== projectId),
    contextError,
    selectTask,
    retryContext: () => { void bootstrap.refetch(); void snapshot.refetch(); },
  };
}
