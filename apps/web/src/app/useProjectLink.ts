import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useProject } from "./useProject.js";

/** Restore project-only links after checking the current user's authorized inventory. */
export function useProjectLink(): void {
  const [params] = useSearchParams();
  const { bootstrap, projectId, setSelectedProjectId } = useProject();
  // Resource links retain their stronger server-verified identity resolution.
  const requested = params.get("task") || params.get("goal") ? null : params.get("project");
  const known = !!bootstrap.data?.projects.some((project) => project.id === requested);
  const identity = JSON.stringify([bootstrap.data?.organization.id, bootstrap.data?.user.id, requested]);
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!requested) {
      applied.current = null;
      return;
    }
    // Apply each validated link once so an explicit project switch can leave it.
    if (!known || applied.current === identity) return;
    applied.current = identity;
    if (requested !== projectId) setSelectedProjectId(requested);
  }, [requested, known, identity, projectId, setSelectedProjectId]);
}
