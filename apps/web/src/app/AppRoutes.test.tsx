// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  fakeApi,
  renderWithProviders,
  roomFixture,
  runFixture,
  taskFixture,
} from "../test/utils.js";
import { AppRoutes } from "./AppRoutes.js";

function appClient() {
  return fakeApi({
    bootstrap: async () => ({
      organization: { id: "org_default", name: "Org" },
      user: { id: "user_1", email: "j@x.com", display_name: "J", role: "owner" },
      projects: [{ id: "proj_artoo", name: "artoo", default_workspace: null }],
      actor: { type: "user", id: "user_1" },
    }),
    listApprovals: async () => ({ approvals: [] }),
    listTasks: async () => ({
      tasks: [taskFixture({ id: "task_1", title: "Build inbox", status: "review" })],
    }),
    getTask: async () => ({
      task: taskFixture({ id: "task_1", title: "Build inbox", status: "review" }),
      room: roomFixture({ id: "room_1" }),
      runs: [runFixture({ id: "run_1", status: "completed" })],
      approvals: [],
      artifacts: [],
    }),
    listMessages: async () => ({ messages: [] }),
  });
}

describe("AppRoutes", () => {
  it("renders the workspace and primary nav at /", async () => {
    renderWithProviders(<AppRoutes />, { client: appClient(), route: "/" });
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "artoo", level: 1 })).toBeInTheDocument();
  });

  it("shows an explicit placeholder for an unbuilt view", async () => {
    renderWithProviders(<AppRoutes />, { client: appClient(), route: "/skills" });
    expect(await screen.findByRole("heading", { name: "Skills", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/waiting on the #13/)).toBeInTheDocument();
  });

  it("board card click selects the task and returns to the workspace detail", async () => {
    renderWithProviders(<AppRoutes />, { client: appClient(), route: "/board" });
    await userEvent.click(await screen.findByText("Build inbox"));
    expect(await screen.findByRole("heading", { name: "Build inbox", level: 2 })).toBeInTheDocument();
  });
});
