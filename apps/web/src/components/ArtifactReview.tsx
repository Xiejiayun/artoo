import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { Artifact, Task } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";

export interface ArtifactReviewProps {
  task: Task;
  artifacts: Artifact[];
}

/**
 * Artifact list + acceptance controls. Accept / request changes is a task-level
 * review action (review -> done | ready) and is only offered while the task is
 * in `review`. Each review carries a fresh idempotency key.
 */
export function ArtifactReview({ task, artifacts }: ArtifactReviewProps): React.ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (outcome: "accepted" | "changes_requested") =>
      api.reviewTask(task.id, { outcome }, newIdempotencyKey()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) });
    },
  });

  return (
    <section aria-label="Artifacts" className="artifact-review">
      <h3>Artifacts</h3>
      {artifacts.length === 0 ? (
        <p className="no-artifacts">No artifacts yet.</p>
      ) : (
        <ul>
          {artifacts.map((artifact) => (
            <li key={artifact.id} className="artifact" data-type={artifact.type}>
              <span className="artifact-type">{artifact.type}</span>
              <a href={artifact.uri} className="artifact-uri">
                {artifact.uri}
              </a>
            </li>
          ))}
        </ul>
      )}
      {task.status === "review" ? (
        <div className="review-actions">
          <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate("accepted")}>
            Accept
          </button>
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("changes_requested")}
          >
            Request changes
          </button>
        </div>
      ) : null}
    </section>
  );
}
