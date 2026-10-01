import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Artifact, Task, TaskReview } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { ApiClientError } from "../api/client.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { ActionError } from "./ActionError.js";
import { Button, Textarea } from "../ui/index.js";

export interface ArtifactReviewProps {
  task: Task;
  artifacts: Artifact[];
  reviews?: TaskReview[];
  versionCursor?: number;
}

interface ReviewSubmission {
  taskId: string;
  projectId: string;
  outcome: "accepted" | "changes_requested";
  comment: string;
  versionCursor?: number;
}

/**
 * Artifact list + acceptance controls. Accept / request changes is a task-level
 * review action (review -> done | ready) and is only offered while the task is
 * in `review`. Each review carries a fresh idempotency key.
 */
export function ArtifactReview({ task, artifacts, reviews, versionCursor }: ArtifactReviewProps): React.ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();
  const history = reviews?.filter((review) => review.task_id === task.id).sort((a, b) => a.position - b.position);
  // A stale-version refresh can reveal another review or a new run. Neither
  // submits this user's draft: retain it for this task until their API succeeds.
  const [draft, setDraft] = useState({ taskId: task.id, comment: "" });
  const comment = draft.taskId === task.id ? draft.comment : "";
  const mutation = useMutation({
    mutationFn: (submission: ReviewSubmission) =>
      api.reviewTask(submission.taskId, { outcome: submission.outcome, ...(submission.comment.trim() ? { comment: submission.comment } : {}),
        ...(submission.versionCursor === undefined ? {} : { base_version: submission.versionCursor }) }, newIdempotencyKey()),
    onSuccess: async (_, submission) => {
      setDraft((current) => current.taskId === submission.taskId && current.comment === submission.comment ? { ...current, comment: "" } : current);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.task(submission.taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks(submission.projectId) }),
      ]);
    },
    onError: async (error, submission) => {
      if (error instanceof ApiClientError && error.status === 409) await queryClient.invalidateQueries({ queryKey: queryKeys.task(submission.taskId) });
    },
  });
  const reviewError = mutation.variables?.taskId === task.id ? mutation.error : null;
  const submit = (outcome: ReviewSubmission["outcome"]): void => mutation.mutate({ taskId: task.id, projectId: task.project_id, outcome, comment, versionCursor });

  return (
    <section aria-label="Artifacts" className="artifact-review">
      <h3>Artifacts</h3>
      <ActionError error={reviewError} />
      {reviewError instanceof ApiClientError && reviewError.details.reason === "stale_base_version" && <p role="status">This task changed. Review the refreshed details and submit your decision again.</p>}
      {artifacts.length === 0 ? (
        <p className="no-artifacts">No artifacts yet.</p>
      ) : (
        <ul className="artifact-list">
          {artifacts.map((artifact) => (
            <li key={artifact.id} className="artifact" data-type={artifact.type} data-artifact-id={artifact.id} aria-label={`Artifact ${artifact.id}`}>
              <header className="action-row"><strong className="artifact-filename">{artifactFilename(artifact)}</strong><span className="artifact-type">{artifact.type}</span></header>
              <dl className="artifact-metadata">
                <div><dt>Originating run</dt><dd>{artifact.run_id ? <code>{artifact.run_id}</code> : "Originating run not recorded"}</dd></div>
                <div><dt>Created</dt><dd><RecordedTime value={artifact.created_at} /></dd></div>
                <div><dt>Artifact ID</dt><dd><code>{artifact.id}</code></dd></div>
              </dl>
              <ArtifactDownload artifact={artifact} />
            </li>
          ))}
        </ul>
      )}
      <ReviewHistory reviews={history} artifacts={artifacts} />
      {task.status === "review" ? (
        <><Textarea label="Review comment" value={comment} onChange={(event) => setDraft({ taskId: task.id, comment: event.target.value })} disabled={mutation.isPending} />
        <div className="review-actions">
          <button type="button" disabled={mutation.isPending} onClick={() => submit("accepted")}>
            Accept
          </button>
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() => submit("changes_requested")}
          >
            Request changes
          </button>
        </div></>
      ) : null}
    </section>
  );
}

function artifactFilename(artifact: Artifact): string {
  const filename = artifact.metadata.filename;
  return typeof filename === "string" && filename.trim() ? filename : "Filename unavailable";
}

function RecordedTime({ value }: { value: string }): React.ReactNode {
  const date = new Date(value);
  return <time dateTime={value} title={value}>{Number.isNaN(date.getTime()) ? value || "Time unavailable" : date.toLocaleString()}</time>;
}

function ReviewHistory({ reviews, artifacts }: { reviews: TaskReview[] | undefined; artifacts: Artifact[] }): React.ReactNode {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return <section aria-label="Review history" className="review-history u-stack u-stack-sm">
    <h3>Review history</h3>
    {reviews === undefined ? <p className="t-subtle">Review history is unavailable from this server.</p>
      : reviews.length === 0 ? <p className="t-subtle">No submitted reviews yet.</p>
        : reviews.map((review) => <article key={review.event_id} className="task-review u-stack u-stack-sm" data-review-id={review.event_id} data-outcome={review.outcome}>
          <header className="u-stack u-stack-sm"><strong>{review.outcome === "accepted" ? "Accepted" : "Changes requested"}</strong>
            <span className="t-subtle" data-actor-id={review.actor.id}>{review.actor_name || `${review.actor.type}:${review.actor.id}`} · <RecordedTime value={review.occurred_at} /></span></header>
          <p className="review-comment">{review.comment ?? "No comment provided."}</p>
          {review.artifact_ids === null ? <p className="t-subtle">Artifact attribution was not recorded for this review.</p>
            : review.artifact_ids.length === 0 ? <p className="t-subtle">No task artifacts were recorded at this review.</p>
              : <><p className="t-subtle">Task artifacts at this review</p><ul className="review-artifacts">{review.artifact_ids.map((id) => {
                const artifact = byId.get(id);
                return <li key={id} data-review-artifact-id={id}>
                  <strong>{artifact ? artifactFilename(artifact) : "Artifact details unavailable"}</strong>
                  <code>{id}</code>
                  {artifact && <span>Originating run: {artifact.run_id ? <code>{artifact.run_id}</code> : "not recorded"}</span>}
                </li>;
              })}</ul></>}
        </article>)}
  </section>;
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
