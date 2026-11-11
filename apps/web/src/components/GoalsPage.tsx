import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Flag, Plus, Download, ListChecks, MessageSquare, ArrowRight, Sparkles, ArrowUpRight } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PreparedGoalEntryV1Schema, canProposePlan, canTransitionGoal, type Goal, type GoalAutomation, type TaskSpec } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { useProject } from "../app/useProject.js";
import { useSelection } from "../app/SelectionContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Badge, Button, Input, Modal, Select, StatusBadge, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { RoomConversation } from "./RoomConversation.js";
import { PreparedGoalRequest } from "./PreparedGoalRequest.js";
import { GoalDiscussion } from "./GoalDiscussion.js";
import { CAPABILITY_LABELS, taskUpdatedLabel } from "./taskPresentation.js";
import "../ui/work-insights.css";

const lines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);

export function GoalsPage(): React.ReactNode {
  const api = useApi();
  const { projectId, bootstrap } = useProject();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ objective: "", mode: "manual" });
  const [params] = useSearchParams();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const entryResult = bootstrap.data?.goal_entry === undefined ? undefined : PreparedGoalEntryV1Schema.safeParse(bootstrap.data.goal_entry);
  const entry = entryResult?.success && entryResult.data.project_id === projectId ? entryResult.data : undefined;
  const entryError = entryResult && !entryResult.success ? new Error("This prepared product session has an unsupported configuration.") : null;
  const goals = useQuery({ queryKey: ["goals", projectId], queryFn: () => api.listGoals(projectId!), enabled: !!projectId, refetchInterval: 10000 });
  const goal = goals.data?.goals.find((item) => item.id === (selected ?? params.get("goal")))
    ?? (entry?.goal_id ? goals.data?.goals.find((item) => item.id === entry.goal_id) : goals.data?.goals[0]);
  const matching = goals.data?.goals.filter((item) => `${item.title} ${item.objective}`.toLowerCase().includes(search.trim().toLowerCase()) && (filter === "all" || (filter === "closed" ? ["completed", "cancelled", "archived"].includes(item.status) : !["completed", "cancelled", "archived"].includes(item.status)))) ?? [];
  return <section className="product-page insights-page insights-goals" aria-label="Goals">
    <header className="insights-page__header"><div><span className="insights-eyebrow"><Flag size={15} aria-hidden="true" /> Step 02 · Requirement breakdown</span><h1 className="t-h1">Plan</h1><p>Describe the outcome. Review the approach. Give your agents clear work.</p></div>{!entry && !entryError && <Button iconLeft={Plus} disabled={!projectId} onClick={() => { setDraft({ objective: "", mode: "manual" }); setCreating(true); }}>New goal</Button>}</header>
    <ActionError error={bootstrap.error ?? goals.error ?? entryError} />
    {(bootstrap.isLoading || goals.isLoading) && <p role="status">Loading goals…</p>}
    {entry && bootstrap.data && <PreparedGoalRequest key={`${bootstrap.data.user.id}:${entry.session_id}`} entry={entry}
      organizationId={bootstrap.data.organization.id} userId={bootstrap.data.user.id} onCreated={setSelected} />}
    {!entry && !entryError && <OutcomeComposer key={`composer:${projectId ?? "pending"}`} disabled={!projectId} onContinue={(objective, mode) => { setDraft({ objective, mode }); setCreating(true); }} />}
    {creating && projectId && !entry && !entryError && <GoalForm key={`form:${projectId}`} projectId={projectId} initialObjective={draft.objective} initialMode={draft.mode} onClose={() => setCreating(false)} onCreated={(id) => { setSelected(id); setCreating(false); }} />}
    {goals.data?.goals.length === 0 && !entry && <p className="os-plan-empty">No goals yet. Start with the outcome above; your plans and progress will appear here.</p>}
    {(goals.data?.goals.length ?? 0) > 0 && <div className="insights-goal-layout">
      <nav className="product-list insights-goal-picker" aria-label="Goal list"><div className="insights-picker-tools"><Input label="Search goals" placeholder="Find an outcome…" value={search} onChange={(event) => setSearch(event.target.value)} /><Select label="Goal view" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All goals</option><option value="open">Open goals</option><option value="closed">Closed goals</option></Select></div>{matching.map((item) => <button key={item.id} aria-pressed={item.id === goal?.id} className={item.id === goal?.id ? "is-selected" : ""} onClick={() => setSelected(item.id)}><strong>{item.title}</strong><span className="insights-row-meta"><Badge>{item.status}</Badge><time dateTime={item.updated_at}>{taskUpdatedLabel(item.updated_at)}</time></span></button>)}{goals.data && matching.length === 0 && (search || filter !== "all") && <p className="insights-help">No goals match this view.</p>}</nav>
      {goal && <GoalDetail key={goal.id} goal={goal} />}
    </div>}
  </section>;
}

