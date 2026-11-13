import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useApi } from "../app/ApiContext.js";
import { useProject } from "../app/useProject.js";
import { DRAFTS_CLEARED_EVENT } from "../app/roomDrafts.js";
import { clearSubmittedPlanDraft, loadPlanDraft, newPlanDraft, newPlanTask, planDraftKey, planTaskSpecs, removePlanDraft, savePlanDraft,
  type PlanDraft, type PlanDraftTask } from "../app/planDrafts.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Button, Input, Textarea, useToast } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { CAPABILITY_LABELS } from "./taskPresentation.js";

export function PlanForm({ goalId, onCreated }: { goalId: string; onCreated: () => Promise<void> }): React.ReactNode {
  const api = useApi();
  const { bootstrap } = useProject();
  if (!bootstrap.data) return null;
  const key = planDraftKey(api.getStorageScope(), bootstrap.data.organization.id, bootstrap.data.user.id, goalId);
  return <PlanEditor key={key} storageKey={key} goalId={goalId} onCreated={onCreated} />;
}

function PlanEditor({ storageKey, goalId, onCreated }: { storageKey: string; goalId: string; onCreated: () => Promise<void> }): React.ReactNode {
  const api = useApi(), toast = useToast();
  const [initial] = useState(() => loadPlanDraft(storageKey));
  const [draft, setDraft] = useState(initial.draft);
  const [notice, setNotice] = useState(initial.notice);
  const [unreadable, setUnreadable] = useState(initial.unreadable);
  const [sessionEnded, setSessionEnded] = useState(false);
  const titles = useRef(new Map<string, HTMLInputElement>());
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const cleared = (): void => { active.current = false; setDraft(newPlanDraft()); setSessionEnded(true); setNotice(""); };
    window.addEventListener(DRAFTS_CLEARED_EVENT, cleared);
    return () => { active.current = false; window.removeEventListener(DRAFTS_CLEARED_EVENT, cleared); };
  }, []);
  const persist = (next: PlanDraft): void => {
    if (!active.current) return;
    setDraft(next);
    setNotice(savePlanDraft(storageKey, next) ? "" : "Your draft could not be saved in this browser. Keep this editor open to retain your edits.");
  };
  const mutation = useMutation({ mutationFn: (submitted: PlanDraft) => api.proposePlan(goalId, { rationale: submitted.rationale, task_specs: planTaskSpecs(submitted) }, newIdempotencyKey()),
    onSuccess: async (_, submitted) => {
      if (clearSubmittedPlanDraft(storageKey, submitted) === "unavailable") toast.push({ tone: "warning", message: "Plan submitted. The browser could not clear its saved draft." });
      if (active.current) await onCreated();
    } });
  const edit = (id: string, patch: Partial<PlanDraftTask>): void => persist({ ...draft, tasks: draft.tasks.map(task => task.id === id ? { ...task, ...patch } : task) });
  const move = (index: number, direction: -1 | 1): void => {
    const tasks = [...draft.tasks], target = index + direction;
    if (target < 0 || target >= tasks.length) return;
    [tasks[index], tasks[target]] = [tasks[target]!, tasks[index]!];
    persist({ ...draft, tasks });
  };
  const remove = (id: string, index: number): void => {
    const tasks = draft.tasks.filter(task => task.id !== id).map(task => ({ ...task, dependencies: task.dependencies.filter(ref => ref !== id) }));
    persist({ ...draft, tasks });
    requestAnimationFrame(() => titles.current.get(tasks[Math.min(index, tasks.length - 1)]!.id)?.focus());
  };
  const locked = mutation.isPending || unreadable || sessionEnded;
  return <form className="insights-plan-editor u-stack" aria-label="Plan editor" onSubmit={event => { event.preventDefault(); if (!locked) mutation.mutate(draft); }}>
    <p className="insights-help">Break the outcome into reviewable tasks. Reordering keeps their dependencies; deleting a task removes dependencies on it. Drafts are saved in this browser until submitted or discarded.</p>
    {notice && <p role="status">{notice}</p>}
    {sessionEnded && <p role="status">Your session ended. Sign in again before editing this plan.</p>}
    {!sessionEnded && <Button size="sm" disabled={mutation.isPending} onClick={() => {
      if (!removePlanDraft(storageKey)) { setNotice("The saved draft could not be discarded. Check browser storage and try again."); return; }
      setDraft(newPlanDraft()); setUnreadable(false); setNotice("Saved plan draft discarded.");
    }}>Discard saved draft</Button>}
    <Textarea label="Plan rationale" placeholder="Explain the approach and why these tasks are needed." value={draft.rationale} required disabled={locked} onChange={event => persist({ ...draft, rationale: event.target.value })} />
    {draft.tasks.map((task, index) => <fieldset key={task.id} className="insights-plan-task-editor u-stack-sm" disabled={locked}><legend>Task {index + 1}</legend>
      <Input ref={element => { if (element) titles.current.set(task.id, element); else titles.current.delete(task.id); }} label={`Task ${index + 1} title`} value={task.title} required onChange={event => edit(task.id, { title: event.target.value })} />
      <Textarea label={`Task ${index + 1} description`} value={task.description} onChange={event => edit(task.id, { description: event.target.value })} />
      <Textarea label={`Task ${index + 1} acceptance criteria`} helperText="One criterion per line" value={task.criteria} required onChange={event => edit(task.id, { criteria: event.target.value })} />
      <details className="insights-disclosure"><summary>Agent capabilities · {task.capabilities.length} selected</summary><fieldset className="insights-capability-picker"><legend>Task {index + 1} capabilities</legend>{Object.entries(CAPABILITY_LABELS).map(([capability, label]) => <label key={capability}><input type="checkbox" checked={task.capabilities.includes(capability)} onChange={event => edit(task.id, { capabilities: event.target.checked ? [...task.capabilities, capability] : task.capabilities.filter(item => item !== capability) })} />{label}</label>)}</fieldset></details>
      {draft.tasks.length > 1 && <div className="u-stack-sm"><span>Requires completion of</span>{draft.tasks.filter(previous => previous.id !== task.id).map(previous => <label key={previous.id}><input type="checkbox" checked={task.dependencies.includes(previous.id)} onChange={event => edit(task.id, { dependencies: event.target.checked ? [...task.dependencies, previous.id] : task.dependencies.filter(ref => ref !== previous.id) })} />{previous.title || `Task ${draft.tasks.indexOf(previous) + 1}`}</label>)}</div>}
      <div className="action-row"><Button size="sm" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move task ${index + 1} up`}>Move up</Button><Button size="sm" disabled={index === draft.tasks.length - 1} onClick={() => move(index, 1)} aria-label={`Move task ${index + 1} down`}>Move down</Button><Button size="sm" disabled={draft.tasks.length === 1} onClick={() => remove(task.id, index)} aria-label={`Remove task ${index + 1}`}>Remove task</Button></div>
    </fieldset>)}
    <ActionError error={mutation.error} /><div className="action-row"><Button iconLeft={Plus} disabled={locked} onClick={() => persist({ ...draft, tasks: [...draft.tasks, newPlanTask()] })}>Add plan task</Button><Button type="submit" variant="primary" loading={mutation.isPending} disabled={locked || !draft.rationale.trim() || draft.tasks.some(task => !task.title.trim() || !task.criteria.trim())}>Submit plan for review</Button></div>
  </form>;
}
