/**
 * V3 #115 P3 groundwork — pure goal budget / stop-condition evaluation.
 *
 * Independent, additive domain logic (depends only on the merged GoalBudgets /
 * StopConditions schemas, no goal/plan service): given a goal's budgets and the
 * current usage facts, decide which budgets are exceeded and what action a stop
 * condition implies (#128 §4). Pure — no IO/time/randomness; the service feeds
 * the live facts in and acts on the result.
 *
 * v3.0 must-have surface: max_elapsed_ms + max_retries enforcement (pause action)
 * and allowed_runtimes filtering. max_cost_usd / max_concurrent_runs are
 * evaluated here too so the service can opt in as the tracking lands.
 */
import type { GoalBudgets, StopConditions } from "./goal.js";

export type BudgetKind = "max_elapsed_ms" | "max_cost_usd" | "max_retries" | "max_concurrent_runs";

export interface BudgetUsage {
  /** Wall-clock ms since the goal entered `running` (null if never ran). */
  elapsed_ms?: number | null;
  /** Accumulated child run cost in USD (null if not tracked). */
  cost_usd?: number | null;
  /** Total retry count across the goal's tasks. */
  retry_count?: number;
  /** Count of non-terminal runs right now. */
  concurrent_runs?: number;
}

export interface BudgetViolation {
  budget: BudgetKind;
  limit: number;
  actual: number;
}

/** Stop action to take; "none" when nothing is exceeded. */
export type BudgetAction = "pause" | "cancel" | "notify" | "none";

/**
 * Which budgets the current usage exceeds. A null limit (unset) is never
 * violated; a null/absent usage value for a set limit is treated as 0 (not yet
 * accrued), so it cannot spuriously trip the limit.
 */
export function evaluateBudget(budgets: GoalBudgets, usage: BudgetUsage): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  const check = (budget: BudgetKind, limit: number | null, actual: number | null | undefined): void => {
    if (limit == null) return;
    const value = actual ?? 0;
    if (value > limit) violations.push({ budget, limit, actual: value });
  };
  check("max_elapsed_ms", budgets.max_elapsed_ms, usage.elapsed_ms);
  check("max_cost_usd", budgets.max_cost_usd, usage.cost_usd);
  check("max_retries", budgets.max_retries, usage.retry_count);
  check("max_concurrent_runs", budgets.max_concurrent_runs, usage.concurrent_runs);
  return violations;
}

/** True when a runtime is allowed by the goal's allowed_runtimes (null = no
 *  restriction). Used as a scheduler-level filter. */
export function isRuntimeAllowed(budgets: GoalBudgets, runtimeId: string): boolean {
  return budgets.allowed_runtimes == null || budgets.allowed_runtimes.includes(runtimeId);
}

const ACTION_SEVERITY: Record<BudgetAction, number> = { cancel: 3, pause: 2, notify: 1, none: 0 };

/**
 * Resolve the action to take given budget violations and the goal's stop
 * conditions. With no violations → "none". When violations exist, the strongest
 * action among matching `budget_exceeded` stop rules wins; if there are no
 * explicit rules, the v3.0 default is "pause" (never silently keep spending).
 */
export function budgetStopAction(violations: BudgetViolation[], stopConditions: StopConditions): BudgetAction {
  if (violations.length === 0) return "none";
  const budgetRules = stopConditions.rules.filter((r) => r.type === "budget_exceeded");
  if (budgetRules.length === 0) return "pause";
  let action: BudgetAction = "notify";
  for (const rule of budgetRules) {
    if (ACTION_SEVERITY[rule.action] > ACTION_SEVERITY[action]) action = rule.action;
  }
  return action;
}

/** Convenience: evaluate budgets and resolve the action in one call. */
export function evaluateBudgetAction(
  budgets: GoalBudgets,
  usage: BudgetUsage,
  stopConditions: StopConditions,
): { violations: BudgetViolation[]; action: BudgetAction } {
  const violations = evaluateBudget(budgets, usage);
  return { violations, action: budgetStopAction(violations, stopConditions) };
}
