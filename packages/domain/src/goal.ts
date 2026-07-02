/**
 * V3 #115 — Persistent Goal / Plan / Checkpoint domain model.
 *
 * Goals sit ABOVE the existing task/run/DAG machinery: a goal owns a versioned
 * plan, the accepted plan materializes into a task DAG, and checkpoints are
 * reference-based markers on safe boundaries so a long run can be explained and
 * replayed across daemon/server restarts.
 *
 * All functions here are pure (no IO, time, or randomness). Schema/state design
 * is the accepted #128 supplement (docs/v3-115-goals-schema-design.md).
 */
import { z } from "zod";

import { ActorTypeSchema } from "./events.js";
import { AuditEventSchema, DependencyTypeSchema, PrioritySchema, RoomSchema, TaskAuditBundleSchema } from "./schemas.js";

export class InvalidGoalTransitionError extends Error {
  constructor(
    public readonly machine: "goal" | "plan",
    public readonly from: string,
    public readonly trigger: string,
  ) {
    super(`Invalid ${machine} transition: '${trigger}' from '${from}'`);
    this.name = "InvalidGoalTransitionError";
  }
}

// ---------------------------------------------------------------------------
// Goal state machine
// ---------------------------------------------------------------------------

export const GoalStatusSchema = z.enum([
  "draft",
  "planned",
  "running",
  "awaiting_approval",
  "paused",
  "blocked",
  "completed",
  "cancelled",
  "archived",
]);
export const GOAL_STATUSES = GoalStatusSchema.options;
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GOAL_TRIGGERS = [
  "plan_accepted",
  "plan_rejected",
  "dag_materialized",
  "approval_required",
  "approval_granted",
  "approval_rejected",
  "pause",
  "resume",
  "blocked_detected",
  "blocker_resolved",
  "all_tasks_terminal",
  "cancel",
  "archive",
] as const;
export type GoalTrigger = (typeof GOAL_TRIGGERS)[number];

export interface GoalTransition {
  from: GoalStatus;
  to: GoalStatus;
  trigger: GoalTrigger;
  /**
   * `human` = the trigger is a human-initiated override (pause/resume/cancel/
   * archive). The rest are system-derived from child state. A graph annotation
   * only; authority is enforced in the service layer.
   */
  human: boolean;
}

export const GOAL_TERMINAL: readonly GoalStatus[] = ["completed", "cancelled", "archived"];

export const GOAL_TRANSITIONS: readonly GoalTransition[] = [
  { from: "draft", to: "planned", trigger: "plan_accepted", human: false },
  { from: "draft", to: "cancelled", trigger: "cancel", human: true },
  { from: "planned", to: "running", trigger: "dag_materialized", human: false },
  { from: "planned", to: "draft", trigger: "plan_rejected", human: false },
  { from: "planned", to: "cancelled", trigger: "cancel", human: true },
  { from: "running", to: "awaiting_approval", trigger: "approval_required", human: false },
  { from: "running", to: "paused", trigger: "pause", human: true },
  { from: "running", to: "blocked", trigger: "blocked_detected", human: false },
  { from: "running", to: "completed", trigger: "all_tasks_terminal", human: false },
  { from: "running", to: "cancelled", trigger: "cancel", human: true },
  { from: "awaiting_approval", to: "running", trigger: "approval_granted", human: false },
  { from: "awaiting_approval", to: "blocked", trigger: "approval_rejected", human: false },
  { from: "awaiting_approval", to: "paused", trigger: "pause", human: true },
  { from: "awaiting_approval", to: "cancelled", trigger: "cancel", human: true },
  { from: "paused", to: "running", trigger: "resume", human: true },
  { from: "paused", to: "cancelled", trigger: "cancel", human: true },
  { from: "blocked", to: "running", trigger: "blocker_resolved", human: false },
  { from: "blocked", to: "paused", trigger: "pause", human: true },
  { from: "blocked", to: "cancelled", trigger: "cancel", human: true },
  { from: "completed", to: "archived", trigger: "archive", human: true },
  { from: "cancelled", to: "archived", trigger: "archive", human: true },
];

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return GOAL_TERMINAL.includes(status);
}

export function canTransitionGoal(from: GoalStatus, trigger: GoalTrigger): boolean {
  return GOAL_TRANSITIONS.some((t) => t.from === from && t.trigger === trigger);
}

export function goalTransitionTarget(from: GoalStatus, trigger: GoalTrigger): GoalStatus | null {
  return GOAL_TRANSITIONS.find((t) => t.from === from && t.trigger === trigger)?.to ?? null;
}

export function applyGoalTransition(from: GoalStatus, trigger: GoalTrigger): GoalStatus {
  const to = goalTransitionTarget(from, trigger);
  if (to === null) {
    throw new InvalidGoalTransitionError("goal", from, trigger);
  }
  return to;
}

