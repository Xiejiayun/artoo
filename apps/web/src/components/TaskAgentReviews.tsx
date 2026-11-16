import type { Agent, Artifact, Run, Task, TaskAgentReviewViewV1 } from "@artoo/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { usePollMs, useSubscription } from "../app/RealtimeContext.js";
import { useProjectSquad } from "../app/useProjectSquad.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Badge, Button, Select, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

/** A separate Agent supplies opinions on pinned artifact bytes. Only an explicit
 * human action returns the author task for changes; this is not auto-acceptance. */
export function TaskAgentReviews({
  task,
  runs,
  artifacts,
}: {
  task: Task;
  runs: Run[];
  artifacts: Artifact[];
}): React.ReactNode {
  const api = useApi(),
    query = useQueryClient();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const squad = useProjectSquad(task.project_id, bootstrap.data);
  const reviews = useQuery({
    queryKey: queryKeys.taskAgentReviews(task.id),
    queryFn: async () => {
      const result = await api.listTaskAgentReviews(task.id);
      if (result.reviews.some((review) => review.source_task_id !== task.id || review.project_id !== task.project_id))
        throw new Error("Agent feedback is outside this task's project.");
      return result;
    },
    refetchInterval: usePollMs(5000, 1),
  });
  useSubscription([
    `task:${task.id}`,
    ...(reviews.data?.reviews.map((review) => `task:${review.review_task_id}`) ?? []),
  ]);
  const latest = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
  const authorId = bootstrap.data?.agent_instances.find(
    (instance) => instance.id === latest?.agent_instance_id,
  )?.agent_id;
  const sourceArtifacts = artifacts.filter(
    (artifact) =>
      artifact.run_id === latest?.id &&
      artifact.uri.startsWith("/api/v1/artifacts/") &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.checksum ?? ""),
  );
  const reviewers = squad.agents.filter(
    (agent) =>
      agent.id !== authorId &&
      squad.instances.some(
        (instance) =>
          instance.agent_id === agent.id && instance.status !== "disabled" && instance.config.enabled !== false,
      ),
  );
  const refresh = async (): Promise<void> => {
    await Promise.all([
      query.invalidateQueries({ queryKey: queryKeys.taskAgentReviews(task.id) }),
      query.invalidateQueries({ queryKey: queryKeys.task(task.id) }),
      query.invalidateQueries({ queryKey: queryKeys.tasks(task.project_id) }),
      query.invalidateQueries({ queryKey: queryKeys.projectControlView(task.project_id) }),
      query.invalidateQueries({ queryKey: queryKeys.auditBundle(task.id) }),
    ]);
  };
  const reason =
    task.status !== "review"
      ? "Request Agent feedback when the author task is awaiting review."
      : latest?.status !== "completed"
        ? "The latest author execution must complete before requesting feedback."
        : !authorId
          ? "The author Agent identity is unavailable. Refresh the Agent inventory before choosing a different reviewer."
          : sourceArtifacts.length === 0
            ? "Upload a stored artifact from the latest completed execution before requesting feedback."
            : squad.isError
              ? "Project Squad membership could not be verified. Reload it before choosing a reviewer."
              : !squad.squad
                ? "Loading the project's Squad…"
                : reviewers.length === 0
                  ? "Add another Agent with an enabled scoped instance to this project's Squad."
                  : null;
  const names = new Map(bootstrap.data?.agents.map((agent) => [agent.id, agent.display_name]) ?? []);
  return (
    <section className="task-detail__section u-stack task-agent-reviews" aria-label="Agent artifact feedback">
      <div className="insights-section-heading">
        <h3>Agent artifact feedback</h3>
        <Badge>{reviews.data?.reviews.length ?? "—"}</Badge>
      </div>
      <p>
        Ask another Agent to inspect the selected artifact bytes and produce a report. This creates a separate review
        task; it does not start execution or certify the whole workspace. You decide whether to return the author task
        for changes.
      </p>
      <ActionError error={reviews.error ?? bootstrap.error ?? (task.status === "review" ? squad.error : null)} />
      {reviews.isError && (
        <Button size="sm" onClick={() => void reviews.refetch()}>
          Reload Agent feedback
        </Button>
      )}
      {task.status === "review" && squad.isError && (
        <Button size="sm" onClick={() => void squad.refetch()}>
          Reload reviewer Squad
        </Button>
      )}
      {reason ? (
        <p className="insights-help">{reason}</p>
      ) : (
        latest && (
          <FeedbackRequest
            key={latest.id}
            task={task}
            source={latest}
            artifacts={sourceArtifacts.slice(0, 100)}
            reviewers={reviewers}
            onSaved={refresh}
          />
        )
      )}
      {sourceArtifacts.length > 100 && task.status === "review" && (
        <p>Showing the first 100 stored artifacts. A feedback request can include up to 100 artifacts.</p>
      )}
      {reviews.isLoading && <p role="status">Loading Agent feedback…</p>}
      {reviews.data?.reviews.length === 0 && <p>No Agent artifact feedback requested yet.</p>}
      {reviews.data?.reviews.map((review) => (
        <FeedbackRecord
          key={review.id}
          task={task}
          latestRunId={latest?.id}
          review={review}
          reviewerName={names.get(review.reviewer_agent_id) ?? review.reviewer_agent_id}
          onSaved={refresh}
        />
      ))}
    </section>
  );
}

