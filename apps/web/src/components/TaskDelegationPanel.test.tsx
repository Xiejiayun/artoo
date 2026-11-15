// @vitest-environment jsdom
import type { Task, TaskDelegationTreeV1 } from "@artoo/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ApiClientError } from "../api/client.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSelection } from "../app/SelectionContext.js";
import { createTestQueryClient, fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { TaskDelegationPanel } from "./TaskDelegationPanel.js";

const root = taskFixture({ id: "root", title: "Parent outcome", status: "ready" });
const rootNode = { task_id: root.id, parent_task_id: null, depth: 0, title: root.title, status: root.status };
function tree(partial: Partial<TaskDelegationTreeV1> = {}): TaskDelegationTreeV1 {
  return {
    version: 1,
    root_task_id: root.id,
    selected_task_id: root.id,
    creation_enabled: true,
    limits: { max_depth: 3, max_tasks: 30 },
    nodes: [rootNode],
    ...partial,
  };
}
function Panel({ task = root, initiallyExpanded = false }: { task?: Task; initiallyExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const { selectedTaskId } = useSelection();
  return (
    <>
      <TaskDelegationPanel task={task} expanded={expanded} onExpandedChange={setExpanded} />
      <output aria-label="Selected task">{selectedTaskId ?? task.id}</output>
    </>
  );
}

describe("TaskDelegationPanel", () => {
  it("loads on demand, renders actual nested relationships and selects a task without executing it", async () => {
    const getTaskDelegationTree = vi.fn().mockResolvedValue(
      tree({
        nodes: [
          rootNode,
          { task_id: "child", parent_task_id: "root", depth: 1, title: "Child work", status: "running" },
          { task_id: "leaf", parent_task_id: "child", depth: 2, title: "Leaf work", status: "done" },
        ],
      }),
    );
    const createTask = vi.fn();
    const cancelRun = vi.fn();
    renderWithProviders(<Panel />, { client: fakeApi({ getTaskDelegationTree, createTask, cancelRun }) });
    expect(getTaskDelegationTree).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Show delegation tree" }));
    const list = await screen.findByRole("list", { name: "Delegation tree" });
    expect(screen.getByText("3 / 30 tasks · Selected depth 0 / 3")).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: root.title })).toHaveAttribute("aria-current", "true");
    const child = within(list).getByRole("button", { name: "Child work" });
    expect(within(child.closest("li")!).getByRole("button", { name: "Leaf work" })).toBeInTheDocument();
    expect(within(list).getByText("running")).toBeInTheDocument();
    expect(within(list).getByText("done")).toBeInTheDocument();
    await userEvent.click(child);
    expect(screen.getByLabelText("Selected task")).toHaveTextContent("child");
    expect(createTask).not.toHaveBeenCalled();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "disabled project",
      data: tree({ creation_enabled: false }),
      task: root,
      reason: /disabled for this project/,
    },
    {
      name: "terminal parent",
      data: tree({ nodes: [{ ...rootNode, status: "done" }] }),
      task: root,
      reason: /Completed or cancelled/,
    },
    {
      name: "maximum depth",
      data: tree({
        selected_task_id: "leaf",
        nodes: [
          rootNode,
          { task_id: "first", parent_task_id: "root", depth: 1, title: "First", status: "ready" },
          { task_id: "second", parent_task_id: "first", depth: 2, title: "Second", status: "ready" },
          { task_id: "leaf", parent_task_id: "second", depth: 3, title: "Leaf", status: "ready" },
        ],
      }),
      task: taskFixture({ id: "leaf", title: "Leaf", status: "ready" }),
      reason: /maximum delegation depth of 3/,
    },
    {
      name: "full historical tree",
      data: tree({
        nodes: [
          rootNode,
          ...Array.from({ length: 29 }, (_, index) => ({
            task_id: `child-${index}`,
            parent_task_id: "root",
            depth: 1,
            title: `Done child ${index}`,
            status: "done" as const,
          })),
        ],
      }),
      task: root,
      reason: /limit of 30 tasks, including completed and cancelled/,
    },
  ])("explains why creation is blocked for $name while keeping history readable", async ({ data, task, reason }) => {
    const createTask = vi.fn();
    renderWithProviders(<Panel task={task} initiallyExpanded />, {
      client: fakeApi({ getTaskDelegationTree: async () => data, createTask }),
    });
    await screen.findByRole("list", { name: "Delegation tree" });
    const delegate = screen.getByRole("button", { name: "Delegate task" });
    expect(delegate).toBeDisabled();
    expect(delegate).toHaveAccessibleDescription(reason);
    await userEvent.click(delegate);
    expect(createTask).not.toHaveBeenCalled();
  });

  it("surfaces fetch failure, blocks stale creation and recovers only after a successful refresh", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(queryKeys.delegationTree(root.project_id, root.id), tree());
    const getTaskDelegationTree = vi
      .fn()
      .mockRejectedValueOnce(new Error("Delegation access denied"))
      .mockResolvedValue(tree());
    renderWithProviders(<Panel initiallyExpanded />, { client: fakeApi({ getTaskDelegationTree }), queryClient });
    expect(await screen.findByRole("alert")).toHaveTextContent("Delegation access denied");
    expect(screen.getByRole("button", { name: "Delegate task" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh delegation tree" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delegate task" })).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("submits explicit parent identity, retains a rejected brief and invalidates every cached view of the tree on success", async () => {
    const queryClient = createTestQueryClient();
    const otherKey = queryKeys.delegationTree(root.project_id, "other-child");
    queryClient.setQueryData(otherKey, tree({ selected_task_id: "other-child" }));
    queryClient.setQueryData(queryKeys.task(root.id), { task: root });
    const created = taskFixture({ id: "new-child", title: "Delegated brief", status: "backlog" });
    const createTask = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError("conflict", "Delegation tree is busy; retry the complete operation", 409),
      )
      .mockResolvedValue({ task: created });
    renderWithProviders(<Panel initiallyExpanded />, {
      client: fakeApi({ getTaskDelegationTree: async () => tree(), createTask }),
      queryClient,
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Delegate task" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Delegate task" }));
    const dialog = within(screen.getByRole("dialog", { name: "Create delegated task" }));
    expect(dialog.getByText(/Parent task:/)).toHaveTextContent(root.title);
    await userEvent.type(dialog.getByLabelText("Title"), created.title);
    await userEvent.type(dialog.getByLabelText("Acceptance criteria (one per line)"), "Preserve the review gate");
    await userEvent.selectOptions(dialog.getByLabelText("Priority"), "p1");
    await userEvent.click(dialog.getByRole("button", { name: "Create task" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("Delegation tree is busy");
    expect(dialog.getByLabelText("Title")).toHaveValue(created.title);
    expect(createTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        project_id: root.project_id,
        title: created.title,
        priority: "p1",
        acceptance_criteria: ["Preserve the review gate"],
        delegation: { version: 1, parent_task_id: root.id },
      }),
      expect.any(String),
    );
    await userEvent.click(dialog.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("Selected task")).toHaveTextContent(created.id);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.task(root.id))?.isInvalidated).toBe(true);
  });
});
