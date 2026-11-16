// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import {
  bootstrapFixture,
  auditBundleFixture,
  createTestQueryClient,
  fakeApi,
  renderWithProviders,
  runFixture,
  taskFixture,
} from "../test/utils.js";
import { queryKeys } from "../app/queryKeys.js";
import { TaskExecutionConsole } from "./TaskExecutionConsole.js";

it("reconciles live output with durable event ids and follows the older-event cursor", async () => {
  const task = taskFixture({ id: "console-task", title: "Live console", status: "running" });
  const run = runFixture({
    id: "console-run",
    task_id: task.id,
    status: "running",
    agent_instance_id: "instance_mock_coder",
    computer_id: "computer_local_mock",
  });
  const event = {
    id: "output-2",
    position: 2,
    type: "run.output",
    actor: { type: "agent", id: "agent_mock_coder" },
    sequence: 2,
    occurred_at: "2026-11-16T00:00:00Z",
    payload: { text: "Durable second line" },
    response_text: null,
  };
  const detail = {
    version: 1 as const,
    agent_id: "agent_mock_coder",
    execution: { run, project_id: task.project_id, task_title: task.title },
    request: null,
    events: [event],
    next_before: 2 as number | null,
  };
  const agentHistoryRun = vi
    .fn()
    .mockResolvedValueOnce(detail)
    .mockResolvedValue({
      ...detail,
      events: [{ ...event, id: "output-1", position: 1, payload: { text: "First line" } }, event],
      next_before: null,
    });
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(queryKeys.runOutputs(task.id), [
    { eventId: event.id, runId: run.id, text: "Durable second line" },
    { eventId: "live-3", runId: run.id, text: "Live third line" },
  ]);
  renderWithProviders(
    <TaskExecutionConsole bundle={auditBundleFixture({ task, runs: [run] })} bootstrap={bootstrapFixture()} />,
    { queryClient, client: fakeApi({ agentHistoryRun }), route: `/runs?task=${task.id}&run=${run.id}` },
  );
  await waitFor(() => expect(screen.getByLabelText("Recorded run output")).toHaveTextContent("Durable second line"));
  expect(screen.getByLabelText("Recorded run output").textContent?.match(/Durable second line/g)).toHaveLength(1);
  expect(screen.getByLabelText("Recorded run output")).toHaveTextContent("Live third line");
  await userEvent.click(screen.getByRole("button", { name: "Load older run events" }));
  await waitFor(() => expect(screen.getByLabelText("Recorded run output")).toHaveTextContent("First line"));
  expect(agentHistoryRun).toHaveBeenLastCalledWith("agent_mock_coder", run.id, { before: 2 });
});

it("does not silently substitute another run when a shared run id is unavailable", () => {
  const task = taskFixture({ id: "one", title: "Completed task", status: "review" });
  renderWithProviders(
    <TaskExecutionConsole
      bundle={auditBundleFixture({ task, runs: [runFixture({ id: "known", status: "completed" })] })}
    />,
    { client: fakeApi({}), route: "/runs?task=one&run=unknown" },
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Run unavailable for this task");
  expect(screen.queryByLabelText("Recorded run output")).not.toBeInTheDocument();
});
