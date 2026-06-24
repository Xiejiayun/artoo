// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  bootstrapFixture,
  fakeApi,
  messageFixture,
  renderWithProviders,
  roomFixture,
  runFixture,
  taskFixture,
} from "../test/utils.js";
import { WorkspaceLayout } from "./WorkspaceLayout.js";

function workspaceClient() {
  return fakeApi({
    bootstrap: async () =>
      bootstrapFixture({
        user: {
          id: "user_1",
          email: "jeremy@example.com",
          display_name: "Jeremy",
          role: "owner",
        },
      }),
    listTasks: async () => ({ tasks: [taskFixture({ id: "task_1", title: "Build inbox", status: "review" })] }),
    listApprovals: async () => ({ approvals: [] }),
    getTask: async () => ({
      task: taskFixture({ id: "task_1", title: "Build inbox", status: "review" }),
      room: roomFixture({ id: "room_1" }),
      runs: [runFixture({ id: "run_1", status: "completed" })],
      approvals: [],
      artifacts: [],
    }),
    listMessages: async () => ({
      messages: [messageFixture({ id: "m1", kind: "text", body: "agent says hi" })],
    }),
  });
}

describe("WorkspaceLayout", () => {
  it("loads bootstrap, lists tasks, and selecting one shows room + detail", async () => {
    renderWithProviders(<WorkspaceLayout />, { client: workspaceClient() });

    expect(await screen.findByRole("heading", { name: "artoo" })).toBeInTheDocument();
    expect(screen.getByText("No task selected")).toBeInTheDocument();

    await userEvent.click(await screen.findByText("Build inbox"));

    expect(await screen.findByText("agent says hi")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Build inbox", level: 2 })).toBeInTheDocument();
  });
});
