import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { canProposePlan, canTransitionGoal, type Goal, type TaskSpec } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { useProject } from "../app/useProject.js";
import { useSelection } from "../app/SelectionContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Badge, Button, EmptyState, Input, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { RoomConversation } from "./RoomConversation.js";
import { GoalDiscussion } from "./GoalDiscussion.js";

const lines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);

export function GoalsPage(): React.ReactNode {
  const api = useApi();
  const { projectId, bootstrap } = useProject();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const goals = useQuery({ queryKey: ["goals", projectId], queryFn: () => api.listGoals(projectId!), enabled: !!projectId, refetchInterval: 10000 });
  const goal = goals.data?.goals.find((item) => item.id === selected) ?? goals.data?.goals[0];
  return <section className="product-page" aria-label="Goals">
    <header className="action-row"><h1 className="t-h1">Goals</h1><Button variant="primary" disabled={!projectId} onClick={() => setCreating(true)}>New goal</Button></header>
    <ActionError error={bootstrap.error ?? goals.error} />
    {(bootstrap.isLoading || goals.isLoading) && <p role="status">Loading goals…</p>}
    {creating && projectId && <GoalForm key={projectId} projectId={projectId} onClose={() => setCreating(false)} onCreated={(id) => { setSelected(id); setCreating(false); }} />}
    {goals.data?.goals.length === 0 && <EmptyState title="No goals yet" description="Define an outcome, review a plan, and track its tasks and checkpoints." />}
    <div className="product-split">
      <nav className="product-list" aria-label="Goal list">{goals.data?.goals.map((item) => <button key={item.id} className={item.id === goal?.id ? "is-selected" : ""} onClick={() => setSelected(item.id)}><strong>{item.title}</strong><Badge>{item.status}</Badge></button>)}</nav>
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
  return <form className="product-card u-stack" aria-label="Create goal" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
    <Input label="Goal title" value={title} required maxLength={300} onChange={(event) => setTitle(event.target.value)} />
    <Textarea label="Objective" value={objective} required onChange={(event) => setObjective(event.target.value)} />
    <Textarea label="Goal acceptance criteria" helperText="One criterion per line" value={criteria} required onChange={(event) => setCriteria(event.target.value)} />
    <Input label="Time budget (minutes, optional)" type="number" min="1" step="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} />
    <p className="t-subtle">Cost budgets are unavailable until runtimes report reliable usage costs.</p>
    <ActionError error={mutation.error} />
    <div className="action-row"><Button variant="primary" type="submit" loading={mutation.isPending} disabled={!title.trim() || !objective.trim() || !lines(criteria).length}>Create goal</Button><Button onClick={onClose} disabled={mutation.isPending}>Cancel</Button></div>
  </form>;
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
  return <article className="u-stack">
    <header className="action-row"><h2>{goal.title}</h2><Badge>{goal.status}</Badge></header><p>{goal.objective}</p>
    <ul>{goal.acceptance_criteria.map((item, i) => <li key={i}>{item}</li>)}</ul>
    <p className="t-subtle">Pausing prevents new task scheduling; existing runs can finish. Resume allows new scheduling. Cancelling stops active runs before the goal is marked cancelled.</p>
    <div className="action-row">
      {canTransitionGoal(goal.status, "pause") && <Button disabled={action.isPending} onClick={() => action.mutate("pause")}>Pause goal</Button>}
      {canTransitionGoal(goal.status, "resume") && <Button disabled={action.isPending} onClick={() => action.mutate("resume")}>Resume goal</Button>}
      {canTransitionGoal(goal.status, "cancel") && <Button variant="danger" disabled={action.isPending} onClick={() => setConfirmCancel(true)}>Cancel goal</Button>}
      {goal.current_plan_id && <Button disabled={action.isPending} onClick={() => action.mutate("reconcile")}>Refresh from checkpoint</Button>}
      <Button loading={audit.isPending} onClick={() => audit.mutate()}>Export goal evidence</Button>
    </div>
    {confirmCancel && <div className="product-card"><p>Cancel this goal and its remaining work?</p><div className="action-row"><Button variant="danger" loading={action.isPending} onClick={() => action.mutate("cancel")}>Confirm cancel goal</Button><Button onClick={() => setConfirmCancel(false)}>Keep goal</Button></div></div>}
    <ActionError error={action.error ?? planAction.error ?? audit.error} />
    <GoalDiscussion goal={goal} />
    <section className="u-stack" aria-label="Plans"><h3>Plans</h3><ActionError error={plans.error} />
      {plans.isLoading && <p role="status">Loading plans…</p>}
      {canProposePlan(goal.status, !!goal.current_plan_id) && <Button onClick={() => setProposing(!proposing)}>{proposing ? "Close plan editor" : "Propose plan"}</Button>}
      {goal.current_plan_id && (goal.status === "paused" || goal.status === "blocked") && <p className="t-subtle">To replace a plan, pause the goal and stop its active runs first. Accepted replacement tasks remain paused until you resume the goal; prior execution evidence is kept.</p>}
      {proposing && <PlanForm goalId={goal.id} onCreated={async () => { setProposing(false); await refresh(); }} />}
      {plans.data?.plans.length === 0 && <p>No plan proposed. Add tasks and acceptance criteria, then review the plan before creating its tasks.</p>}
      {plans.data?.plans.map((plan) => <article key={plan.id} className="product-card u-stack-sm"><div className="action-row"><h4>Plan {plan.version}</h4><Badge>{plan.status}</Badge></div><p>{plan.rationale}</p>
        <ol>{plan.task_specs.map((spec, i) => <li key={i}><strong>{spec.title}</strong><p>{spec.description}</p><ul>{spec.acceptance_criteria.map((criterion, j) => <li key={j}>{criterion}</li>)}</ul>{spec.dependencies.length > 0 && <p className="t-subtle">Depends on: {spec.dependencies.map((dep) => plan.task_specs[Number(dep.ref)]?.title ?? dep.ref).join(", ")}</p>}</li>)}</ol>
        {plan.status === "proposed" && <div className="action-row"><Button variant="primary" disabled={planAction.isPending} onClick={() => planAction.mutate({ id: plan.id, name: "accept" })}>Accept plan and create tasks</Button><Button disabled={planAction.isPending} onClick={() => planAction.mutate({ id: plan.id, name: "reject" })}>Reject plan</Button></div>}
      </article>)}
    </section>
    <section className="u-stack-sm" aria-label="Checkpoints"><h3>Checkpoints</h3><ActionError error={checkpoints.error} />{checkpoints.isLoading && <p role="status">Loading checkpoints…</p>}{checkpoints.data?.checkpoints.length === 0 && <p>No checkpoints yet.</p>}{checkpoints.data?.checkpoints.map((checkpoint) => <details className="product-card" key={checkpoint.id}><summary>{checkpoint.type.replaceAll("_", " ")} · {new Date(checkpoint.created_at).toLocaleString()}</summary><p>{checkpoint.summary}</p><p>{checkpoint.state_refs.active_runs.length} active runs · {checkpoint.state_refs.open_blockers.length} blockers · {checkpoint.state_refs.pending_approvals.length} approvals</p><ul>{checkpoint.state_refs.task_statuses.map((task) => <li key={task.task_id}><Button size="sm" onClick={() => { setSelectedTaskId(task.task_id); navigate("/"); }}>Open task {task.task_id}</Button> {task.status}</li>)}</ul></details>)}</section>
    {goal.room_id && <RoomConversation key={goal.room_id} roomId={goal.room_id} goalId={goal.id} />}
  </article>;
}

