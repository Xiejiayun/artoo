import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CheckCheck, MessageSquare, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../app/ApiContext.js";
import { useGoalContext } from "../app/useGoalContext.js";
import { useProject } from "../app/useProject.js";
import { useProjectControlView } from "../app/useProjectControlView.js";
import { useTaskContext } from "../app/useTaskContext.js";
import { usePollMs, useSubscription } from "../app/RealtimeContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button, EmptyState, ErrorState, PriorityBadge, SearchInput, Select, StatusBadge } from "../ui/index.js";
import { ArtifactReview } from "./ArtifactReview.js";
import { ControlTaskFacts } from "./ControlTaskFacts.js";
import { TaskDependencies } from "./TaskDependencies.js";
import { TaskRoom } from "./TaskRoom.js";
import { ActionError } from "./ActionError.js";

/** Human decisions use the existing versioned review owner; publication remains separate. */
export function ReviewPage(): React.ReactNode {
  const { bootstrap, project, projectId } = useProject();
  const context = useTaskContext();
  const goals = useGoalContext(false);
  const control = useProjectControlView(projectId);
  const [filter, setFilter] = useState("pending");
  const [search, setSearch] = useState("");
  const entries = control.entries.filter(({ task }) => (!goals.requested || task.goal_id === goals.goal?.id)
    && (filter === "all" || (filter === "pending" ? task.status === "review" : task.status === "done"))
    && `${task.title} ${task.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="cowork-page cowork-review-page" aria-label="Human review workbench">
    <header className="cowork-page-heading"><div><span className="os-eyebrow"><ShieldCheck size={14} aria-hidden="true" />Human acceptance · {project?.name ?? "Project"}</span><h1>Review</h1><p>Inspect recorded work, request another attempt, and accept the result with a durable decision.</p></div><Link className="os-secondary-link" to={goals.goal ? `/release?goal=${encodeURIComponent(goals.goal.id)}` : "/release"}>Release evidence <ArrowUpRight size={14} aria-hidden="true" /></Link></header>
    <div className="cowork-review-note"><CheckCheck size={16} aria-hidden="true" /><p>Your decision records human acceptance. Independent Agent review and product publication retain their own execution evidence and authorization.</p><span>Awaiting review · project total <strong>{control.isError ? "Unknown" : control.view?.summary.tasks_by_status.review ?? "—"}</strong></span></div>
    {goals.requested && <div className="action-row"><p>Goal: {goals.goal?.title ?? "Resolving shared goal…"}</p><Button size="sm" onClick={() => goals.selectGoal(null)}>Show all project goals</Button></div>}
    <ActionError error={goals.contextError} />
    {!projectId ? bootstrap.isLoading ? <p role="status">Loading review workspace…</p> : <EmptyState title="Choose a project to review" description="Create or select a project before reviewing team output." action={<Link to="/settings">Project settings</Link>} /> : <>
      {control.isError && <ErrorState title="Review observations unavailable" description={control.error.message} action={<Button onClick={() => void control.refetch()}>Reload review queue</Button>} />}
      <div className="cowork-review-layout"><aside className="cowork-surface cowork-review-queue" aria-label="Review task queue"><div className="cowork-review-filters"><SearchInput aria-label="Search review tasks" placeholder="Search task or ID…" value={search} onClear={() => setSearch("")} onChange={(event) => setSearch(event.target.value)} /><Select label="Review queue" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="pending">Awaiting human review</option><option value="done">Completed tasks</option><option value="all">All tasks & review history</option></Select></div><p className="cowork-snapshot-note">{control.entries.length} loaded project tasks{control.hasNextPage ? " · more available" : ""}. Filters apply to loaded observations.</p>
        {control.isLoading ? <p className="cowork-panel-empty" role="status">Loading review tasks…</p> : entries.length === 0 ? <p className="cowork-panel-empty">{control.isError ? "Review observations are unavailable." : "No matching tasks in loaded observations."}</p> : <ul>{entries.map((entry) => <li key={entry.task.id}><button type="button" className={`cowork-review-task${context.taskId === entry.task.id ? " is-active" : ""}`} aria-pressed={context.taskId === entry.task.id} onClick={() => context.selectTask(entry.task.id, projectId)}><span><PriorityBadge priority={entry.task.priority} /><StatusBadge status={entry.task.status} /></span><strong>{entry.task.title}</strong><ControlTaskFacts entry={entry} bootstrap={bootstrap.data} /></button></li>)}</ul>}
        {control.hasNextPage && <Button loading={control.isFetchingNextPage} onClick={() => void control.fetchNextPage()}>Load more review observations</Button>}
      </aside><section className="cowork-surface cowork-review-detail" aria-label="Selected review evidence">{(context.contextError ?? goals.contextError) ? <ErrorState title="Linked review task unavailable" description={(context.contextError ?? goals.contextError)!.message} action={<Button onClick={context.retryContext}>Retry linked task</Button>} /> : context.contextLoading || goals.contextLoading ? <p role="status">Resolving shared review context…</p> : context.taskId ? <ReviewDetail key={context.taskId} taskId={context.taskId} projectId={projectId} organizationId={bootstrap.data?.organization.id} goalId={goals.requested ? goals.goal?.id : undefined} /> : <EmptyState title="Choose work to review" description="Open a task to inspect its acceptance criteria, recorded artifacts and review history." />}</section></div>
    </>}
  </section>;
}

function ReviewDetail({ taskId, projectId, organizationId, goalId }: { taskId: string; projectId: string; organizationId?: string; goalId?: string }): React.ReactNode {
  const api = useApi();
  const [conversation, setConversation] = useState(false);
  useSubscription([`task:${taskId}`]);
  const snapshot = useQuery({ queryKey: queryKeys.task(taskId), queryFn: () => api.getTask(taskId), refetchInterval: usePollMs(5000) });
  if (!snapshot.data) return <><ActionError error={snapshot.error} /><Button loading={snapshot.isFetching} onClick={() => void snapshot.refetch()}>Load review evidence</Button></>;
  const { task, artifacts, runs, reviews, version_cursor: cursor } = snapshot.data;
  if (task.project_id !== projectId || task.organization_id !== organizationId || (goalId && task.goal_id !== goalId)) return <EmptyState title="This task is outside the current project" description="Choose a task in this project's review queue." />;
  const latest = runs.reduce<(typeof runs)[number] | undefined>((current, run) => !current || run.created_at > current.created_at ? run : current, undefined);
  return <div className="u-stack"><header className="cowork-review-task-heading"><div className="action-row"><PriorityBadge priority={task.priority} /><StatusBadge status={task.status} /><code>{task.id}</code></div><h2>{task.title}</h2><p>{task.description}</p><div className="action-row"><Link to={`/?task=${encodeURIComponent(task.id)}&project=${encodeURIComponent(projectId)}`}>Open full task workspace ↗</Link>{latest && <Link to={`/runs?task=${encodeURIComponent(task.id)}&run=${encodeURIComponent(latest.id)}&project=${encodeURIComponent(projectId)}`}>Latest execution evidence ↗</Link>}</div></header><ActionError error={snapshot.error} />{task.acceptance_criteria.length > 0 && <section aria-label="Review acceptance criteria"><h3>Acceptance criteria</h3><ul>{task.acceptance_criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></section>}{task.status !== "review" && <p className="cowork-review-state">This task is currently {task.status.replaceAll("_", " ")}. Review history and artifacts remain available; a new decision requires the review state.</p>}<ArtifactReview task={task} artifacts={artifacts} reviews={reviews} versionCursor={cursor} /><TaskDependencies task={task} /><div className="action-row"><Button iconLeft={MessageSquare} aria-expanded={conversation} onClick={() => setConversation((value) => !value)}>{conversation ? "Hide team conversation" : "Discuss feedback & handoff"}</Button></div>{conversation && <TaskRoom taskId={task.id} />}</div>;
}
