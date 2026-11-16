import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useProject } from "./useProject.js";

/** Restore project-only links after checking the current user's authorized inventory. */
export function useProjectLink(): void {
  const [params] = useSearchParams();
  const { bootstrap, projectId, setSelectedProjectId } = useProject();
  // Only a bare project scope belongs here. Every other query is left to its
  // route owner, including current resource links and future query contracts.
  const projectOnly = Array.from(params.keys()).every((key) => key === "project");
  const requested = projectOnly ? params.get("project") : null;
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