function OutcomeComposer({ disabled, onContinue }: { disabled: boolean; onContinue: (objective: string, mode: string) => void }): React.ReactNode {
  const [objective, setObjective] = useState("");
  const [mode, setMode] = useState("manual");
  return <section className="os-outcome-composer" aria-label="Plan an outcome"><div><h2>What should the team build?</h2><p>Start with the result you need. You’ll review the execution settings before anything starts.</p></div><form onSubmit={(event) => { event.preventDefault(); if (!disabled && objective.trim()) onContinue(objective.trim(), mode); }}><Textarea label="Outcome to plan" placeholder="Describe the feature, the problem it solves, and what a good result looks like…" value={objective} onChange={(event) => setObjective(event.target.value)} disabled={disabled} required rows={3} /><div className="os-outcome-composer__footer"><Select label="Planning approach" value={mode} onChange={(event) => setMode(event.target.value)} disabled={disabled}><option value="manual">Review each step</option><option value="autonomous">Agent Team · verified workspace</option><option value="publish">Agent Team · build and publish</option></Select><Button type="submit" variant="primary" iconLeft={Sparkles} iconRight={ArrowRight} disabled={disabled || !objective.trim()}>Review setup</Button></div></form></section>;
}

function GoalForm({ projectId, onCreated, onClose, initialObjective = "", initialMode = "manual" }: { projectId: string; onCreated: (id: string) => void; onClose: () => void; initialObjective?: string; initialMode?: string }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const [title, setTitle] = useState(initialObjective.split("\n")[0]?.slice(0, 120) ?? "");
  const [objective, setObjective] = useState(initialObjective);
  const [criteria, setCriteria] = useState("");
  const [minutes, setMinutes] = useState("");
  const [mode, setMode] = useState(initialMode);
  const [sourceHandoff, setSourceHandoff] = useState(false);
  const [requestKey, setRequestKey] = useState(newIdempotencyKey);
  const autonomous = mode !== "manual";
  const mutation = useMutation({ mutationFn: () => autonomous
    ? api.createAutonomousGoal({ project_id: projectId, objective: objective.trim(), verification_profile_id: "default", execution_mode: "agent_team", ...(mode === "publish" ? { release_profile_id: "default" } : {}), max_retries: 3,
      ...(mode === "publish" && sourceHandoff ? { source_handoff: { version: 1 as const, mode: "automatic" as const } } : {}) }, requestKey)
    : api.createGoal({ project_id: projectId, title: title.trim(), objective: objective.trim(), priority: "p2", acceptance_criteria: lines(criteria), budgets: { max_elapsed_ms: minutes ? Number(minutes) * 60000 : null, max_cost_usd: null, max_retries: null, max_concurrent_runs: null, allowed_runtimes: null } }, requestKey),
    onSuccess: async ({ goal }) => { await query.invalidateQueries({ queryKey: ["goals", projectId] }); onCreated(goal.id); } });
  return <Modal open onClose={() => { if (!mutation.isPending) onClose(); }} title="New goal"><form className="insights-goal-form u-stack" aria-label="Create goal" onChange={() => setRequestKey(newIdempotencyKey())} onSubmit={(event) => { event.preventDefault(); if (!mutation.isPending) mutation.mutate(); }}>
    <Select label="Execution mode" value={mode} disabled={mutation.isPending} onChange={(event) => { setMode(event.target.value); setSourceHandoff(false); }}><option value="manual">Review each step</option><option value="autonomous">Agent Team — verified workspace</option><option value="publish">Agent Team — build and publish</option></Select>
    <p className="insights-help">{autonomous ? `Describe what you need. Your team handles research, design, implementation, tests and independent review, with up to three retries and an eight-hour scheduling budget. ${mode === "publish" ? "Publish to your team's configured destination after acceptance checks pass, then check the live product. A configured publishing destination is required." : "Deliver a verified workspace. Choose build and publish to include deployment."}` : "Describe the outcome first. You can build or discuss the plan after creating this goal."}</p>
    {mode === "publish" && <div className="u-stack-sm"><label><input type="checkbox" checked={sourceHandoff} disabled={mutation.isPending}
      onChange={(event) => setSourceHandoff(event.target.checked)} />Allow Artoo to divide work across configured computers</label>
      <p className="insights-help">After research is accepted, Artoo can choose another prepared Windows computer and its agents for the remaining work.</p></div>}
    {!autonomous && <Input label="Goal title" placeholder="What do you want to achieve?" value={title} required maxLength={300} disabled={mutation.isPending} onChange={(event) => setTitle(event.target.value)} />}
    <Textarea label="Objective" placeholder="Describe the result and why it matters." value={objective} required disabled={mutation.isPending} onChange={(event) => setObjective(event.target.value)} />
    {!autonomous && <><Textarea label="Goal acceptance criteria" helperText="One criterion per line" value={criteria} required onChange={(event) => setCriteria(event.target.value)} />
    <details className="insights-disclosure"><summary>Set a time budget</summary><Input label="Time budget (minutes, optional)" type="number" min="1" step="1" value={minutes} disabled={mutation.isPending} onChange={(event) => setMinutes(event.target.value)} /><p className="insights-help">Cost budgets are unavailable until runtimes report reliable usage costs.</p></details></>}
    <ActionError error={mutation.error} />
    <div className="action-row"><Button variant="primary" type="submit" loading={mutation.isPending} disabled={!objective.trim() || (!autonomous && (!title.trim() || !lines(criteria).length))}>{autonomous ? "Start autonomous goal" : "Create goal"}</Button><Button onClick={onClose} disabled={mutation.isPending}>Cancel</Button></div>
  </form></Modal>;
}

