// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  fakeApi,
  messageFixture,
  renderWithProviders,
  roomFixture,
  taskFixture,
} from "../test/utils.js";
import { TaskRoom } from "./TaskRoom.js";

describe("TaskRoom", () => {
  it("renders messages for the task's room", async () => {
    const client = fakeApi({
      getTask: async () => ({
        task: taskFixture({ id: "task_1", title: "T", status: "running" }),
        room: roomFixture({ id: "room_1" }),
        runs: [],
        approvals: [],
        artifacts: [],
      }),
      listMessages: async () => ({
        messages: [
          messageFixture({ id: "m1", kind: "text", body: "first" }),
          messageFixture({ id: "m2", kind: "approval_request", payload: { action: "git.push" } }),
        ],
      }),
    });

    renderWithProviders(<TaskRoom taskId="task_1" />, { client });

    expect(await screen.findByText("first")).toBeInTheDocument();
    expect(screen.getByText(/Approval requested: git\.push/)).toBeInTheDocument();
  });

  it("shows an empty state when the room has no messages", async () => {
    const client = fakeApi({
      getTask: async () => ({
        task: taskFixture({ id: "task_1", title: "T", status: "ready" }),
        room: roomFixture({ id: "room_1" }),
        runs: [],
        approvals: [],
        artifacts: [],
      }),
      listMessages: async () => ({ messages: [] }),
    });

    renderWithProviders(<TaskRoom taskId="task_1" />, { client });

    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
  });
});