function FeedbackRequest({
  task,
  source,
  artifacts,
  reviewers,
  onSaved,
}: {
  task: Task;
  source: Run;
  artifacts: Artifact[];
  reviewers: Agent[];
  onSaved: () => Promise<void>;
}): React.ReactNode {
  const api = useApi();
  const [reviewerId, setReviewerId] = useState("");
  const [ids, setIds] = useState(artifacts.map((artifact) => artifact.id));
  const submitted = useRef<{ body: string; key: string } | null>(null);
  const selectedIds = ids.filter((id) => artifacts.some((artifact) => artifact.id === id)).sort();
  const reviewerAvailable = reviewers.some((reviewer) => reviewer.id === reviewerId);
  const create = useMutation({
    mutationFn: () => {
      if (!reviewerAvailable || selectedIds.length === 0)
        throw new Error("Choose another scoped Agent and at least one current artifact.");
      const body = {
        version: 1 as const,
        source_run_id: source.id,
        reviewer_agent_id: reviewerId,
        artifact_ids: selectedIds,
      };
      const identity = JSON.stringify(body);
      if (submitted.current?.body !== identity) submitted.current = { body: identity, key: newIdempotencyKey() };
      return api.createTaskAgentReview(task.id, body, submitted.current.key);
    },
    onSuccess: onSaved,
    onError: onSaved,
  });
  return (
    <details className="product-card">
      <summary>Request another Agent's feedback</summary>
      <form
        className="u-stack-sm"
        aria-label="Request Agent artifact feedback"
        onSubmit={(event) => {
          event.preventDefault();
          if (!create.isPending) create.mutate();
        }}
      >
        <p>
          Source execution: <code>{source.id}</code>. The selected Agent must be a different logical Agent from the
          author.
        </p>
        <fieldset className="u-stack-sm" disabled={create.isPending}>
          <Select
            label="Feedback reviewer"
            required
            value={reviewerId}
            onChange={(event) => setReviewerId(event.target.value)}
          >
            <option value="">Choose another Squad Agent</option>
            {reviewerId && !reviewerAvailable && (
              <option value={reviewerId} disabled>
                Previously selected Agent is unavailable
              </option>
            )}
            {reviewers.map((reviewer) => (
              <option key={reviewer.id} value={reviewer.id}>
                {reviewer.display_name}
              </option>
            ))}
          </Select>
          <fieldset className="u-stack-sm">
            <legend>Artifacts to share for feedback</legend>
            {artifacts.map((artifact) => (
              <label key={artifact.id} className="cowork-feedback-artifact">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(artifact.id)}
                  onChange={(event) =>
                    setIds((current) =>
                      event.target.checked ? [...current, artifact.id] : current.filter((id) => id !== artifact.id),
                    )
                  }
                />
                <span>
                  {typeof artifact.metadata.filename === "string" ? artifact.metadata.filename : artifact.id} ·{" "}
                  {artifact.type}
                </span>
                <code>{artifact.checksum}</code>
              </label>
            ))}
          </fieldset>
          <p>
            After creation, open the feedback task and assign it to an instance of the selected reviewer Agent with
            detected code-reading capability. Other computers can receive the pinned artifacts through the existing
            input channel.
          </p>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
            disabled={!reviewerAvailable || selectedIds.length === 0}
          >
            Create Agent feedback task
          </Button>
        </fieldset>
        <ActionError error={create.error} />
        {create.data && (
          <p role="status">
            Feedback task created. Execution has not started automatically.{" "}
            <Link to={taskLink(create.data.review.review_task_id, task.project_id)}>
              Open feedback task and assign it ↗
            </Link>
          </p>
        )}
      </form>
    </details>
  );
}