function GoalDetail({ goal }: { goal: Goal }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const navigate = useNavigate();
  const { setSelectedTaskId } = useSelection();
  const [proposing, setProposing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const automation = useQuery({ queryKey: ["goal-automation", goal.id], queryFn: () => api.getGoalAutomation(goal.id), refetchInterval: 5000 });
  const autonomous = !!automation.data?.automation;
  const manual = automation.data?.automation === null;
  const plans = useQuery({ queryKey: ["plans", goal.id], queryFn: () => api.listPlans(goal.id), refetchInterval: autonomous ? 5000 : false });
  const checkpoints = useQuery({ queryKey: ["checkpoints", goal.id], queryFn: () => api.listCheckpoints(goal.id), refetchInterval: 10000 });
  const refresh = async (): Promise<void> => { await Promise.all(["goals", "plans", "checkpoints", "tasks", "goal-automation"].map((key) => query.invalidateQueries({ queryKey: [key] }))); };
  const action = useMutation({ mutationFn: (name: "pause" | "resume" | "cancel" | "reconcile") => api.goalAction(goal.id, name, newIdempotencyKey()), onSuccess: async () => { setConfirmCancel(false); await refresh(); }, onError: refresh });
  const planAction = useMutation({ mutationFn: ({ id, name }: { id: string; name: "accept" | "reject" }) => api.planAction(id, name, newIdempotencyKey()), onSuccess: refresh });
  const audit = useMutation({ mutationFn: async () => { const result = await api.goalAuditExport(goal.id); const url = URL.createObjectURL(new Blob([JSON.stringify(result.export, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = `${goal.id}-audit.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } });
  const latestCheckpoint = checkpoints.data?.checkpoints.reduce<(NonNullable<typeof checkpoints.data>["checkpoints"])[number] | undefined>((latest, item) => !latest || item.created_at > latest.created_at ? item : latest, undefined);
  const taskStates = latestCheckpoint?.state_refs.task_statuses ?? [];
  return <article className="insights-goal-detail u-stack">
    <header className="insights-goal-title"><span className="insights-eyebrow">Outcome</span><div className="action-row"><h2>{goal.title}</h2><Badge tone={goal.status === "completed" ? "success" : goal.status === "blocked" ? "warning" : "neutral"}>{goal.status}</Badge></div><p className="insights-prose">{goal.objective}</p></header>
    <ActionError error={automation.error} />
    {automation.data?.automation && <AutonomousProgress goal={goal} automation={automation.data.automation} />}
    <section className="insights-criteria" aria-label="Goal acceptance criteria"><h3><ListChecks size={16} aria-hidden="true" /> Success criteria</h3><ul>{goal.acceptance_criteria.map((item, i) => <li key={i}>{item}</li>)}</ul></section>
    {latestCheckpoint && <div className="insights-goal-progress"><span><strong>{taskStates.filter((task) => task.status === "done").length}/{taskStates.length}</strong> tasks completed at checkpoint</span><span><strong>{latestCheckpoint.state_refs.active_runs.length}</strong> runs active at checkpoint</span><span><strong>{latestCheckpoint.state_refs.open_blockers.length}</strong> blockers at checkpoint</span><small>Last checkpoint · {taskUpdatedLabel(latestCheckpoint.created_at)}</small></div>}
    <div className="action-row insights-goal-actions">
      {(canTransitionGoal(goal.status, "pause") || (autonomous && goal.status === "draft")) && <Button disabled={action.isPending} onClick={() => action.mutate("pause")}>Pause goal</Button>}
      {canTransitionGoal(goal.status, "resume") && <Button disabled={action.isPending} onClick={() => action.mutate("resume")}>Resume goal</Button>}
      {canTransitionGoal(goal.status, "cancel") && <Button variant="danger" disabled={action.isPending} onClick={() => setConfirmCancel(true)}>Cancel goal</Button>}
      <Link className="os-goal-release-link" to={`/release?goal=${encodeURIComponent(goal.id)}`}>Release details<ArrowUpRight size={13} aria-hidden="true" /></Link>
    </div>
    {(canTransitionGoal(goal.status, "pause") || canTransitionGoal(goal.status, "resume")) && <p className="insights-help">Pausing prevents new task scheduling; existing runs can finish. Resume allows new scheduling. Cancelling stops active runs before the goal is marked cancelled.</p>}
    {confirmCancel && <div className="product-card"><p>Cancel this goal and its remaining work?</p><div className="action-row"><Button variant="danger" loading={action.isPending} onClick={() => action.mutate("cancel")}>Confirm cancel goal</Button><Button onClick={() => setConfirmCancel(false)}>Keep goal</Button></div></div>}
    <ActionError error={action.error ?? planAction.error ?? audit.error} />
    <section className="u-stack insights-plans" aria-label="Plans"><div className="insights-section-heading"><h3>Plans</h3><Badge>{plans.data?.plans.length ?? 0}</Badge></div><ActionError error={plans.error} />
      {plans.isLoading && <p role="status">Loading plans…</p>}
      {manual && canProposePlan(goal.status, !!goal.current_plan_id) && <Button onClick={() => setProposing(!proposing)}>{proposing ? "Close plan editor" : "Propose plan"}</Button>}
      {goal.current_plan_id && (goal.status === "paused" || goal.status === "blocked") && <p className="t-subtle">To replace a plan, pause the goal and stop its active runs first. Accepted replacement tasks remain paused until you resume the goal; prior execution evidence is kept.</p>}
      {proposing && <PlanForm goalId={goal.id} onCreated={async () => { setProposing(false); await refresh(); }} />}
      {plans.data?.plans.length === 0 && <p>{autonomous ? "The plan will appear here when agent planning finishes." : "No plan proposed. Add tasks and acceptance criteria, then review the plan before creating its tasks."}</p>}
      {plans.data?.plans.map((plan) => <article key={plan.id} className="insights-plan u-stack-sm"><div className="action-row"><h4>Plan {plan.version}</h4><Badge tone={plan.status === "accepted" ? "success" : plan.status === "proposed" ? "info" : "neutral"}>{plan.status}</Badge><span className="insights-help">{plan.task_specs.length} tasks</span></div><p className="insights-prose">{plan.rationale}</p>
        <ol className="insights-plan-tasks">{plan.task_specs.map((spec, i) => <li key={i}><span className="insights-step-number" aria-hidden="true">{i + 1}</span><div><strong>{spec.title}</strong>{spec.development_stage && <Badge>{stageLabels[spec.development_stage]}</Badge>}{spec.description && <p>{spec.description}</p>}<ul>{spec.acceptance_criteria.map((criterion, j) => <li key={j}>{criterion}</li>)}</ul>{spec.dependencies.length > 0 && <p className="insights-dependency">Depends on: {spec.dependencies.map((dep) => plan.task_specs[Number(dep.ref)]?.title ?? dep.ref).join(", ")}</p>}</div></li>)}</ol>
        {manual && plan.status === "proposed" && <div className="action-row"><Button variant="primary" disabled={planAction.isPending} onClick={() => planAction.mutate({ id: plan.id, name: "accept" })}>Accept plan and create tasks</Button><Button disabled={planAction.isPending} onClick={() => planAction.mutate({ id: plan.id, name: "reject" })}>Reject plan</Button></div>}
      </article>)}
    </section>
    {manual && <GoalDiscussion goal={goal} />}
    <details className="os-goal-history"><summary>Checkpoints & evidence <span>{checkpoints.data?.checkpoints.length ?? 0} checkpoints</span></summary><section className="u-stack-sm insights-checkpoints" aria-label="Checkpoints"><p className="insights-help">Saved progress and decisions throughout this goal.</p><div className="action-row">{goal.current_plan_id && <Button disabled={action.isPending} onClick={() => action.mutate("reconcile")}>Refresh from checkpoint</Button>}<Button variant="ghost" iconLeft={Download} loading={audit.isPending} onClick={() => audit.mutate()}>Export goal evidence</Button></div><ActionError error={checkpoints.error} />{checkpoints.isLoading && <p role="status">Loading checkpoints…</p>}{checkpoints.data?.checkpoints.length === 0 && <p>No checkpoints yet.</p>}{checkpoints.data?.checkpoints.map((checkpoint) => <details className="insights-disclosure" key={checkpoint.id}><summary>{checkpoint.type.replaceAll("_", " ")} · {new Date(checkpoint.created_at).toLocaleString()}</summary><p>{checkpoint.summary}</p><p>{checkpoint.state_refs.active_runs.length} active runs · {checkpoint.state_refs.open_blockers.length} blockers · {checkpoint.state_refs.pending_approvals.length} approvals</p><ul>{checkpoint.state_refs.task_statuses.map((task) => <li key={task.task_id}><Button size="sm" onClick={() => { setSelectedTaskId(task.task_id); navigate("/"); }}>Open task {task.task_id}</Button><StatusBadge status={task.status} /></li>)}</ul></details>)}</section></details>
    {goal.room_id && <section className="insights-goal-conversation" aria-label="Goal conversation"><h3><MessageSquare size={16} aria-hidden="true" /> Goal conversation</h3><RoomConversation key={goal.room_id} roomId={goal.room_id} goalId={goal.id} /></section>}
  </article>;
}

const stageLabels = { research: "Research", design: "Design", implementation: "Implementation", validation: "Testing" };

function AutonomousProgress({ goal, automation }: { goal: Goal; automation: GoalAutomation }): React.ReactNode {
  const api = useApi();
  const { bootstrap } = useProject();
  const release = useQuery({ queryKey: ["goal-release", goal.id], queryFn: () => api.getGoalRelease(goal.id), enabled: !!automation.release_profile_id, refetchInterval: 5000 });
  const publication = release.data?.release;
  const published = publication?.status === "published" && publication.receipt?.outcome === "published";
  const health = publication?.health;
  const unhealthy = health && health.state !== "healthy";
  const endpoint = published && !unhealthy ? publication.receipt?.endpoint : null;
  let link: string | null = null;
  if (endpoint) {
    try { const url = new URL(endpoint); if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) link = url.href; } catch { /* Invalid endpoints stay visible in the evidence export only. */ }
  }
  const name = (instanceId: string): string => {
    const instance = bootstrap.data?.agent_instances.find((item) => item.id === instanceId);
    const agent = bootstrap.data?.agents.find((item) => item.id === instance?.agent_id);
    return agent?.display_name ?? instance?.runtime ?? "Assigned agent";
  };
  return <section className="product-card u-stack-sm" aria-label="Autonomous progress">
    <div className="action-row"><strong>{automation.execution_mode === "agent_team" ? "Agent Team" : "Autonomous development"}</strong><Badge>{goal.status === "paused" ? "paused" : automation.status}</Badge></div>
    {automation.source_handoff?.mode === "automatic" && <p className="insights-help" aria-label="Cross-computer authorization">Cross-computer work is allowed for this goal. Artoo selects a destination after the required checks pass.</p>}
    <p>{automation.app_publication ? "Artoo manages development, independent review and local application publication. Publication history and current availability appear below."
      : published ? unhealthy ? "The product was published; a later health check reported a problem." : "The verified product was published and its endpoint passed the configured health checks." : automation.status === "completed" && !automation.release_profile_id ? "Configured acceptance checks passed. The verified workspace is ready; it has not been automatically published." : "Artoo manages the plan, task execution and acceptance checks. You can pause or cancel at any time."}</p>
    {automation.team && <div aria-label="Team responsibilities"><ul>{automation.team.members.map((member) => <li key={member.stage}><strong>{stageLabels[member.stage]}</strong> · {name(member.agent_instance_id)}</li>)}</ul><p className="insights-help">Each task is reviewed by another team member against the same verified source version.</p></div>}
    {automation.release_profile_id && <details className="os-publication-details"><summary>Publication details <span>{health?.state ?? (published ? "published" : publication?.status ?? "pending")}</span></summary><div aria-label="Product publication"><strong>Publication</strong><p role="status">{health?.state === "rolled_back" ? "Post-publication health checks failed; the previous release was restored and checked."
      : health?.state === "unavailable" ? "The publication was taken offline after failed health checks."
      : health?.state === "degraded" ? "The latest health check failed. The worker is checking recovery."
      : health?.state === "healthy" ? "Published — the latest health check passed."
      : published ? "Published" : publication?.status === "rolled_back" ? "Health checks failed; the previous release was restored." : publication?.status === "failed" ? "Publication failed. See the recorded reason below." : publication?.status === "queued" ? "Publishing and checking the product endpoint…" : "Waiting for implementation, tests and independent review."}</p>
      {publication?.request.acceptance_binding && <p className="insights-help" aria-label="Publication acceptance">{publication.receipt?.acceptance
        ? `The published version satisfied ${publication.receipt.acceptance.settled_criteria.length} publication acceptance ${publication.receipt.acceptance.settled_criteria.length === 1 ? "criterion" : "criteria"} at publication time.`
        : publication.status === "failed" || publication.status === "rolled_back"
          ? "Publication acceptance remains unsatisfied."
          : "Publication acceptance remains pending until the configured endpoint checks pass."}</p>}
      {health && <p className="insights-help">Last measured: <time dateTime={health.checked_at}>{new Date(health.checked_at).toLocaleString()}</time>. This is the latest received observation.</p>}
      {link && <a href={link} target="_blank" rel="noopener noreferrer">Open published product</a>}
      {(health?.reason ?? publication?.receipt?.reason) && <p>{health?.reason ?? publication?.receipt?.reason}</p>}<ActionError error={release.error} /></div></details>}
    {automation.last_error && <p role="status">{automation.last_error}</p>}
    {automation.app_publication && <ApplicationPublicationProgress goalId={goal.id} />}
  </section>;
}

export function ApplicationPublicationProgress({ goalId }: { goalId: string }): React.ReactNode {
  const api = useApi(), query = useQueryClient(), key = ["goal-application-publication", goalId];
  const publicationQuery = useQuery({ queryKey: key, queryFn: () => api.getGoalApplicationPublication(goalId), refetchInterval: 5000 });
  const publication = publicationQuery.data?.publication, receipt = publication?.receipt, report = publication?.latest_observation;
  const published = publication?.status === "published" && receipt?.outcome === "published";
  const stop = useMutation({ mutationFn: () => api.stopGoalApplicationPublication(goalId, newIdempotencyKey()),
    onSuccess: result => { query.setQueryData(key, result); },
    // A hanging status GET must not withhold the stop result or prevent retry.
    onSettled: () => { void query.invalidateQueries({ queryKey: key }); } });
  const [now, setNow] = useState(Date.now);
  const deadline = receipt?.lease?.deadline_at ?? report?.lease.deadline_at;
  const freshness = publication?.request.capabilities.contract.limits.health_freshness_ms ?? 0;
  const samples = [report?.observed_at, report?.health?.checked_at, report?.live?.observed_at, report?.live?.counters_observed_at]
    .filter((value): value is string => !!value).map(Date.parse);
  const freshUntil = Math.min(...samples.map(time => time + freshness), deadline ? Date.parse(deadline) : Infinity);
  // An old successful response cannot keep an availability link alive after its
  // own observation window expires, including while the next GET is failing.
  useEffect(() => {
    setNow(Date.now());
    if (!Number.isFinite(freshUntil)) return;
    const remaining = freshUntil - Date.now(); if (remaining < 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining + 1); return () => clearTimeout(timer);
  }, [freshUntil, publicationQuery.dataUpdatedAt]);
  const reportedState = publication?.current_state ?? "pending";
  const reportsRunning = ["healthy", "live", "draining"].includes(reportedState);
  const stale = reportsRunning && (!report || !samples.length || samples.some(time => !Number.isFinite(time) || time > now)
    || now >= freshUntil || publicationQuery.isError
    // A stop attempt invalidates earlier running evidence even if it is rejected.
    // Only actual newer observations, not a completed GET, can restore the link.
    || stop.submittedAt > 0 && samples.some(time => time <= stop.submittedAt));
  const state = stale || publicationQuery.isError && !publication ? "unknown" : reportedState;
  const closed = !!report?.closure || receipt?.outcome === "failed" && receipt.cleanup.state !== "unconfirmed";
  const stateLabel = closed && receipt?.outcome === "failed" ? "No application is running from this attempt."
    : stop.isPending ? "Stopping — waiting for the application to close."
      : { pending: publication ? "Publishing and checking the application…" : "Waiting for implementation, tests and independent review.",
        healthy: "Running — the latest health check passed.", live: "Running — a fresh health check is unavailable.",
        draining: "Stopping — waiting for the application to close.", "closed-normal": "Stopped.", "closed-aborted": "Stopped after an interruption.",
        expired: "The configured running time has ended.", unknown: "Current availability is unconfirmed." }[state];
  let link: string | undefined;
  const endpoint = publication?.endpoint;
  if (published && state === "healthy" && !stop.isPending && !publicationQuery.isError && endpoint && endpoint === receipt.deployment.origin) {
    try { const url = new URL(endpoint);
      if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.pathname === "/" && !url.search && !url.hash
        && !url.username && !url.password) link = url.href;
    } catch { /* Invalid addresses are never advertised as a usable product. */ }
  }
  return <section className="u-stack-sm" aria-label="Application publication">
    <strong>Application publication</strong>
    <p aria-label="Publication history">{published ? <>Published at <time dateTime={receipt.recorded_at}>{new Date(receipt.recorded_at).toLocaleString()}</time>. Initial health checks and a normal restart passed.</>
      : publication?.status === "failed" ? "Publication failed." : publicationQuery.isError && !publication ? "Publication history is unavailable."
        : publicationQuery.isLoading ? "Loading publication history…" : "No completed application publication has been recorded."}</p>
    {publicationQuery.isLoading ? <p role="status">Loading application availability…</p> : <p role="status" aria-label="Current application availability">{stateLabel}</p>}
    {report && <p className="insights-help">Last received observation: <time dateTime={report.observed_at}>{new Date(report.observed_at).toLocaleString()}</time>.</p>}
    {deadline && <p className="insights-help">Running time limit: <time dateTime={deadline}>{new Date(deadline).toLocaleString()}</time>.</p>}
    <p className="insights-help">This application runs on the publishing computer within its configured time and request limits. Continuous hosting and recovery after failure are unavailable.</p>
    {link && <a href={link} target="_blank" rel="noopener noreferrer">Open local application</a>}
    {publication && !closed && <Button disabled={stop.isPending} loading={stop.isPending} onClick={() => stop.mutate()}>Stop application</Button>}
    {(receipt?.outcome === "failed" ? receipt.reason : report?.reason) && <p>{receipt?.outcome === "failed" ? receipt.reason : report?.reason}</p>}
    <ActionError error={stop.error ?? publicationQuery.error} />
  </section>;
}

const blankTask = (): TaskSpec => ({ title: "", description: "", acceptance_criteria: [], required_capabilities: [], dependencies: [], approval_gates: [], write_scopes: [], expected_artifacts: [] });

function PlanForm({ goalId, onCreated }: { goalId: string; onCreated: () => Promise<void> }): React.ReactNode {
  const api = useApi();
  const [rationale, setRationale] = useState("");
  const [tasks, setTasks] = useState<TaskSpec[]>([blankTask()]);
  const mutation = useMutation({ mutationFn: () => api.proposePlan(goalId, { rationale, task_specs: tasks.map((task) => ({ ...task, title: task.title.trim(), required_capabilities: task.required_capabilities.map((value) => value.trim()).filter(Boolean), acceptance_criteria: task.acceptance_criteria.map((item) => item.trim()).filter(Boolean) })) }, newIdempotencyKey()), onSuccess: onCreated });
  const edit = (index: number, patch: Partial<TaskSpec>): void => setTasks((current) => current.map((task, i) => i === index ? { ...task, ...patch } : task));
  return <form className="insights-plan-editor u-stack" aria-label="Plan editor" onSubmit={(event) => { event.preventDefault(); if (!mutation.isPending) mutation.mutate(); }}>
    <p className="insights-help">Break the outcome into reviewable tasks. Add dependencies when a task needs an earlier result.</p>
    <Textarea label="Plan rationale" placeholder="Explain the approach and why these tasks are needed." value={rationale} required disabled={mutation.isPending} onChange={(event) => setRationale(event.target.value)} />
    {tasks.map((task, index) => <fieldset key={index} className="insights-plan-task-editor u-stack-sm" disabled={mutation.isPending}><legend>Task {index + 1}</legend>
      <Input label={`Task ${index + 1} title`} value={task.title} required onChange={(event) => edit(index, { title: event.target.value })} />
      <Textarea label={`Task ${index + 1} description`} value={task.description} onChange={(event) => edit(index, { description: event.target.value })} />
      <Textarea label={`Task ${index + 1} acceptance criteria`} helperText="One criterion per line" value={task.acceptance_criteria.join("\n")} required onChange={(event) => edit(index, { acceptance_criteria: event.target.value.split("\n") })} />
      <details className="insights-disclosure"><summary>Agent capabilities · {task.required_capabilities.length} selected</summary><fieldset className="insights-capability-picker"><legend>Task {index + 1} capabilities</legend>{Object.entries(CAPABILITY_LABELS).map(([capability, label]) => <label key={capability}><input type="checkbox" checked={task.required_capabilities.includes(capability)} onChange={(event) => edit(index, { required_capabilities: event.target.checked ? [...task.required_capabilities, capability] : task.required_capabilities.filter((item) => item !== capability) })} />{label}</label>)}</fieldset></details>
      {index > 0 && <div className="u-stack-sm"><span>Requires completion of</span>{tasks.slice(0, index).map((previous, previousIndex) => <label key={previousIndex}><input type="checkbox" checked={task.dependencies.some((dep) => dep.ref === String(previousIndex))} onChange={(event) => edit(index, { dependencies: event.target.checked ? [...task.dependencies, { ref: String(previousIndex), type: "blocks" }] : task.dependencies.filter((dep) => dep.ref !== String(previousIndex)) })} />{previous.title || `Task ${previousIndex + 1}`}</label>)}</div>}
      {index === tasks.length - 1 && tasks.length > 1 && <Button size="sm" onClick={() => setTasks(tasks.slice(0, -1))}>Remove last task</Button>}
    </fieldset>)}
    <ActionError error={mutation.error} /><div className="action-row"><Button iconLeft={Plus} disabled={mutation.isPending} onClick={() => setTasks([...tasks, blankTask()])}>Add plan task</Button><Button type="submit" variant="primary" loading={mutation.isPending} disabled={!rationale.trim() || tasks.some((task) => !task.title.trim() || !task.acceptance_criteria.some((item) => item.trim()))}>Submit plan for review</Button></div>
  </form>;
}