const blankTask = (): TaskSpec => ({ title: "", description: "", acceptance_criteria: [], required_capabilities: [], dependencies: [], approval_gates: [], write_scopes: [], expected_artifacts: [] });

function PlanForm({ goalId, onCreated }: { goalId: string; onCreated: () => Promise<void> }): React.ReactNode {
  const api = useApi();
  const [rationale, setRationale] = useState("");
  const [tasks, setTasks] = useState<TaskSpec[]>([blankTask()]);
  const mutation = useMutation({ mutationFn: () => api.proposePlan(goalId, { rationale, task_specs: tasks.map((task) => ({ ...task, title: task.title.trim(), required_capabilities: task.required_capabilities.map((value) => value.trim()).filter(Boolean), acceptance_criteria: task.acceptance_criteria.map((item) => item.trim()).filter(Boolean) })) }, newIdempotencyKey()), onSuccess: onCreated });
  const edit = (index: number, patch: Partial<TaskSpec>): void => setTasks((current) => current.map((task, i) => i === index ? { ...task, ...patch } : task));
  return <form className="product-card u-stack" aria-label="Plan editor" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
    <Textarea label="Plan rationale" value={rationale} required onChange={(event) => setRationale(event.target.value)} />
    {tasks.map((task, index) => <fieldset key={index} className="product-card u-stack-sm"><legend>Task {index + 1}</legend>
      <Input label={`Task ${index + 1} title`} value={task.title} required onChange={(event) => edit(index, { title: event.target.value })} />
      <Textarea label={`Task ${index + 1} description`} value={task.description} onChange={(event) => edit(index, { description: event.target.value })} />
      <Textarea label={`Task ${index + 1} acceptance criteria`} helperText="One criterion per line" value={task.acceptance_criteria.join("\n")} required onChange={(event) => edit(index, { acceptance_criteria: event.target.value.split("\n") })} />
      <Input label={`Task ${index + 1} capabilities`} helperText="Comma-separated, e.g. code.modify, test.run" value={task.required_capabilities.join(",")} onChange={(event) => edit(index, { required_capabilities: event.target.value.split(",") })} />
      {index > 0 && <div className="u-stack-sm"><span>Requires completion of</span>{tasks.slice(0, index).map((previous, previousIndex) => <label key={previousIndex}><input type="checkbox" checked={task.dependencies.some((dep) => dep.ref === String(previousIndex))} onChange={(event) => edit(index, { dependencies: event.target.checked ? [...task.dependencies, { ref: String(previousIndex), type: "blocks" }] : task.dependencies.filter((dep) => dep.ref !== String(previousIndex)) })} />{previous.title || `Task ${previousIndex + 1}`}</label>)}</div>}
      {index === tasks.length - 1 && tasks.length > 1 && <Button size="sm" onClick={() => setTasks(tasks.slice(0, -1))}>Remove last task</Button>}
    </fieldset>)}
    <ActionError error={mutation.error} /><div className="action-row"><Button onClick={() => setTasks([...tasks, blankTask()])}>Add plan task</Button><Button type="submit" variant="primary" loading={mutation.isPending} disabled={tasks.some((task) => !task.title.trim() || !task.acceptance_criteria.some((item) => item.trim()))}>Submit plan for review</Button></div>
  </form>;
}
