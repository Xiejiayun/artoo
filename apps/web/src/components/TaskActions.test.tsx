// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "@artoo/domain";
import { ApiClientError } from "../api/client.js";

import { approvalFixture, bootstrapFixture, createTestQueryClient, fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { queryKeys } from "../app/queryKeys.js";
import { TaskActions } from "./TaskActions.js";

describe("TaskActions", () => {
  it("Mark ready calls markReady with an idempotency key (backlog)", async () => {
    const markReady = vi
      .fn()
      .mockResolvedValue({ task: taskFixture({ id: "task_1", title: "T", status: "ready" }) });
    const client = fakeApi({ markReady });
    renderWithProviders(<TaskActions task={taskFixture({ id: "task_1", title: "T", status: "backlog" })} approvals={[]} />, {
      client,
    });

    await userEvent.click(screen.getByRole("button", { name: "Mark ready" }));

    const [id, key] = markReady.mock.calls[0] as [string, string];
    expect(id).toBe("task_1");
    expect(key.length).toBeGreaterThan(0);
  });

  it("Assign calls assignTask in auto mode (ready)", async () => {
    const assignTask = vi
      .fn()
      .mockResolvedValue({ run: { id: "run_1" }, scheduler_decision: { reason: "x", score: 1 } });
    const client = fakeApi({ assignTask });
    renderWithProviders(<TaskActions task={taskFixture({ id: "task_1", title: "T", status: "ready" })} approvals={[]} />, {
      client,
    });

    await userEvent.click(screen.getByRole("button", { name: "Assign" }));

    const [id, body, key] = assignTask.mock.calls[0] as [string, { mode: string }, string];
    expect(id).toBe("task_1");
    expect(body.mode).toBe("auto");
    expect(body).not.toHaveProperty("branch_backed");
    expect(key.length).toBeGreaterThan(0);
  });

  it("opts into an isolated worktree through UI and retains its instance and checkbox after failure", async () => {
    const assignTask = vi.fn().mockRejectedValueOnce(new ApiClientError("conflict", "Workspace is already in use", 409))
      .mockResolvedValue({ run: { id: "new_run" }, scheduler_decision: { reason: "selected", score: 1 } });
    renderWithProviders(<TaskActions task={taskFixture({ id: "task_1", title: "T", status: "ready" })} approvals={[]} />,
      { client: fakeApi({ assignTask, bootstrap: async () => bootstrapFixture() }) });
    await screen.findByRole("option", { name: /Mock Coder/ });
    const checkbox = screen.getByRole("checkbox", { name: "Use an isolated Git worktree" });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAccessibleDescription(/Git repository configured on the execution computer and an unused workspace path/);
    await userEvent.selectOptions(screen.getByLabelText("Assignment"), "instance_mock_coder");
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Workspace is already in use");
    expect(checkbox).toBeChecked();
    expect(screen.getByLabelText("Assignment")).toHaveValue("instance_mock_coder");
    expect(assignTask).toHaveBeenCalledWith("task_1", { mode: "manual", agent_instance_id: "instance_mock_coder", branch_backed: true }, expect.any(String));
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(assignTask).toHaveBeenCalledTimes(2));
    expect(assignTask).toHaveBeenLastCalledWith("task_1", { mode: "manual", agent_instance_id: "instance_mock_coder" }, expect.any(String));
  });

  it("sends worktree opt-in for automatic assignment as well", async () => {
    const assignTask = vi.fn().mockResolvedValue({ run: { id: "new_run" }, scheduler_decision: { reason: "auto", score: 1 } });
    renderWithProviders(<TaskActions task={taskFixture({ id: "task_1", title: "T", status: "ready" })} approvals={[]} />,
      { client: fakeApi({ assignTask, bootstrap: async () => bootstrapFixture() }) });
    await userEvent.click(screen.getByRole("checkbox", { name: "Use an isolated Git worktree" }));
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(assignTask).toHaveBeenCalledWith("task_1", { mode: "auto", branch_backed: true }, expect.any(String));
  });

  it("Retry calls retryTask (blocked)", async () => {
    const retryTask = vi
      .fn()
      .mockResolvedValue({ task: taskFixture({ id: "task_1", title: "T", status: "ready" }) });
    const client = fakeApi({ retryTask });
    renderWithProviders(<TaskActions task={taskFixture({ id: "task_1", title: "T", status: "blocked" })} approvals={[]} />, {
      client,
    });

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryTask).toHaveBeenCalledTimes(1);
  });

  it("distinguishes the same agent on different computers and preserves the selected instance", async () => {
    const bootstrap = bootstrapFixture();
    bootstrap.computers.push({ ...bootstrap.computers[0]!, id: "computer_mac", display_name: "Studio Mac", status: "offline" });
    bootstrap.agent_instances.push({ ...bootstrap.agent_instances[0]!, id: "instance_mac", computer_id: "computer_mac" });
    const assignTask = vi.fn().mockResolvedValue({ run: { id: "run_1" }, scheduler_decision: { reason: "manual", score: 1 } });
    renderWithProviders(<TaskActions task={taskFixture({ id: "task_1", title: "T", status: "ready" })} approvals={[]} />, { client: fakeApi({ bootstrap: async () => bootstrap, assignTask }) });
    await screen.findByRole("option", { name: "Mock Coder · Studio Mac · mock · offline" });
    expect(screen.getByRole("option", { name: "Mock Coder · Local Mock · mock · online" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Assignment"), "instance_mac");
    expect(screen.getByText("This computer is offline. Check its connection before assigning work.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(assignTask).toHaveBeenCalledWith("task_1", { mode: "manual", agent_instance_id: "instance_mac" }, expect.any(String));
  });

  it.each(["removed", "disabled", "disabled by configuration"] as const)("keeps a %s manual destination visible and requires a deliberate replacement", async (change) => {
    const bootstrap = bootstrapFixture();
    const queryClient = createTestQueryClient();
    const assignTask = vi.fn().mockResolvedValue({ run: { id: "run_1" }, scheduler_decision: { reason: "auto", score: 1 } });
    renderWithProviders(<TaskActions task={taskFixture({ id: "task_1", title: "T", status: "ready" })} approvals={[]} />, { queryClient, client: fakeApi({ bootstrap: async () => bootstrap, assignTask }) });
    await screen.findByRole("option", { name: /Mock Coder/ });
    const selection = screen.getByLabelText("Assignment");
    await userEvent.selectOptions(selection, "instance_mock_coder");
    await act(async () => {
      queryClient.setQueryData(queryKeys.bootstrap, { ...bootstrap, agent_instances: change === "removed" ? [] : bootstrap.agent_instances.map((instance) => ({ ...instance, ...(change === "disabled" ? { status: "disabled" } : { config: { ...instance.config, enabled: false } }) })) });
    });

    expect(await screen.findByRole("option", { name: /Mock Coder.*no longer available/ })).toBeDisabled();
    expect(selection).toHaveValue("instance_mock_coder");
    const assign = screen.getByRole("button", { name: "Assign" });
    expect(assign).toBeDisabled();
    expect(assign).toHaveAccessibleDescription(/Choose another agent or Automatic selection/);
    await userEvent.click(assign);
    expect(assignTask).not.toHaveBeenCalled();

    await userEvent.selectOptions(selection, "");
    expect(assign).toBeEnabled();
    await userEvent.click(assign);
    expect(assignTask).toHaveBeenCalledWith("task_1", { mode: "auto" }, expect.any(String));
  });

  it("renders nothing for non-actionable statuses (review)", () => {
    const client = fakeApi({});
    const { container } = renderWithProviders(
      <TaskActions task={taskFixture({ id: "task_1", title: "T", status: "review" })} approvals={[]} />,
      { client },
    );
    expect(container).toBeEmptyDOMElement();
  });
});

function executionGate(patch: Partial<Approval> = {}): Approval {
  return approvalFixture({ id: "gate_current", status: "pending", action: "execution.start", payload_ref: "execution-gate/current", run_id: null, ...patch });
}

describe("execution approval assignment gate", () => {
  const task = taskFixture({ id: "task_1", title: "Gated task", status: "ready" });

  it.each([
    { approval: executionGate(), reason: /Execution approval is pending/ },
    { approval: executionGate({ status: "needs_more_info" }), reason: /Execution approval needs more information/ },
    { approval: executionGate({ status: "rejected" }), reason: /Execution approval was rejected/ },
    { approval: executionGate({ status: "expired" }), reason: /Execution approval has expired/ },
    { approval: executionGate({ status: "approved", run_id: "run_previous" }), reason: /approval was used by a previous run/ },
  ])("blocks $approval.status approval with run $approval.run_id and explains recovery", async ({ approval, reason }) => {
    const assignTask = vi.fn();
    renderWithProviders(<TaskActions task={task} approvals={[approval]} />, { client: fakeApi({ assignTask, bootstrap: async () => bootstrapFixture() }) });
    const assign = screen.getByRole("button", { name: "Assign" });
    expect(assign).toBeDisabled();
    expect(assign).toHaveAccessibleDescription(reason);
    expect(screen.getByRole("status")).toHaveTextContent(reason);
    await userEvent.click(assign);
    expect(assignTask).not.toHaveBeenCalled();
    expect(screen.getByText("Require approval before execution")).toBeInTheDocument();
  });

  it.each([
    { name: "no gate", approvals: [] },
    { name: "another kind of pending approval", approvals: [approvalFixture({ id: "other", status: "pending", action: "git.push" })] },
    { name: "another task's gate", approvals: [executionGate({ task_id: "task_other" })] },
    { name: "approved unused current gate", approvals: [executionGate({ status: "approved" })] },
    { name: "superseded history with an approved current gate", approvals: [executionGate({ id: "old", status: "rejected", payload_ref: "execution-gate/superseded" }), executionGate({ status: "approved" })] },
  ])("preserves assignment for $name without restricting team members", async ({ approvals }) => {
    const assignTask = vi.fn().mockResolvedValue({ run: { id: "run_1" }, scheduler_decision: { reason: "eligible", score: 1 } });
    const bootstrap = bootstrapFixture();
    bootstrap.user.role = "member";
    renderWithProviders(<TaskActions task={task} approvals={approvals} />, { client: fakeApi({ assignTask, bootstrap: async () => bootstrap }) });
    await screen.findByRole("option", { name: /Mock Coder/ });
    const assign = screen.getByRole("button", { name: "Assign" });
    expect(assign).toBeEnabled();
    await userEvent.click(assign);
    expect(assignTask).toHaveBeenCalledWith("task_1", { mode: "auto" }, expect.any(String));
  });

  it.each([
    { name: "superseded history without a current gate", approvals: [executionGate({ status: "approved", payload_ref: "execution-gate/superseded" })] },
    { name: "multiple current gates", approvals: [executionGate({ id: "first", status: "approved" }), executionGate({ id: "second", status: "approved" })] },
    { name: "unrecognized current marker", approvals: [executionGate({ status: "approved", payload_ref: undefined })] },
    { name: "missing consumption metadata", approvals: [executionGate({ status: "approved", run_id: undefined })] },
  ])("keeps assignment blocked for $name", ({ approvals }) => {
    renderWithProviders(<TaskActions task={task} approvals={approvals} />, { client: fakeApi({ bootstrap: async () => bootstrapFixture() }) });
    const assign = screen.getByRole("button", { name: "Assign" });
    expect(assign).toBeDisabled();
    expect(assign).toHaveAccessibleDescription(/Execution approval could not be verified/);
  });

  it("requires a replacement review even when its superseded request was approved", () => {
    const approvals = [executionGate({ id: "prior", status: "approved", payload_ref: "execution-gate/superseded" }), executionGate()];
    renderWithProviders(<TaskActions task={task} approvals={approvals} />, { client: fakeApi({ bootstrap: async () => bootstrapFixture() }) });
    const assign = screen.getByRole("button", { name: "Assign" });
    expect(assign).toBeDisabled();
    expect(assign).toHaveAccessibleDescription(/Execution approval is pending/);
  });
});
