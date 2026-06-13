// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { WorkspaceLayout } from "./WorkspaceLayout.js";

function workspaceClient() {
  return fakeApi({
    bootstrap: async () => ({
      organization: { id: "org_default", name: "Org" },
      user: { id: "user_1", display_name: "Jeremy", role: "owner" },
      project: { id: "proj_artoo", name: "artoo", default_workspace: null },
      actor: { type: "user", id: "user_1" },
    }),
    listTasks: async () => ({
      tasks: [taskFixture({ id: "task_1", title: "Build inbox", status: "ready" })],
    }),
    listApprovals: async () => ({ approvals: [] }),
  });
}

describe("WorkspaceLayout", () => {
  it("loads bootstrap, lists tasks, and selecting one reveals the room pane", async () => {
    renderWithProviders(<WorkspaceLayout />, { client: workspaceClient() });

    expect(await screen.findByRole("heading", { name: "artoo" })).toBeInTheDocument();
    expect(screen.getByText("Select a task to view its room.")).toBeInTheDocument();

    await userEvent.click(await screen.findByText("Build inbox"));

    expect(screen.getByTestId("task-room-placeholder")).toHaveTextContent("task_1");
    expect(screen.getByTestId("task-detail-placeholder")).toHaveTextContent("task_1");
  });
});
