// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  fakeApi,
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
});
