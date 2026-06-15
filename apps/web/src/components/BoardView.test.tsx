// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { bootstrapFixture, fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { BoardView } from "./BoardView.js";

function boardClient() {
  return fakeApi({
    bootstrap: async () => bootstrapFixture(),
    listApprovals: async () => ({ approvals: [] }),
    listTasks: async () => ({
      tasks: [
        taskFixture({ id: "t1", title: "In review", status: "review", priority: "p1" }),
        taskFixture({ id: "t2", title: "Backlog item", status: "backlog", priority: "p2" }),
        taskFixture({ id: "t3", title: "Another backlog", status: "backlog", priority: "p3" }),
      ],
    }),
  });
}

describe("BoardView", () => {
  it("groups tasks into status columns from tasks(project)", async () => {
    renderWithProviders(<BoardView />, { client: boardClient(), route: "/board" });
    const backlog = await screen.findByRole("region", { name: "Backlog" });
    expect(backlog).toHaveTextContent("Backlog item");
    expect(backlog).toHaveTextContent("Another backlog");
    expect(screen.getByRole("region", { name: "Review" })).toHaveTextContent("In review");
  });

  it("filters by priority", async () => {
    renderWithProviders(<BoardView />, { client: boardClient(), route: "/board" });
    await screen.findByRole("region", { name: "Backlog" });

    await userEvent.selectOptions(screen.getByLabelText("Priority"), "p3");

    expect(screen.getByText("Another backlog")).toBeInTheDocument();
    expect(screen.queryByText("Backlog item")).toBeNull();
    expect(screen.queryByText("In review")).toBeNull();
  });
});
