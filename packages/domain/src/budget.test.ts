import { describe, expect, it } from "vitest";

import {
  budgetStopAction,
  evaluateBudget,
  evaluateBudgetAction,
  isRuntimeAllowed,
  type BudgetUsage,
} from "./budget.js";
import { GoalBudgetsSchema, StopConditionsSchema } from "./goal.js";

const budgets = (over: Record<string, unknown> = {}) => GoalBudgetsSchema.parse(over);
const stops = (rules: unknown[] = []) => StopConditionsSchema.parse({ rules });

describe("budget evaluation (#115 P3)", () => {
  it("flags only the budgets the usage exceeds; unset limits never trip", () => {
    const b = budgets({ max_elapsed_ms: 1000, max_retries: 3 });
    const usage: BudgetUsage = { elapsed_ms: 1500, retry_count: 2, cost_usd: 999, concurrent_runs: 9 };
    const v = evaluateBudget(b, usage);
    expect(v).toEqual([{ budget: "max_elapsed_ms", limit: 1000, actual: 1500 }]);
  });

  it("treats a missing usage value for a set limit as 0 (cannot spuriously trip)", () => {
    const b = budgets({ max_cost_usd: 10 });
    expect(evaluateBudget(b, {})).toEqual([]);
    expect(evaluateBudget(b, { cost_usd: 11 })).toHaveLength(1);
  });

  it("flags multiple violations", () => {
    const b = budgets({ max_elapsed_ms: 1000, max_retries: 1, max_concurrent_runs: 2 });
    const v = evaluateBudget(b, { elapsed_ms: 2000, retry_count: 5, concurrent_runs: 3 });
    expect(v.map((x) => x.budget).sort()).toEqual(["max_concurrent_runs", "max_elapsed_ms", "max_retries"]);
  });

  it("isRuntimeAllowed respects allowed_runtimes (null = unrestricted)", () => {
    expect(isRuntimeAllowed(budgets({}), "any")).toBe(true);
    expect(isRuntimeAllowed(budgets({ allowed_runtimes: ["claude-code"] }), "claude-code")).toBe(true);
    expect(isRuntimeAllowed(budgets({ allowed_runtimes: ["claude-code"] }), "other")).toBe(false);
  });

  it("budgetStopAction: none when no violations, pause by default, strongest rule wins", () => {
    expect(budgetStopAction([], stops())).toBe("none");
    const v = [{ budget: "max_retries" as const, limit: 1, actual: 2 }];
    expect(budgetStopAction(v, stops())).toBe("pause"); // v3.0 default
    expect(budgetStopAction(v, stops([{ type: "budget_exceeded", threshold: 1, action: "notify" }]))).toBe("notify");
    expect(
      budgetStopAction(
        v,
        stops([
          { type: "budget_exceeded", threshold: 1, action: "notify" },
          { type: "budget_exceeded", threshold: 1, action: "cancel" },
        ]),
      ),
    ).toBe("cancel"); // strongest wins
    // Non-budget rules are ignored for budget violations.
    expect(budgetStopAction(v, stops([{ type: "approval_timeout", threshold: 1, action: "notify" }]))).toBe("pause");
  });

  it("evaluateBudgetAction combines evaluation + action", () => {
    const r = evaluateBudgetAction(budgets({ max_elapsed_ms: 1000 }), { elapsed_ms: 2000 }, stops());
    expect(r.violations).toHaveLength(1);
    expect(r.action).toBe("pause");

    const ok = evaluateBudgetAction(budgets({ max_elapsed_ms: 1000 }), { elapsed_ms: 500 }, stops());
    expect(ok.violations).toHaveLength(0);
    expect(ok.action).toBe("none");
  });
});