function FeedbackRecord({
  task,
  latestRunId,
  review,
  reviewerName,
  onSaved,
}: {
  task: Task;
  latestRunId?: string;
  review: TaskAgentReviewViewV1;
  reviewerName: string;
  onSaved: () => Promise<void>;
}): React.ReactNode {
  const api = useApi();
  const [comment, setComment] = useState("");
  const submitted = useRef<{ body: string; key: string } | null>(null);
  const current =
    review.source_task_id === task.id && review.project_id === task.project_id && review.source_run_id === latestRunId;
  const canReturn =
    task.status === "review" &&
    current &&
    !review.stale &&
    !review.applied_at &&
    ["review", "done"].includes(review.review_task_status) &&
    review.review_run_status === "completed" &&
    !!review.review_run_id &&
    !!review.report?.trim();
  const apply = useMutation({
    mutationFn: () => {
      if (!canReturn || !review.review_run_id)
        throw new Error("Only a current completed feedback report can be sent back for changes.");
      const body = {
        version: 1 as const,
        review_run_id: review.review_run_id,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      };
      const identity = JSON.stringify(body);
      if (submitted.current?.body !== identity) submitted.current = { body: identity, key: newIdempotencyKey() };
      return api.requestTaskAgentReviewChanges(task.id, review.id, body, submitted.current.key);
    },
    onSuccess: async () => {
      setComment("");
      await onSaved();
    },
    onError: onSaved,
  });
  return (
    <article className="product-card u-stack-sm" aria-label={`Artifact feedback from ${reviewerName}`}>
      <header className="action-row">
        <strong>{reviewerName}</strong>
        <Badge>{review.review_task_status}</Badge>
        {review.review_run_status && <Badge>Execution: {review.review_run_status}</Badge>}
        {review.applied_at && <Badge>Returned to author</Badge>}
        {(review.stale || !current) && <Badge tone="warning">Stale candidate</Badge>}
      </header>
      <p>
        Source: <Link to={runLink(task.id, review.source_run_id, task.project_id)}>{review.source_run_id}</Link> ·
        Reviewer Agent: <code>{review.reviewer_agent_id}</code>
      </p>
      <details>
        <summary>Pinned source artifacts · {review.artifacts.length}</summary>
        <ul>
          {review.artifacts.map((artifact) => (
            <li key={artifact.id}>
              <code>{artifact.id}</code> · {artifact.type}
              <br />
              <code>{artifact.checksum}</code>
            </li>
          ))}
        </ul>
      </details>
      <div className="action-row">
        <Link to={taskLink(review.review_task_id, task.project_id)}>
          Open feedback task{review.review_run_id ? "" : " and assign it"} ↗
        </Link>
        {review.review_run_id && (
          <Link to={runLink(review.review_task_id, review.review_run_id, task.project_id)}>
            Inspect feedback execution ↗
          </Link>
        )}
      </div>
      {!review.review_run_id && <p>Awaiting assignment. Creating this feedback task does not start an Agent.</p>}
      {review.stale_reason && <p role="status">{review.stale_reason}</p>}
      {review.report ? (
        <pre className="insights-prose" aria-label="Recorded Agent feedback report">
          {review.report}
        </pre>
      ) : (
        <p>No completed feedback report is recorded yet.</p>
      )}
      {review.report_message_id && (
        <p>
          Recorded report message: <code>{review.report_message_id}</code>
        </p>
      )}
      {review.report_artifact_ids.length > 0 && (
        <details>
          <summary>Feedback report artifacts · {review.report_artifact_ids.length}</summary>
          <ul>
            {review.report_artifact_ids.map((id) => (
              <li key={id}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
          <Link to={taskLink(review.review_task_id, task.project_id)}>Inspect and download report artifacts ↗</Link>
        </details>
      )}
      {canReturn && (
        <form
          className="u-stack-sm"
          aria-label="Send Agent feedback to author"
          onSubmit={(event) => {
            event.preventDefault();
            if (!apply.isPending) apply.mutate();
          }}
        >
          <Textarea
            label="Additional return comment"
            value={comment}
            maxLength={12000}
            disabled={apply.isPending}
            onChange={(event) => setComment(event.target.value)}
          />
          <p>
            This action records your request for changes with the Agent report and returns the author task to Ready. It
            does not start a new author execution or accept the result.
          </p>
          <Button type="submit" loading={apply.isPending}>
            Send report back for changes
          </Button>
        </form>
      )}
      <ActionError error={apply.error} />
    </article>
  );
}

const taskLink = (taskId: string, projectId: string): string =>
  `/board?task=${encodeURIComponent(taskId)}&project=${encodeURIComponent(projectId)}`;
const runLink = (taskId: string, runId: string, projectId: string): string =>
  `/runs?task=${encodeURIComponent(taskId)}&run=${encodeURIComponent(runId)}&project=${encodeURIComponent(projectId)}`;
