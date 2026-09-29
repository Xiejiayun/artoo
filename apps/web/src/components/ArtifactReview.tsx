import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Artifact, Task } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { ApiClientError } from "../api/client.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { ActionError } from "./ActionError.js";
import { Button, Textarea } from "../ui/index.js";

export interface ArtifactReviewProps {
  task: Task;
  artifacts: Artifact[];
  versionCursor?: number;
}

/**
 * Artifact list + acceptance controls. Accept / request changes is a task-level
 * review action (review -> done | ready) and is only offered while the task is
 * in `review`. Each review carries a fresh idempotency key.
 */
export function ArtifactReview({ task, artifacts, versionCursor }: ArtifactReviewProps): React.ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const mutation = useMutation({
    mutationFn: (outcome: "accepted" | "changes_requested") =>
      api.reviewTask(task.id, { outcome, ...(comment.trim() ? { comment: comment.trim() } : {}), ...(versionCursor === undefined ? {} : { base_version: versionCursor }) }, newIdempotencyKey()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks(task.project_id) });
    },
    onError: async (error) => {
      if (error instanceof ApiClientError && error.status === 409) await queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) });
    },
  });

  return (
    <section aria-label="Artifacts" className="artifact-review">
      <h3>Artifacts</h3>
      <ActionError error={mutation.error} />
      {mutation.error instanceof ApiClientError && mutation.error.details.reason === "stale_base_version" && <p role="status">This task changed. Review the refreshed details and submit your decision again.</p>}
      {artifacts.length === 0 ? (
        <p className="no-artifacts">No artifacts yet.</p>
      ) : (
        <ul>
          {artifacts.map((artifact) => (
            <li key={artifact.id} className="artifact" data-type={artifact.type}>
              <span className="artifact-type">{artifact.type}</span>
              <ArtifactDownload artifact={artifact} />
            </li>
          ))}
        </ul>
      )}
      {task.status === "review" ? (
        <><Textarea label="Review comment" value={comment} onChange={(event) => setComment(event.target.value)} disabled={mutation.isPending} />
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
        </div></>
      ) : null}
    </section>
  );
}

function ArtifactDownload({ artifact }: { artifact: Artifact }): React.ReactNode {
  const api = useApi();
  const download = useMutation({ mutationFn: async () => {
    const blob = await api.downloadArtifact(artifact.id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = typeof artifact.metadata.filename === "string" ? artifact.metadata.filename : `${artifact.id}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  if (artifact.uri.startsWith("/api/v1/artifacts/")) return <>
    <Button size="sm" loading={download.isPending} onClick={() => download.mutate()}>Download artifact</Button>
    <ActionError error={download.error} />
  </>;
  if (/^https?:\/\//i.test(artifact.uri)) return <a href={artifact.uri} className="artifact-uri" target="_blank" rel="noopener noreferrer">{artifact.uri}</a>;
  return <span className="artifact-uri"><span>{artifact.uri}</span> — Unavailable remotely: this legacy artifact is stored on the execution computer.</span>;
}
