import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Flag, Plus, Download, ListChecks, MessageSquare } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { canProposePlan, canTransitionGoal, type Goal, type TaskSpec } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { useProject } from "../app/useProject.js";
import { useSelection } from "../app/SelectionContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Badge, Button, EmptyState, Input, Modal, Select, StatusBadge, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { RoomConversation } from "./RoomConversation.js";
import { GoalDiscussion } from "./GoalDiscussion.js";
import { CAPABILITY_LABELS, taskUpdatedLabel } from "./taskPresentation.js";
import "../ui/work-insights.css";

const lines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);

export function GoalsPage(): React.ReactNode {
  const api = useApi();
  const { projectId, bootstrap } = useProject();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const goals = useQuery({ queryKey: ["goals", projectId], queryFn: () => api.listGoals(projectId!), enabled: !!projectId, refetchInterval: 10000 });
  const goal = goals.data?.goals.find((item) => item.id === selected) ?? goals.data?.goals[0];
  const matching = goals.data?.goals.filter((item) => `${item.title} ${item.objective}`.toLowerCase().includes(search.trim().toLowerCase()) && (filter === "all" || (filter === "closed" ? ["completed", "cancelled", "archived"].includes(item.status) : !["completed", "cancelled", "archived"].includes(item.status)))) ?? [];
  return <section className="product-page insights-page insights-goals" aria-label="Goals">
    <header className="insights-page__header"><div><span className="insights-eyebrow"><Flag size={15} aria-hidden="true" /> Plan together</span><h1 className="t-h1">Goals</h1><p>Turn an outcome into a reviewed plan and track its progress.</p></div><Button variant="primary" iconLeft={Plus} disabled={!projectId} onClick={() => setCreating(true)}>New goal</Button></header>
    <ActionError error={bootstrap.error ?? goals.error} />
    {(bootstrap.isLoading || goals.isLoading) && <p role="status">Loading goals…</p>}
    {creating && projectId && <GoalForm key={projectId} projectId={projectId} onClose={() => setCreating(false)} onCreated={(id) => { setSelected(id); setCreating(false); }} />}
    {goals.data?.goals.length === 0 && <EmptyState title="No goals yet" description="Define an outcome, review a plan, and track its tasks and checkpoints." />}
    <div className="insights-goal-layout">
      <nav className="product-list insights-goal-picker" aria-label="Goal list"><div className="insights-picker-tools"><Input label="Search goals" placeholder="Find an outcome…" value={search} onChange={(event) => setSearch(event.target.value)} /><Select label="Goal view" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All goals</option><option value="open">Open goals</option><option value="closed">Closed goals</option></Select></div>{matching.map((item) => <button key={item.id} aria-pressed={item.id === goal?.id} className={item.id === goal?.id ? "is-selected" : ""} onClick={() => setSelected(item.id)}><strong>{item.title}</strong><span className="insights-row-meta"><Badge>{item.status}</Badge><time dateTime={item.updated_at}>{taskUpdatedLabel(item.updated_at)}</time></span></button>)}{goals.data && matching.length === 0 && (search || filter !== "all") && <p className="insights-help">No goals match this view.</p>}</nav>
      {goal && <GoalDetail key={goal.id} goal={goal} />}
    </div>
  </section>;
}

function GoalForm({ projectId, onCreated, onClose }: { projectId: string; onCreated: (id: string) => void; onClose: () => void }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [minutes, setMinutes] = useState("");
  const mutation = useMutation({ mutationFn: () => api.createGoal({ project_id: projectId, title: title.trim(), objective: objective.trim(), priority: "p2", acceptance_criteria: lines(criteria), budgets: { max_elapsed_ms: minutes ? Number(minutes) * 60000 : null, max_cost_usd: null, max_retries: null, max_concurrent_runs: null, allowed_runtimes: null } }, newIdempotencyKey()), onSuccess: async ({ goal }) => { await query.invalidateQueries({ queryKey: ["goals", projectId] }); onCreated(goal.id); } });
  return <Modal open onClose={() => { if (!mutation.isPending) onClose(); }} title="New goal"><form className="insights-goal-form u-stack" aria-label="Create goal" onSubmit={(event) => { event.preventDefault(); if (!mutation.isPending) mutation.mutate(); }}>
    <p className="insights-help">Describe the outcome first. You can build or discuss the plan after creating this goal.</p>
    <Input label="Goal title" placeholder="What do you want to achieve?" value={title} required maxLength={300} disabled={mutation.isPending} onChange={(event) => setTitle(event.target.value)} />
    <Textarea label="Objective" placeholder="Describe the result and why it matters." value={objective} required disabled={mutation.isPending} onChange={(event) => setObjective(event.target.value)} />
    <Textarea label="Goal acceptance criteria" helperText="One criterion per line" value={criteria} required onChange={(event) => setCriteria(event.target.value)} />
    <details className="insights-disclosure"><summary>Set a time budget</summary><Input label="Time budget (minutes, optional)" type="number" min="1" step="1" value={minutes} disabled={mutation.isPending} onChange={(event) => setMinutes(event.target.value)} /><p className="insights-help">Cost budgets are unavailable until runtimes report reliable usage costs.</p></details>
    <ActionError error={mutation.error} />
    <div className="action-row"><Button variant="primary" type="submit" loading={mutation.isPending} disabled={!title.trim() || !objective.trim() || !lines(criteria).length}>Create goal</Button><Button onClick={onClose} disabled={mutation.isPending}>Cancel</Button></div>
  </form></Modal>;
}