// ---------------------------------------------------------------------------
// Plan versioning
// ---------------------------------------------------------------------------

export const PlanStatusSchema = z.enum(["proposed", "accepted", "rejected", "superseded"]);
export const PLAN_STATUSES = PlanStatusSchema.options;
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PLAN_TRIGGERS = ["accept", "reject", "new_version_accepted"] as const;
export type PlanTrigger = (typeof PLAN_TRIGGERS)[number];

export interface PlanTransition {
  from: PlanStatus;
  to: PlanStatus;
  trigger: PlanTrigger;
}

export const PLAN_TRANSITIONS: readonly PlanTransition[] = [
  { from: "proposed", to: "accepted", trigger: "accept" },
  { from: "proposed", to: "rejected", trigger: "reject" },
  { from: "accepted", to: "superseded", trigger: "new_version_accepted" },
];

export function canTransitionPlan(from: PlanStatus, trigger: PlanTrigger): boolean {
  return PLAN_TRANSITIONS.some((t) => t.from === from && t.trigger === trigger);
}

export function applyPlanTransition(from: PlanStatus, trigger: PlanTrigger): PlanStatus {
  const to = PLAN_TRANSITIONS.find((t) => t.from === from && t.trigger === trigger)?.to;
  if (to === undefined) {
    throw new InvalidGoalTransitionError("plan", from, trigger);
  }
  return to;
}

/**
 * A new plan version may only be PROPOSED when there is no accepted plan yet
 * (first plan) OR the current accepted plan's goal is paused/blocked. Re-planning
 * a running goal requires an explicit pause first (#128 mutation rule).
 */
export function canProposePlan(goalStatus: GoalStatus, hasAcceptedPlan: boolean): boolean {
  if (!hasAcceptedPlan) return goalStatus === "draft" || goalStatus === "planned";
  return goalStatus === "paused" || goalStatus === "blocked";
}

// ---------------------------------------------------------------------------
// Plan content schema
// ---------------------------------------------------------------------------

/** A planned task within a plan version. `dependencies[].ref` points at another
 *  spec by its 0-based index in the same plan (string form of the index). */
export const TaskSpecSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  // Plan materialization creates ordinary backlog tasks, and the existing task
  // lifecycle requires non-empty criteria before a task can be marked ready.
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  required_capabilities: z.array(z.string()).default([]),
  dependencies: z
    .array(z.object({ ref: z.string(), type: DependencyTypeSchema }))
    .default([]),
  approval_gates: z.array(z.string()).default([]),
  write_scopes: z.array(z.string()).default([]),
  expected_artifacts: z
    .array(z.object({ type: z.string(), description: z.string().default("") }))
    .default([]),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const PlanSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  goal_id: z.string(),
  version: z.number().int().positive(),
  author_type: ActorTypeSchema,
  author_id: z.string(),
  rationale: z.string().default(""),
  status: PlanStatusSchema,
  task_specs: z.array(TaskSpecSchema),
  materialized_at: z.string().nullable(),
  materialization_event_id: z.string().nullable(),
  created_at: z.string(),
  accepted_at: z.string().nullable(),
});
export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------------------
// Checkpoints (reference-based)
// ---------------------------------------------------------------------------

// 7 trigger types (the #128 doc heading said "6" but listed 7 — fixed per
// SkywalkerCodex review note 1).
export const CheckpointTypeSchema = z.enum([
  "plan_accepted",
  "dag_materialized",
  "approval_decided",
  "run_terminal",
  "artifact_accepted",
  "paused",
  "resumed",
]);
export const CHECKPOINT_TYPES = CheckpointTypeSchema.options;
export type CheckpointType = z.infer<typeof CheckpointTypeSchema>;

/** Pointers to live DB state at checkpoint time — never full copies. */
export const CheckpointRefsSchema = z.object({
  goal_status: GoalStatusSchema,
  plan_version: z.number().int().nonnegative(),
  task_statuses: z.array(z.object({ task_id: z.string(), status: z.string() })).default([]),
  active_runs: z.array(z.string()).default([]),
  open_blockers: z.array(z.string()).default([]),
  pending_approvals: z.array(z.string()).default([]),
  event_cursor: z.number().int().nonnegative(),
});
export type CheckpointRefs = z.infer<typeof CheckpointRefsSchema>;

