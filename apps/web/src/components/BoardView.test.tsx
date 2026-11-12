// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { bootstrapFixture, fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { BoardView } from "./BoardView.js";
import { GoalSchema } from "@artoo/domain";

function boardClient() {
  return fakeApi({
    bootstrap: async () => bootstrapFixture(),
    listApprovals: async () => ({ approvals: [] }),
    listTasks: async () => ({
      tasks: [
        taskFixture({ id: "t1", title: "In review", status: "review", priority: "p1" }),
        taskFixture({ id: "t2", title: "Backlog item", status: "backlog", priority: "p2" }),
        taskFixture({ id: "t3", title: "Another backlog", status: "backlog", priority: "p3" }),
      ],
    }),
  });
}

describe("BoardView", () => {
  it("scopes work by goal and current plan, retaining independent reviews and optional history", async () => {
    const goal = GoalSchema.parse({ id: "goal_1", organization_id: "org_default", project_id: "proj_artoo", room_id: null, owner_user_id: "user_1", title: "Journal", objective: "Journal", priority: "p2", status: "running", budgets: {}, stop_conditions: {}, current_plan_id: "plan_new", running_since: null, elapsed_cost_usd: null, retry_count: 0, created_at: "2026-11-12", updated_at: "2026-11-12" });
    const client = fakeApi({ bootstrap: async () => bootstrapFixture(), listGoals: async () => ({ goals: [goal] }), listTasks: async () => ({ tasks: [
      taskFixture({ id: "new", status: "backlog", title: "Current implementation", goal_id: goal.id, source_plan_id: "plan_new" }),
      taskFixture({ id: "old", status: "backlog", title: "Previous attempt", goal_id: goal.id, source_plan_id: "plan_old" }),
      taskFixture({ id: "review", status: "review", title: "Independent review", goal_id: goal.id, source_plan_id: null }),
      taskFixture({ id: "other", status: "backlog", title: "Other outcome", goal_id: "other" }),
    ] }) });
    renderWithProviders(<BoardView />, { client, route: "/board?goal=goal_1" });
    expect(await screen.findByText("Current implementation")).toBeInTheDocument();
    expect(screen.getByText("Independent review")).toBeInTheDocument();
    expect(screen.queryByText("Previous attempt")).not.toBeInTheDocument();
    expect(screen.queryByText("Other outcome")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Include work from earlier plans" }));
    expect(screen.getByText("Previous attempt")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Goal scope"), "");
    expect(screen.getByText("Other outcome")).toBeInTheDocument();
  });

  it("does not silently show project-wide work for an unavailable goal", async () => {
    renderWithProviders(<BoardView />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), listGoals: async () => ({ goals: [] }), listTasks: async () => ({ tasks: [taskFixture({ id: "unrelated", status: "backlog", title: "Unrelated work" })] }) }), route: "/board?goal=foreign" });
    await screen.findByRole("alert");
    expect(screen.queryByText("Unrelated work")).not.toBeInTheDocument();
  });
  it("announces loading while board columns are skeletonized", () => {
    const client = fakeApi({
      bootstrap: () => new Promise(() => undefined),
      listApprovals: async () => ({ approvals: [] }),
    });

    renderWithProviders(<BoardView />, { client, route: "/board" });

    expect(screen.getByRole("status", { name: "Loading board" })).toBeInTheDocument();
  });

  it("groups tasks into status columns from tasks(project)", async () => {
    renderWithProviders(<BoardView />, { client: boardClient(), route: "/board" });
    const backlog = await screen.findByRole("region", { name: "Backlog" });
    expect(backlog).toHaveTextContent("Backlog item");
    expect(backlog).toHaveTextContent("Another backlog");
    expect(screen.getByRole("region", { name: "Review" })).toHaveTextContent("In review");
  });

  it("filters by priority", async () => {
    renderWithProviders(<BoardView />, { client: boardClient(), route: "/board" });
    await screen.findByRole("region", { name: "Backlog" });

    await userEvent.selectOptions(screen.getByLabelText("Priority"), "p3");

    expect(screen.getByText("Another backlog")).toBeInTheDocument();
    expect(screen.queryByText("Backlog item")).toBeNull();
    expect(screen.queryByText("In review")).toBeNull();
  });

  it("combines search and priority and recovers from an empty result", async () => {
    renderWithProviders(<BoardView />, { client: boardClient(), route: "/board" });
    await screen.findByRole("region", { name: "Backlog" });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search board" }), "backlog");
    expect(screen.queryByText("In review")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Priority"), "p1");
    expect(screen.getByText("No matching tasks")).toBeInTheDocument();
    expect(screen.getByText("0 of 3 tasks")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("In review")).toBeInTheDocument();
    expect(screen.getByText("Another backlog")).toBeInTheDocument();
  });

  it("groups all lifecycle statuses into stages without hiding their exact meaning", async () => {
    const statuses = ["backlog", "ready", "assigned", "running", "awaiting_approval", "blocked", "review", "done", "cancelled"] as const;
    const client = fakeApi({ bootstrap: async () => bootstrapFixture(), listTasks: async () => ({ tasks: statuses.map((status) => taskFixture({ id: status, title: `Task ${status}`, status })) }) });
    renderWithProviders(<BoardView />, { client, route: "/board" });
    const backlog = await screen.findByRole("region", { name: "Backlog" });
    expect(within(backlog).getByText("ready")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "In progress" })).getByText("assigned")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Needs attention" })).getByText("awaiting approval")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Closed" })).getByText("cancelled")).toBeInTheDocument();
    expect(screen.getAllByRole("button").filter((button) => button.classList.contains("board-card"))).toHaveLength(9);
  });

  it("opens task creation directly from the board", async () => {
    renderWithProviders(<BoardView />, { client: boardClient(), route: "/board" });
    await screen.findByRole("region", { name: "Backlog" });
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(screen.getByRole("dialog", { name: "Create task" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveFocus();
  });

  it("focuses reviews and blockers without changing task state", async () => {
    renderWithProviders(<BoardView />, { client: boardClient(), route: "/board" });
    await screen.findByText("Backlog item");
    const filter = screen.getByRole("button", { name: "Needs attention" });
    await userEvent.click(filter);
    expect(filter).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("In review")).toBeInTheDocument();
    expect(screen.queryByText("Backlog item")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3 tasks")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Backlog item")).toBeInTheDocument();
    expect(filter).toHaveAttribute("aria-pressed", "false");
  });
});
