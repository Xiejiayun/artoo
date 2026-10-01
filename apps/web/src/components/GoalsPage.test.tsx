// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GoalSchema, type Plan } from "@artoo/domain";
import type { ApiClient } from "../api/client.js";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { GoalsPage } from "./GoalsPage.js";

const goal = GoalSchema.parse({ id: "goal_1", organization_id: "org_default", project_id: "proj_artoo", room_id: null, owner_user_id: "user_1", title: "A reliable release", objective: "Make delivery repeatable", priority: "p2", status: "draft", acceptance_criteria: ["Evidence is reviewed"], stop_conditions: {}, budgets: {}, current_plan_id: null, running_since: null, elapsed_cost_usd: null, retry_count: 0, created_at: "2026-10-01", updated_at: "2026-10-01" });
function api(overrides: Partial<ApiClient> = {}) {
  return fakeApi({ bootstrap: async () => bootstrapFixture(), listGoals: async () => ({ goals: [goal] }), listPlans: async () => ({ plans: [] }), listCheckpoints: async () => ({ checkpoints: [] }), listDiscussions: async () => ({ discussions: [] }), listChannels: async () => ({ channels: [] }), ...overrides });
}

describe("GoalsPage", () => {
  it("creates an outcome in a focused dialog using the existing goal contract", async () => {
    const createGoal = vi.fn<ApiClient["createGoal"]>().mockResolvedValue({ goal });
    renderWithProviders(<GoalsPage />, { client: api({ createGoal }) });
    await userEvent.click(await screen.findByRole("button", { name: "New goal" }));
    const dialog = screen.getByRole("dialog", { name: "New goal" });
    await userEvent.type(within(dialog).getByLabelText("Goal title"), " Clear outcome ");
    await userEvent.type(within(dialog).getByLabelText("Objective"), " Deliver reliably ");
    await userEvent.type(within(dialog).getByLabelText("Goal acceptance criteria"), "Pass checks\nReview evidence");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create goal" }));
    await waitFor(() => expect(createGoal).toHaveBeenCalledWith(expect.objectContaining({ project_id: "proj_artoo", title: "Clear outcome", objective: "Deliver reliably", acceptance_criteria: ["Pass checks", "Review evidence"], priority: "p2" }), expect.any(String)));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("uses readable capability choices and preserves dependency references when proposing a plan", async () => {
    const proposePlan = vi.fn<ApiClient["proposePlan"]>().mockResolvedValue({ plan: {} as Plan });
    renderWithProviders(<GoalsPage />, { client: api({ proposePlan }) });
    await userEvent.click(await screen.findByRole("button", { name: "Propose plan" }));
    await userEvent.type(screen.getByLabelText("Plan rationale"), "Verify the work in order");
    await userEvent.type(screen.getByLabelText("Task 1 title"), "Implement release");
    await userEvent.type(screen.getByLabelText("Task 1 acceptance criteria"), "Tests pass");
    await userEvent.click(screen.getByText("Agent capabilities · 0 selected"));
    await userEvent.click(screen.getByRole("checkbox", { name: "Write code" }));
    await userEvent.click(screen.getByRole("button", { name: "Add plan task" }));
    await userEvent.type(screen.getByLabelText("Task 2 title"), "Review release");
    await userEvent.type(screen.getByLabelText("Task 2 acceptance criteria"), "Evidence accepted");
    await userEvent.click(screen.getByRole("checkbox", { name: "Implement release" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit plan for review" }));
    await waitFor(() => expect(proposePlan).toHaveBeenCalledTimes(1));
    expect(proposePlan.mock.calls[0]?.[1].task_specs).toEqual([
      expect.objectContaining({ title: "Implement release", required_capabilities: ["code.modify"], dependencies: [], acceptance_criteria: ["Tests pass"] }),
      expect.objectContaining({ title: "Review release", required_capabilities: [], dependencies: [{ ref: "0", type: "blocks" }], acceptance_criteria: ["Evidence accepted"] }),
    ]);
  });
});
