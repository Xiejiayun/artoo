// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { bootstrapFixture, fakeApi, renderWithProviders, runFixture, taskFixture } from "../test/utils.js";
import { controlViewFixture } from "../test/controlViewFixture.js";
import { OverviewPage } from "./OverviewPage.js";

it("shows the actual Agent and machine, project totals, and on-demand reserved capacity", async () => {
  const task = taskFixture({ id: "work", title: "Shared implementation", status: "running" });
  const run = runFixture({
    id: "run",
    task_id: task.id,
    status: "running",
    agent_instance_id: "instance_mock_coder",
    computer_id: "computer_local_mock",
  });
  const view = controlViewFixture({
    tasks: [
      {
        task,
        latest_run: run,
        execution_lease: null,
        execution_request: null,
        queue_metadata: null,
        last_assignment: null,
      },
    ],
  });
  view.summary.total_tasks = 125;
  view.summary.tasks_by_status.running = 1;
  const getProjectControlView = vi
    .fn()
    .mockImplementation(async (_id: string, options: { capacity?: boolean }) =>
      options.capacity
        ? { ...view, capacity: { ...view.capacity, source: "reservation_snapshot", occupied: 2 } }
        : view,
    );
  renderWithProviders(<OverviewPage />, {
    client: fakeApi({
      bootstrap: async () => bootstrapFixture(),
      getProjectControlView,
      listDaemons: async () => ({ daemons: [] }),
    }),
  });
  expect(await screen.findAllByText("Shared implementation")).not.toHaveLength(0);
  expect(screen.getByText("Mock Coder")).toBeInTheDocument();
  expect(screen.getAllByText(/Local Mock/).length).toBeGreaterThan(0);
  expect(screen.getByText(/Project-wide totals/)).toHaveTextContent("1 loaded tasks");
  expect(screen.getByText("125")).toBeInTheDocument();
  expect(screen.getByText("Observed occupied slots: Unknown")).toBeInTheDocument();
  expect(getProjectControlView).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Observe occupied capacity" }));
  expect(await screen.findByText("Observed occupied slots: 2")).toBeInTheDocument();
  expect(getProjectControlView).toHaveBeenLastCalledWith("proj_artoo", { limit: 1, capacity: true });
});