export const CheckpointSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  goal_id: z.string(),
  plan_id: z.string().nullable(),
  type: CheckpointTypeSchema,
  trigger_event_id: z.string().nullable(),
  state_refs: CheckpointRefsSchema,
  summary: z.string().default(""),
  created_at: z.string(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

// ---------------------------------------------------------------------------
// Budgets & stop conditions
// ---------------------------------------------------------------------------

export const GoalBudgetsSchema = z.object({
  max_elapsed_ms: z.number().int().positive().nullable().default(null),
  max_cost_usd: z.number().positive().nullable().default(null),
  max_retries: z.number().int().nonnegative().nullable().default(null),
  max_concurrent_runs: z.number().int().positive().nullable().default(null),
  allowed_runtimes: z.array(z.string()).nullable().default(null),
});
export type GoalBudgets = z.infer<typeof GoalBudgetsSchema>;

export const StopRuleSchema = z.object({
  type: z.enum(["budget_exceeded", "approval_timeout", "consecutive_failures", "custom"]),
  threshold: z.union([z.number(), z.string()]),
  action: z.enum(["pause", "cancel", "notify"]),
});
export type StopRule = z.infer<typeof StopRuleSchema>;

export const StopConditionsSchema = z.object({
  rules: z.array(StopRuleSchema).default([]),
});
export type StopConditions = z.infer<typeof StopConditionsSchema>;

// ---------------------------------------------------------------------------
// Goal record
// ---------------------------------------------------------------------------

export const GoalSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  room_id: z.string().nullable(),
  owner_user_id: z.string(),
  title: z.string().min(1),
  objective: z.string().default(""),
  priority: PrioritySchema,
  status: GoalStatusSchema,
  acceptance_criteria: z.array(z.string()).default([]),
  stop_conditions: StopConditionsSchema,
  budgets: GoalBudgetsSchema,
  current_plan_id: z.string().nullable(),
  running_since: z.string().nullable(),
  elapsed_cost_usd: z.number().nullable(),
  retry_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Goal = z.infer<typeof GoalSchema>;

// ---------------------------------------------------------------------------
// Derivation helpers (pure; the service feeds DB facts in)
// ---------------------------------------------------------------------------

export interface ChildStateFacts {
  /** child task statuses (TaskStatus strings) */
  taskStatuses: string[];
  /** count of open (active) blockers with no mitigation path */
  openBlockers: number;
  /** any child task/run awaiting an approval gated at goal level */
  awaitingApproval: boolean;
  /** acceptance criteria all satisfied (service decides this) */
  acceptanceMet: boolean;
}

const TERMINAL_TASK_STATUSES = new Set(["done", "cancelled"]);

/**
 * Derive the *system* goal status from child state, per #128 §1. Returns the
 * derived status for an active goal; human override states (paused) and terminal
 * states are owned by the service and are NOT produced here. Returns null when
 * no derivation applies (e.g. the goal has no children yet).
 */
export function deriveGoalStatusFromChildren(facts: ChildStateFacts): GoalStatus | null {
  if (facts.taskStatuses.length === 0) return null;
  const allTerminal = facts.taskStatuses.every((s) => TERMINAL_TASK_STATUSES.has(s));
  if (allTerminal) return facts.acceptanceMet ? "completed" : "blocked";
  if (facts.awaitingApproval) return "awaiting_approval";
  if (facts.openBlockers > 0) return "blocked";
  return "running";
}

// ---------------------------------------------------------------------------
// Goal-level audit bundle (V3 #140 / deferred P4) — a read-only, deterministic
// consolidation of a goal's full evidence chain. Composes the existing per-task
// audit bundle for each child task, so child runs/artifacts/approvals/blockers/
// messages/events come through unchanged, and adds the goal row (lifecycle +
// budgets + retry_count + provenance), its plans (versioned), checkpoints, and
// the goal's own ordered event stream. This is a consolidated goal-level proof,
// NOT a replacement for per-task audit bundles.
// ---------------------------------------------------------------------------

export const GoalAuditBundleSchema = z.object({
  goal: GoalSchema,
  room: RoomSchema.nullable(),
  plans: z.array(PlanSchema),
  checkpoints: z.array(CheckpointSchema),
  /** Full per-task audit bundle for each child task (already redacted). */
  tasks: z.array(TaskAuditBundleSchema),
  /** The goal's own lifecycle event stream (goal.* events), ordered by position. */
  events: z.array(AuditEventSchema),
});
export type GoalAuditBundle = z.infer<typeof GoalAuditBundleSchema>;

export const GoalAuditBundleExportSchema = z.object({
  schema_version: z.literal("v1alpha1"),
  exported_at: z.string(),
  bundle_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  bundle: GoalAuditBundleSchema,
  signature: z.null(),
  signing: z.object({
    status: z.literal("deferred"),
    reason: z.literal("v1 does not manage signing keys yet"),
  }),
});
export type GoalAuditBundleExport = z.infer<typeof GoalAuditBundleExportSchema>;
