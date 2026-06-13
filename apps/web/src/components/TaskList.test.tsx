// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { TaskList } from "./TaskList.js";

describe("TaskList", () => {
  it("renders tasks from the snapshot and selects on click", async () => {
    const onSelectTask = vi.fn();
    const client = fakeApi({
      listTasks: async () => [
        taskFixture({ id: "task_1", title: "Build inbox", status: "ready", priority: "p1" }),
        taskFixture({ id: "task_2", title: "Wire WS", status: "backlog" }),
      ],
    });

    renderWithProviders(
      <TaskList projectId="proj_artoo" selectedTaskId={null} onSelectTask={onSelectTask} />,
      { client },
    );

    expect(await screen.findByText("Build inbox")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Build inbox"));
    expect(onSelectTask).toHaveBeenCalledWith("task_1");
  });

  it("shows an empty state", async () => {
    const client = fakeApi({ listTasks: async () => [] });
    renderWithProviders(
      <TaskList projectId="proj_artoo" selectedTaskId={null} onSelectTask={() => undefined} />,
      { client },
    );
    expect(await screen.findByText("No tasks yet.")).toBeInTheDocument();
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
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load tasks.");
  });
});
