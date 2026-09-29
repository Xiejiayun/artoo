import { GoalBudgetsSchema, StopConditionsSchema } from "@artoo/domain";

import { AppError } from "../errors.js";

/** Reject settings the server cannot honor instead of accepting a false limit. */
export function supportedGoalPolicy(budgetsInput: unknown, stopConditionsInput: unknown) {
  const budgets = GoalBudgetsSchema.parse(budgetsInput ?? {});
  const stopConditions = StopConditionsSchema.parse(stopConditionsInput ?? { rules: [] });
  if (budgets.max_cost_usd !== null) {
    throw AppError.validation("max_cost_usd is not supported: execution cost metering is not available", { field: "budgets.max_cost_usd" });
  }
  const unsupported = stopConditions.rules.find((rule) => rule.type !== "budget_exceeded" || rule.action !== "pause");
  if (unsupported) {
    throw AppError.validation("Only budget_exceeded stop rules with action pause are supported", {
      field: "stop_conditions.rules", type: unsupported.type, action: unsupported.action,
    });
  }
  return { budgets, stopConditions };
}