function GoalDetail({ goal }: { goal: Goal }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const navigate = useNavigate();
  const { setSelectedTaskId } = useSelection();
  const [proposing, setProposing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const plans = useQuery({ queryKey: ["plans", goal.id], queryFn: () => api.listPlans(goal.id) });
  const checkpoints = useQuery({ queryKey: ["checkpoints", goal.id], queryFn: () => api.listCheckpoints(goal.id), refetchInterval: 10000 });
  const refresh = async (): Promise<void> => { await Promise.all(["goals", "plans", "checkpoints", "tasks"].map((key) => query.invalidateQueries({ queryKey: [key] }))); };
  const action = useMutation({ mutationFn: (name: "pause" | "resume" | "cancel" | "reconcile") => api.goalAction(goal.id, name, newIdempotencyKey()), onSuccess: async () => { setConfirmCancel(false); await refresh(); }, onError: refresh });
  const planAction = useMutation({ mutationFn: ({ id, name }: { id: string; name: "accept" | "reject" }) => api.planAction(id, name, newIdempotencyKey()), onSuccess: refresh });
  const audit = useMutation({ mutationFn: async () => { const result = await api.goalAuditExport(goal.id); const url = URL.createObjectURL(new Blob([JSON.stringify(result.export, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = `${goal.id}-audit.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } });
  const latestCheckpoint = checkpoints.data?.checkpoints.reduce<(NonNullable<typeof checkpoints.data>["checkpoints"])[number] | undefined>((latest, item) => !latest || item.created_at > latest.created_at ? item : latest, undefined);
  const taskStates = latestCheckpoint?.state_refs.task_statuses ?? [];
  return <article className="insights-goal-detail u-stack">
    <header className="insights-goal-title"><span className="insights-eyebrow">Outcome</span><div className="action-row"><h2>{goal.title}</h2><Badge tone={goal.status === "completed" ? "success" : goal.status === "blocked" ? "warning" : "neutral"}>{goal.status}</Badge></div><p className="insights-prose">{goal.objective}</p></header>
    <section className="insights-criteria" aria-label="Goal acceptance criteria"><h3><ListChecks size={16} aria-hidden="true" /> Success criteria</h3><ul>{goal.acceptance_criteria.map((item, i) => <li key={i}>{item}</li>)}</ul></section>
    {latestCheckpoint && <div className="insights-goal-progress"><span><strong>{taskStates.filter((task) => task.status === "done").length}/{taskStates.length}</strong> tasks completed</span><span><strong>{latestCheckpoint.state_refs.active_runs.length}</strong> active runs</span><span><strong>{latestCheckpoint.state_refs.open_blockers.length}</strong> blockers</span><small>Last checkpoint · {taskUpdatedLabel(latestCheckpoint.created_at)}</small></div>}
    <div className="action-row insights-goal-actions">
      {canTransitionGoal(goal.status, "pause") && <Button disabled={action.isPending} onClick={() => action.mutate("pause")}>Pause goal</Button>}
      {canTransitionGoal(goal.status, "resume") && <Button disabled={action.isPending} onClick={() => action.mutate("resume")}>Resume goal</Button>}
      {canTransitionGoal(goal.status, "cancel") && <Button variant="danger" disabled={action.isPending} onClick={() => setConfirmCancel(true)}>Cancel goal</Button>}
      {goal.current_plan_id && <Button disabled={action.isPending} onClick={() => action.mutate("reconcile")}>Refresh from checkpoint</Button>}
      <Button variant="ghost" iconLeft={Download} loading={audit.isPending} onClick={() => audit.mutate()}>Export goal evidence</Button>
    </div>
    {(canTransitionGoal(goal.status, "pause") || canTransitionGoal(goal.status, "resume")) && <p className="insights-help">Pausing prevents new task scheduling; existing runs can finish. Resume allows new scheduling. Cancelling stops active runs before the goal is marked cancelled.</p>}
    {confirmCancel && <div className="product-card"><p>Cancel this goal and its remaining work?</p><div className="action-row"><Button variant="danger" loading={action.isPending} onClick={() => action.mutate("cancel")}>Confirm cancel goal</Button><Button onClick={() => setConfirmCancel(false)}>Keep goal</Button></div></div>}
    <ActionError error={action.error ?? planAction.error ?? audit.error} />
    <section className="u-stack insights-plans" aria-label="Plans"><div className="insights-section-heading"><h3>Plans</h3><Badge>{plans.data?.plans.length ?? 0}</Badge></div><ActionError error={plans.error} />
      {plans.isLoading && <p role="status">Loading plans…</p>}
      {canProposePlan(goal.status, !!goal.current_plan_id) && <Button onClick={() => setProposing(!proposing)}>{proposing ? "Close plan editor" : "Propose plan"}</Button>}
      {goal.current_plan_id && (goal.status === "paused" || goal.status === "blocked") && <p className="t-subtle">To replace a plan, pause the goal and stop its active runs first. Accepted replacement tasks remain paused until you resume the goal; prior execution evidence is kept.</p>}
      {proposing && <PlanForm goalId={goal.id} onCreated={async () => { setProposing(false); await refresh(); }} />}
      {plans.data?.plans.length === 0 && <p>No plan proposed. Add tasks and acceptance criteria, then review the plan before creating its tasks.</p>}
      {plans.data?.plans.map((plan) => <article key={plan.id} className="insights-plan u-stack-sm"><div className="action-row"><h4>Plan {plan.version}</h4><Badge tone={plan.status === "accepted" ? "success" : plan.status === "proposed" ? "info" : "neutral"}>{plan.status}</Badge><span className="insights-help">{plan.task_specs.length} tasks</span></div><p className="insights-prose">{plan.rationale}</p>
        <ol className="insights-plan-tasks">{plan.task_specs.map((spec, i) => <li key={i}><span className="insights-step-number" aria-hidden="true">{i + 1}</span><div><strong>{spec.title}</strong>{spec.description && <p>{spec.description}</p>}<ul>{spec.acceptance_criteria.map((criterion, j) => <li key={j}>{criterion}</li>)}</ul>{spec.dependencies.length > 0 && <p className="insights-dependency">Depends on: {spec.dependencies.map((dep) => plan.task_specs[Number(dep.ref)]?.title ?? dep.ref).join(", ")}</p>}</div></li>)}</ol>
        {plan.status === "proposed" && <div className="action-row"><Button variant="primary" disabled={planAction.isPending} onClick={() => planAction.mutate({ id: plan.id, name: "accept" })}>Accept plan and create tasks</Button><Button disabled={planAction.isPending} onClick={() => planAction.mutate({ id: plan.id, name: "reject" })}>Reject plan</Button></div>}
      </article>)}
    </section>
    <GoalDiscussion goal={goal} />
    <section className="u-stack-sm insights-checkpoints" aria-label="Checkpoints"><h3>Checkpoints</h3><p className="insights-help">Saved progress and decisions throughout this goal.</p><ActionError error={checkpoints.error} />{checkpoints.isLoading && <p role="status">Loading checkpoints…</p>}{checkpoints.data?.checkpoints.length === 0 && <p>No checkpoints yet.</p>}{checkpoints.data?.checkpoints.map((checkpoint) => <details className="insights-disclosure" key={checkpoint.id}><summary>{checkpoint.type.replaceAll("_", " ")} · {new Date(checkpoint.created_at).toLocaleString()}</summary><p>{checkpoint.summary}</p><p>{checkpoint.state_refs.active_runs.length} active runs · {checkpoint.state_refs.open_blockers.length} blockers · {checkpoint.state_refs.pending_approvals.length} approvals</p><ul>{checkpoint.state_refs.task_statuses.map((task) => <li key={task.task_id}><Button size="sm" onClick={() => { setSelectedTaskId(task.task_id); navigate("/"); }}>Open task {task.task_id}</Button><StatusBadge status={task.status} /></li>)}</ul></details>)}</section>
    {goal.room_id && <section className="insights-goal-conversation" aria-label="Goal conversation"><h3><MessageSquare size={16} aria-hidden="true" /> Goal conversation</h3><RoomConversation key={goal.room_id} roomId={goal.room_id} goalId={goal.id} /></section>}
  </article>;
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
