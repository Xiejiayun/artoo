// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
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

  it("shows the full brief and resolves assignment to a readable agent and computer", async () => {
    const client = fakeApi({
      bootstrap: async () => bootstrapFixture(),
      getTask: async () => ({ task: taskFixture({ id: "task_1", title: "A clear brief", status: "running", description: "Make the inbox easy to scan.\nPreserve keyboard navigation.", assignee_type: "agent", assignee_id: "agent_mock_coder", required_capabilities: ["code.modify"] }), room: null, runs: [runFixture({ id: "run_1", status: "running", computer_id: "computer_local_mock" })], approvals: [], artifacts: [] }),
    });
    renderWithProviders(<TaskDetailPanel taskId="task_1" />, { client });
    expect(await screen.findByText("Mock Coder")).toBeInTheDocument();
    expect(screen.getByText("Local Mock")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Description" })).toHaveTextContent("Make the inbox easy to scan. Preserve keyboard navigation.");
    expect(screen.getByRole("region", { name: "Required capabilities" })).toHaveTextContent("Write code");
    expect(screen.queryByText("agent:agent_mock_coder")).not.toBeInTheDocument();
  });

  it("hydrates historical work retention from a fresh task read after reopening", async () => {
    const retention = {
      version: 1 as const, workspace_root: "/Users/Owner/Artoo/run_1", workspace_branch: "artoo/run-1",
      outcome: "completed" as const, reporter_computer_id: "computer_local_mock", event_id: "evt_retained",
      position: 20, sequence: 3, reported_at: "2026-10-01T01:02:03.000Z",
    };
    const getTask = vi.fn(async () => ({
      task: taskFixture({ id: "task_1", title: "Retained work", status: "done" }), room: null, approvals: [], artifacts: [],
      runs: [runFixture({ id: "run_1", status: "completed", computer_id: retention.reporter_computer_id,
        workspace_root: retention.workspace_root, workspace_branch: retention.workspace_branch, workspace_retention: retention })],
    }));
    const client = fakeApi({ getTask, bootstrap: async () => bootstrapFixture(),
      listDependencies: async () => ({ dependencies: [] }) });
    const first = renderWithProviders(<TaskDetailPanel taskId="task_1" />, { client });
    const initialWorkspace = within(await screen.findByRole("region", { name: "Workspace for run_1" }));
    expect(initialWorkspace.getByText("Work retention reported")).toBeInTheDocument();
    expect(await initialWorkspace.findByText("Local Mock")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Runs" })).getByRole("heading", { name: "Runs 1" })).toBeInTheDocument();
    first.unmount();
    renderWithProviders(<TaskDetailPanel taskId="task_1" />, { client });
    const workspace = within(await screen.findByRole("region", { name: "Workspace for run_1" }));
    expect(workspace.getByText(retention.workspace_root)).toBeInTheDocument();
    expect(workspace.getByText("Work retention reported")).toBeInTheDocument();
    expect(screen.queryByText(/output lines/)).not.toBeInTheDocument();
    expect(getTask).toHaveBeenCalledTimes(2);
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
    expect(screen.getByRole("checkbox", { name: "Use an isolated Git worktree" }))
      .toHaveAccessibleDescription(/Completed, failed and stopped work stays there\. Use a new workspace for each isolated execution\./);
    await userEvent.click(assign); expect(assignTask).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(assign).toBeEnabled());
    expect(screen.queryByText(/Execution approval is pending/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Assignment"), "instance_mock_coder");
    await userEvent.click(assign);
    expect(assignTask).toHaveBeenCalledWith("task_1", { mode: "manual", agent_instance_id: "instance_mock_coder" }, expect.any(String));
  });

  it("shows the newest run's computer even when an older run has more ingested events", async () => {
    const bootstrap = bootstrapFixture();
    bootstrap.computers.push({ ...bootstrap.computers[0]!, id: "new_computer", display_name: "New execution computer" });
    renderWithProviders(<TaskDetailPanel taskId="task_1" />, { client: fakeApi({
      bootstrap: async () => bootstrap,
      getTask: async () => ({ task: taskFixture({ id: "task_1", title: "Latest execution", status: "done" }), room: null, approvals: [], artifacts: [], runs: [
        runFixture({ id: "old_run", status: "completed", computer_id: "computer_local_mock", created_at: "2026-09-01T00:00:00Z", sequence: 100 }),
        runFixture({ id: "new_run", status: "completed", computer_id: "new_computer", created_at: "2026-10-01T00:00:00Z", sequence: 2 }),
      ] }),
    }) });
    expect(await screen.findByText("New execution computer")).toBeInTheDocument();
    expect(screen.queryByText("Local Mock")).not.toBeInTheDocument();
  });
});
