// @vitest-environment jsdom
import { GoalSchema } from "@artoo/domain";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  approvalFixture,
  artifactFixture,
  auditBundleFixture,
  auditEventFixture,
  bootstrapFixture,
  fakeApi,
  renderWithProviders,
  runFixture,
  schedulerDecisionFixture,
  taskFixture,
} from "../test/utils.js";
import { RunsAuditPage } from "./RunsAuditPage.js";
import { controlViewFixture } from "../test/controlViewFixture.js";

function bootstrap() {
  return bootstrapFixture();
}

const task = taskFixture({ id: "task_1", title: "Audited task", status: "review" });
const goal = GoalSchema.parse({
  id: "goal_selected", organization_id: "org_default", project_id: "proj_artoo", room_id: null,
  owner_user_id: "user_1", title: "Shared delivery", objective: "Complete the selected goal", priority: "p2", status: "draft",
  acceptance_criteria: [], stop_conditions: {}, budgets: {}, current_plan_id: null, running_since: null,
  elapsed_cost_usd: null, retry_count: 0, created_at: "2026-11-16", updated_at: "2026-11-16",
});

describe("RunsAuditPage", () => {
  it("resolves a shared Goal link across projects and keeps other goals out of its execution picker", async () => {
    const scoped = taskFixture({ id: "task_scoped", title: "Selected goal work", goal_id: goal.id });
    const unrelated = taskFixture({ id: "task_unrelated", title: "Other goal work", goal_id: "goal_other" });
    renderWithProviders(<RunsAuditPage />, { route: `/runs?goal=${goal.id}`, client: fakeApi({
      bootstrap: async () => bootstrapFixture({ projects: [{ id: "proj_first", name: "First project", default_workspace: null }, ...bootstrapFixture().projects] }),
      listGoals: async (projectId) => ({ goals: projectId === goal.project_id ? [goal] : [] }),
      getGoal: async () => ({ goal }),
      listTasks: async (projectId) => ({ tasks: projectId === goal.project_id ? [scoped, unrelated] : [] }),
      getTaskAuditBundle: async () => ({ bundle: auditBundleFixture({ task: scoped }) }),
    }) });
    const picker = await screen.findByRole("navigation", { name: "Tasks" });
    await userEvent.click(await within(picker).findByRole("button", { name: /Selected goal work/ }));
    expect(within(picker).queryByRole("button", { name: /Other goal work/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Task summary" })).toHaveTextContent(scoped.title);
    expect(screen.getByText(`Goal: ${goal.title}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show all project goals" }));
    expect(await within(picker).findByRole("button", { name: /Other goal work/ })).toBeInTheDocument();
  });

  it("does not render or export a linked task's evidence from another Goal", async () => {
    const unrelated = taskFixture({ id: "task_unrelated", title: "Other goal work", goal_id: "goal_other" });
    renderWithProviders(<RunsAuditPage />, { route: `/runs?goal=${goal.id}&task=${unrelated.id}&project=${goal.project_id}`, client: fakeApi({
      bootstrap: async () => bootstrap(), listGoals: async () => ({ goals: [goal] }), listTasks: async () => ({ tasks: [unrelated] }),
      getTask: async () => ({ task: unrelated, room: null, runs: [], artifacts: [], approvals: [] }),
      getTaskAuditBundle: async () => ({ bundle: auditBundleFixture({ task: unrelated }) }),
    }) });
    expect(await screen.findByText("This task is outside the current execution scope")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Task summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Run console" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export task evidence" })).not.toBeInTheDocument();
  });

  it("keeps independent review executions linked through the authorized control projection", async () => {
    const review = taskFixture({ id: "task_peer_review", title: "Recorded peer review execution", goal_id: null });
    renderWithProviders(<RunsAuditPage />, { route: `/runs?goal=${goal.id}`, client: fakeApi({
      bootstrap: async () => bootstrap(), listGoals: async () => ({ goals: [goal] }), listTasks: async () => ({ tasks: [review] }),
      getProjectControlView: async () => controlViewFixture({ tasks: [{ task: { ...review, goal_id: goal.id }, latest_run: null, execution_lease: null, execution_request: null, queue_metadata: null, last_assignment: null }] }),
      getTaskAuditBundle: async () => ({ bundle: auditBundleFixture({ task: review }) }),
    }) });
    await userEvent.click(await screen.findByRole("button", { name: /Recorded peer review execution/ }));
    expect(await screen.findByRole("region", { name: "Task summary" })).toHaveTextContent(review.title);
    expect(screen.queryByText("This task is outside the current execution scope")).not.toBeInTheDocument();
  });

  it("announces loading while runs and audit bootstrap is pending", () => {
    const client = fakeApi({
      bootstrap: () => new Promise(() => undefined),
    });

    renderWithProviders(<RunsAuditPage />, { client, route: "/runs" });

    expect(screen.getByRole("status", { name: "Loading runs and audit" })).toBeInTheDocument();
  });

  it("announces loading while a selected audit bundle is pending", async () => {
    const client = fakeApi({
      bootstrap: async () => bootstrap(),
      listTasks: async () => ({ tasks: [task] }),
      getTaskAuditBundle: () => new Promise(() => undefined),
    });

    renderWithProviders(<RunsAuditPage />, { client, route: "/runs" });

    await userEvent.click(await screen.findByRole("button", { name: /Audited task/ }));
    expect(await screen.findByRole("status", { name: "Loading audit bundle" })).toBeInTheDocument();
  });

  it("lists tasks and renders the selected task's audit bundle", async () => {
    const bundle = auditBundleFixture({
      task,
      runs: [runFixture({ id: "run_1", status: "completed" })],
      artifacts: [artifactFixture({ id: "art_1", type: "pull_request", uri: "https://x/pr/1" })],
      approvals: [approvalFixture({ id: "appr_1", status: "approved" })],
      scheduler_decisions: [schedulerDecisionFixture({ id: "sched_1" })],
      events: [auditEventFixture({ id: "e1", type: "task.assigned", position: 1 })],
    });
    const client = fakeApi({
      bootstrap: async () => bootstrap(),
      listTasks: async () => ({ tasks: [task] }),
      getTaskAuditBundle: async () => ({ bundle }),
    });
    renderWithProviders(<RunsAuditPage />, { client, route: "/runs" });

    await userEvent.click(await screen.findByRole("button", { name: /Audited task/ }));

    expect(await screen.findByRole("region", { name: "Runs" })).toHaveTextContent("run_1");
    expect(screen.getByRole("region", { name: "Artifacts" })).toHaveTextContent("https://x/pr/1");
    expect(screen.getByRole("region", { name: "Approvals" })).toHaveTextContent("approved");
    expect(screen.getByRole("region", { name: "Scheduler decisions" })).toHaveTextContent(
      "capability_match_and_idle",
    );
    expect(screen.getByRole("region", { name: "Event log" })).toHaveTextContent("task.assigned");
  });

  it("orders the event log by numeric position", async () => {
    const bundle = auditBundleFixture({
      events: [
        auditEventFixture({ id: "e2", type: "run.completed", position: 2 }),
        auditEventFixture({ id: "e1", type: "task.assigned", position: 1 }),
        auditEventFixture({ id: "e3", type: "review.completed", position: 3 }),
      ],
    });
    const client = fakeApi({
      bootstrap: async () => bootstrap(),
      listTasks: async () => ({ tasks: [task] }),
      getTaskAuditBundle: async () => ({ bundle }),
    });
    renderWithProviders(<RunsAuditPage />, { client, route: "/runs" });

    await userEvent.click(await screen.findByRole("button", { name: /Audited task/ }));
    const log = await screen.findByRole("region", { name: "Event log" });
    const positions = within(log)
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("data-position"));
    expect(positions).toEqual(["1", "2", "3"]);
  });

  it("is strictly read-only — the bundle has no action buttons", async () => {
    const client = fakeApi({
      bootstrap: async () => bootstrap(),
      listTasks: async () => ({ tasks: [task] }),
      getTaskAuditBundle: async () => ({ bundle: auditBundleFixture({ task }) }),
    });
    renderWithProviders(<RunsAuditPage />, { client, route: "/runs" });

    await userEvent.click(await screen.findByRole("button", { name: /Audited task/ }));
    const region = await screen.findByRole("region", { name: "Audit bundle" });
    expect(within(region).queryByRole("button")).toBeNull();
  });

  it("filters tasks while preserving the evidence already selected", async () => {
    const done = taskFixture({ id: "done_task", title: "Closed release", status: "done" });
    const blocked = taskFixture({ id: "blocked_task", title: "Needs review", status: "blocked" });
    renderWithProviders(<RunsAuditPage />, { client: fakeApi({ bootstrap: async () => bootstrap(), listTasks: async () => ({ tasks: [done, blocked] }), getTaskAuditBundle: async () => ({ bundle: auditBundleFixture({ task: done }) }) }), route: "/runs" });
    await userEvent.click(await screen.findByRole("button", { name: /Closed release/ }));
    expect(await screen.findByRole("region", { name: "Task summary" })).toHaveTextContent("Closed release");
    await userEvent.selectOptions(screen.getByLabelText("Task view"), "attention");
    const picker = screen.getByRole("navigation", { name: "Tasks" });
    expect(within(picker).queryByRole("button", { name: /Closed release/ })).not.toBeInTheDocument();
    expect(within(picker).getByRole("button", { name: /Needs review/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Task summary" })).toHaveTextContent("Closed release");
    await userEvent.type(screen.getByLabelText("Search tasks"), "no matching task");
    expect(within(picker).getByText("No tasks found")).toBeInTheDocument();
  });
});
