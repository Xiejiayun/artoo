// @vitest-environment jsdom
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

function bootstrap() {
  return bootstrapFixture();
}

const task = taskFixture({ id: "task_1", title: "Audited task", status: "review" });

describe("RunsAuditPage", () => {
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
