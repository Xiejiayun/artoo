// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  fakeApi,
  approvalFixture,
  bootstrapFixture,
  renderWithProviders,
  roomFixture,
  runFixture,
  taskFixture,
} from "../test/utils.js";
import { TaskDetailPanel } from "./TaskDetailPanel.js";

describe("TaskDetailPanel", () => {
  it("announces loading while detail content is skeletonized", () => {
    const client = fakeApi({
      getTask: () => new Promise(() => undefined),
    });

    renderWithProviders(<TaskDetailPanel taskId="task_1" />, { client });

    expect(screen.getByRole("status", { name: "Loading detail" })).toBeInTheDocument();
  });

  it("renders task fields, acceptance criteria and the run timeline", async () => {
    const client = fakeApi({
      getTask: async () => ({
        task: taskFixture({
          id: "task_1",
          title: "Build inbox",
          status: "review",
          acceptance_criteria: ["see pending", "resolve updates room"],
        }),
        room: roomFixture({ id: "room_1" }),
        runs: [runFixture({ id: "run_1", status: "completed" })],
        approvals: [],
        artifacts: [],
      }),
    });

    renderWithProviders(<TaskDetailPanel taskId="task_1" />, { client });

    expect(
      await screen.findByRole("heading", { name: "Build inbox", level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText("see pending")).toBeInTheDocument();
    expect(screen.getByText("resolve updates room")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
  });

  it("keeps assignment blocked until the current approval is confirmed and the snapshot refreshes", async () => {
    let approval = approvalFixture({ id: "approval_current", status: "pending", action: "execution.start", payload_ref: "execution-gate/current", run_id: null });
    const assignTask = vi.fn().mockResolvedValue({ run: { id: "run_1" }, scheduler_decision: { reason: "approved", score: 1 } });
    const client = fakeApi({
      bootstrap: async () => bootstrapFixture(),
      getTask: async () => ({ task: taskFixture({ id: "task_1", title: "Gated task", status: "ready" }), room: null, runs: [], artifacts: [], approvals: [approval] }),
      listDependencies: async () => ({ dependencies: [] }),
      resolveApproval: async () => { approval = { ...approval, status: "approved" }; return { approval }; },
      assignTask,
    });
    renderWithProviders(<TaskDetailPanel taskId="task_1" />, { client });
    const assign = await screen.findByRole("button", { name: "Assign" });
    expect(assign).toBeDisabled();
    await userEvent.click(assign); expect(assignTask).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(assign).toBeEnabled());
    expect(screen.queryByText(/Execution approval is pending/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Assignment"), "instance_mock_coder");
    await userEvent.click(assign);
    expect(assignTask).toHaveBeenCalledWith("task_1", { mode: "manual", agent_instance_id: "instance_mock_coder" }, expect.any(String));
  });
});
