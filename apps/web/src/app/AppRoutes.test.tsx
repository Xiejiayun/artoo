// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  bootstrapFixture,
  fakeApi,
  renderWithProviders,
  roomFixture,
  runFixture,
  taskFixture,
} from "../test/utils.js";
import { AppRoutes } from "./AppRoutes.js";

function appClient() {
  return fakeApi({
    bootstrap: async () => bootstrapFixture(),
    listComputerRuntimes: async () => ({
      runtimes: [
        {
          id: "runtime_mock",
          organization_id: "org_default",
          computer_id: "computer_local_mock",
          runtime: "mock",
          version: "0.1.0",
          status: "available",
          capabilities: ["code.modify"],
          last_seen_at: "2026-06-13T00:00:00Z",
        },
      ],
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

  it("routes skills to the backed manifest contract view", async () => {
    renderWithProviders(<AppRoutes />, { client: appClient(), route: "/skills" });
    expect(await screen.findByRole("heading", { name: "Skills", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Skill manifest contract" })).toHaveTextContent(
      "v1alpha1",
    );
  });

  it("board card click selects the task and returns to the workspace detail", async () => {
    renderWithProviders(<AppRoutes />, { client: appClient(), route: "/board" });
    await userEvent.click(await screen.findByText("Build inbox"));
    expect(await screen.findByRole("heading", { name: "Build inbox", level: 2 })).toBeInTheDocument();
  });
});
