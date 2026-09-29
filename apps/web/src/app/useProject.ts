import { useQuery } from "@tanstack/react-query";
import { useApi } from "./ApiContext.js";
import { queryKeys } from "./queryKeys.js";
import { useSelection } from "./SelectionContext.js";

export function useProject() {
  const api = useApi();
  const { selectedProjectId, setSelectedProjectId } = useSelection();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const project = bootstrap.data?.projects.find((item) => item.id === selectedProjectId) ?? bootstrap.data?.projects[0];
  return { bootstrap, project, projectId: project?.id, setSelectedProjectId };
}
