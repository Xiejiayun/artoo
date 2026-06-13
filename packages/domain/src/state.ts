/**
 * Task / Run / Approval state machines (design.md §3.3, §3.4, §9.7).
 *
 * FROZEN per codex Round 18/19, including the recovery/changes edges:
 *  - `review -> ready`  (request changes)
 *  - `blocked -> ready` (retry)
 *  - `assigned -> ready` (retryable start failure) / `assigned -> blocked` (permission)
 *
 * `reentrant` marks transitions whose target state is re-enterable through a
 * retry/changes loop. The server reads this to derive idempotency scope: a
 * reentrant write must key on the run/attempt dimension, not just the task id.
 *
 * All functions are pure (no IO, no time, no randomness).
 */
import { z } from "zod";

export class InvalidTransitionError extends Error {
  constructor(
    public readonly machine: "task" | "run" | "approval",
    public readonly from: string,
    public readonly trigger: string,
  ) {
    super(`Invalid ${machine} transition: '${trigger}' from '${from}'`);
    this.name = "InvalidTransitionError";
  }
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export const TaskStatusSchema = z.enum([
  "backlog",
  "ready",
  "assigned",
  "running",
  "awaiting_approval",
  "blocked",
  "review",
  "done",
  "cancelled",
]);
export const TASK_STATUSES = TaskStatusSchema.options;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TASK_TRIGGERS = [
  "triage",
  "assign",
  "run_started",
  "assign_failed_retryable",
  "assign_failed_permission",
  "approval_requested",
  "approval_granted",
  "approval_rejected",
  "run_completed",
  "run_failed",
  "retry",
  "accept",
  "request_changes",
  "cancel",
] as const;
export type TaskTrigger = (typeof TASK_TRIGGERS)[number];

export interface TaskTransition {
  from: TaskStatus;
  to: TaskStatus;
  trigger: TaskTrigger;
  reentrant: boolean;
}

const TASK_TERMINAL: readonly TaskStatus[] = ["done", "cancelled"];

const TASK_NON_TERMINAL: readonly TaskStatus[] = TASK_STATUSES.filter(
  (s) => !TASK_TERMINAL.includes(s),
);

export const TASK_TRANSITIONS: readonly TaskTransition[] = [
  { from: "backlog", to: "ready", trigger: "triage", reentrant: false },
  { from: "ready", to: "assigned", trigger: "assign", reentrant: false },
  { from: "assigned", to: "running", trigger: "run_started", reentrant: false },
  // gap3: start failure before Running must have legal edges (never stuck).
  { from: "assigned", to: "ready", trigger: "assign_failed_retryable", reentrant: true },
  { from: "assigned", to: "blocked", trigger: "assign_failed_permission", reentrant: false },
  { from: "running", to: "awaiting_approval", trigger: "approval_requested", reentrant: false },
  { from: "awaiting_approval", to: "running", trigger: "approval_granted", reentrant: false },
  { from: "awaiting_approval", to: "blocked", trigger: "approval_rejected", reentrant: false },
  { from: "running", to: "review", trigger: "run_completed", reentrant: false },
  { from: "running", to: "blocked", trigger: "run_failed", reentrant: false },
  // recovery: driven by POST /tasks/:id/retry.
  { from: "blocked", to: "ready", trigger: "retry", reentrant: true },
  { from: "review", to: "done", trigger: "accept", reentrant: false },
  // gap1: changes requested loops back to ready.
  { from: "review", to: "ready", trigger: "request_changes", reentrant: true },
  // cancel from any non-terminal state.
  ...TASK_NON_TERMINAL.map(
    (from): TaskTransition => ({ from, to: "cancelled", trigger: "cancel", reentrant: false }),
  ),
];

export function isTaskTerminal(status: TaskStatus): boolean {
  return TASK_TERMINAL.includes(status);
}

export function taskTransitionsFrom(from: TaskStatus): readonly TaskTransition[] {
  return TASK_TRANSITIONS.filter((t) => t.from === from);
}

export function findTaskTransition(
  from: TaskStatus,
  trigger: TaskTrigger,
): TaskTransition | undefined {
  return TASK_TRANSITIONS.find((t) => t.from === from && t.trigger === trigger);
}

export function canTransitionTask(from: TaskStatus, trigger: TaskTrigger): boolean {
  return findTaskTransition(from, trigger) !== undefined;
}

export function applyTaskTransition(from: TaskStatus, trigger: TaskTrigger): TaskStatus {
  const transition = findTaskTransition(from, trigger);
  if (!transition) {
    throw new InvalidTransitionError("task", from, trigger);
  }
  return transition.to;
}

/**
 * Whether a trigger leads into a re-enterable state. Used by the server to scope
 * idempotency keys for reentrant writes (assign/retry) on the run/attempt axis.
 */
export function isTaskTriggerReentrant(trigger: TaskTrigger): boolean {
  return TASK_TRANSITIONS.some((t) => t.trigger === trigger && t.reentrant);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export const RunStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "awaiting_input",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export const RUN_STATUSES = RunStatusSchema.options;
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RUN_TRIGGERS = [
  "start",
  "process_started",
  "start_failed",
  "run_completed",
  "run_failed",
  "cancel",
  "input_requested",
  "input_provided",
  "pause",
  "resume",
] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export interface RunTransition {
  from: RunStatus;
  to: RunStatus;
  trigger: RunTrigger;
}

const RUN_TERMINAL: readonly RunStatus[] = ["completed", "failed", "cancelled"];

// No failed -> queued edge: retry creates a NEW run (codex Round 18).
export const RUN_TRANSITIONS: readonly RunTransition[] = [
  { from: "queued", to: "starting", trigger: "start" },
  { from: "queued", to: "cancelled", trigger: "cancel" },
  { from: "starting", to: "running", trigger: "process_started" },
  { from: "starting", to: "failed", trigger: "start_failed" },
  { from: "starting", to: "cancelled", trigger: "cancel" },
  { from: "running", to: "completed", trigger: "run_completed" },
  { from: "running", to: "failed", trigger: "run_failed" },
  { from: "running", to: "cancelled", trigger: "cancel" },
  { from: "running", to: "awaiting_input", trigger: "input_requested" },
  { from: "awaiting_input", to: "running", trigger: "input_provided" },
  { from: "awaiting_input", to: "cancelled", trigger: "cancel" },
  { from: "running", to: "paused", trigger: "pause" },
  { from: "paused", to: "running", trigger: "resume" },
  { from: "paused", to: "cancelled", trigger: "cancel" },
];

export function isRunTerminal(status: RunStatus): boolean {
  return RUN_TERMINAL.includes(status);
}

export function canTransitionRun(from: RunStatus, trigger: RunTrigger): boolean {
  return RUN_TRANSITIONS.some((t) => t.from === from && t.trigger === trigger);
}

export function applyRunTransition(from: RunStatus, trigger: RunTrigger): RunStatus {
  const transition = RUN_TRANSITIONS.find((t) => t.from === from && t.trigger === trigger);
  if (!transition) {
    throw new InvalidTransitionError("run", from, trigger);
  }
  return transition.to;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "needs_more_info",
  "expired",
]);
export const APPROVAL_STATUSES = ApprovalStatusSchema.options;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const APPROVAL_TRIGGERS = ["approve", "reject", "need_more_info", "expire"] as const;
export type ApprovalTrigger = (typeof APPROVAL_TRIGGERS)[number];

export interface ApprovalTransition {
  from: ApprovalStatus;
  to: ApprovalStatus;
  trigger: ApprovalTrigger;
}

const APPROVAL_TERMINAL: readonly ApprovalStatus[] = ["approved", "rejected", "expired"];

export const APPROVAL_TRANSITIONS: readonly ApprovalTransition[] = [
  { from: "pending", to: "approved", trigger: "approve" },
  { from: "pending", to: "rejected", trigger: "reject" },
  { from: "pending", to: "needs_more_info", trigger: "need_more_info" },
  { from: "pending", to: "expired", trigger: "expire" },
  // needs_more_info can still be resolved.
  { from: "needs_more_info", to: "approved", trigger: "approve" },
  { from: "needs_more_info", to: "rejected", trigger: "reject" },
  { from: "needs_more_info", to: "expired", trigger: "expire" },
];

export function isApprovalTerminal(status: ApprovalStatus): boolean {
  return APPROVAL_TERMINAL.includes(status);
}

export function canTransitionApproval(from: ApprovalStatus, trigger: ApprovalTrigger): boolean {
  return APPROVAL_TRANSITIONS.some((t) => t.from === from && t.trigger === trigger);
}

export function applyApprovalTransition(
  from: ApprovalStatus,
  trigger: ApprovalTrigger,
): ApprovalStatus {
  const transition = APPROVAL_TRANSITIONS.find((t) => t.from === from && t.trigger === trigger);
  if (!transition) {
    throw new InvalidTransitionError("approval", from, trigger);
  }
  return transition.to;
}
