// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { TASK_PAGE_SIZE, TaskList } from "./TaskList.js";

function twoTaskClient() {
  return fakeApi({
    listTasks: async () => ({
      tasks: [
        taskFixture({ id: "task_1", title: "Build inbox", status: "ready", priority: "p1" }),
        taskFixture({ id: "task_2", title: "Wire WS", status: "backlog", priority: "p2" }),
      ],
    }),
  });
}

describe("TaskList", () => {
  it("announces loading while task rows are skeletonized", () => {
    const client = fakeApi({
      listTasks: () => new Promise(() => undefined),
    });

    renderWithProviders(
      <TaskList projectId="proj_artoo" selectedTaskId={null} onSelectTask={() => undefined} />,
      { client },
    );

    expect(screen.getByRole("status", { name: "Loading tasks" })).toBeInTheDocument();
  });

  it("renders tasks from the snapshot and selects on click", async () => {
    const onSelectTask = vi.fn();
    renderWithProviders(
      <TaskList projectId="proj_artoo" selectedTaskId={null} onSelectTask={onSelectTask} />,
      { client: twoTaskClient() },
    );

    expect(await screen.findByText("Build inbox")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Build inbox"));
    expect(onSelectTask).toHaveBeenCalledWith("task_1");
  });

  it("filters rows by the title query and shows a distinct no-match state", async () => {
    renderWithProviders(
      <TaskList projectId="proj_artoo" selectedTaskId={null} onSelectTask={() => undefined} filter="inbox" />,
      { client: twoTaskClient() },
    );

    expect(await screen.findByText("Build inbox")).toBeInTheDocument();
    expect(screen.queryByText("Wire WS")).not.toBeInTheDocument();
  });

  it("shows a no-match empty state when the filter excludes everything", async () => {
    renderWithProviders(
      <TaskList projectId="proj_artoo" selectedTaskId={null} onSelectTask={() => undefined} filter="zzz" />,
      { client: twoTaskClient() },
    );
    expect(await screen.findByText("No matching tasks")).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    const client = fakeApi({ listTasks: async () => ({ tasks: [] }) });
    renderWithProviders(
      <TaskList projectId="proj_artoo" selectedTaskId={null} onSelectTask={() => undefined} />,
      { client },
    );
    expect(await screen.findByText("No tasks yet")).toBeInTheDocument();
  });

  it("shows an error state when the query fails", async () => {
    const client = fakeApi({
      listTasks: async () => {
        throw new Error("boom");
      },
    });
    renderWithProviders(
      <TaskList projectId="proj_artoo" selectedTaskId={null} onSelectTask={() => undefined} />,
      { client },
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load tasks");
  });

  it("caps initial rendered tasks and expands on request", async () => {
    const client = fakeApi({
      listTasks: async () => ({
        tasks: Array.from({ length: TASK_PAGE_SIZE + 3 }, (_, index) =>
          taskFixture({ id: `task_${index + 1}`, title: `Task ${index + 1}`, status: "ready", priority: "p1" }),
        ),
      }),
    });
    renderWithProviders(
      <TaskList projectId="proj_artoo" selectedTaskId={null} onSelectTask={() => undefined} />,
      { client },
    );
    expect(await screen.findByText("Task 1")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(TASK_PAGE_SIZE);
    await userEvent.click(screen.getByRole("button", { name: /Show more tasks/i }));
    expect(screen.getAllByRole("listitem")).toHaveLength(TASK_PAGE_SIZE + 3);
  });
});
