// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { TaskList } from "./TaskList.js";

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
});
