// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "../app/queryKeys.js";
import { approvalFixture, createTestQueryClient, fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { LeftRail } from "./LeftRail.js";

const first = taskFixture({ id: "ready", project_id: "project_a", title: "Ready but needs approval", status: "ready" });
const second = taskFixture({ id: "info", project_id: "project_a", title: "Needs more information", status: "blocked" });
const ordinary = taskFixture({ id: "ordinary", project_id: "project_a", title: "Ordinary task", status: "backlog" });

function client() {
  return fakeApi({
    listTasks: vi.fn(async (projectId: string) => ({ tasks: projectId === "project_a" ? [first, second, ordinary] : [taskFixture({ id: "other", project_id: projectId, title: "Other project", status: "ready" })] })),
    listApprovals: vi.fn(async (status) => ({ approvals: status === "pending" ? [
      approvalFixture({ id: "approval_a", task_id: first.id, status: "pending", action: "execution.start" }),
      approvalFixture({ id: "approval_b", task_id: "other", status: "pending" }),
      approvalFixture({ id: "approval_info", task_id: second.id, status: "pending" }),
      approvalFixture({ id: "old", task_id: ordinary.id, status: "pending", payload_ref: "execution-gate/superseded" }),
    ] : [approvalFixture({ id: "approval_info", task_id: second.id, status: "needs_more_info" })] })),
  });
}

describe("LeftRail project approvals", () => {
  it("counts only current project approvals and opens the actual ready task", async () => {
    const api = client(), select = vi.fn();
    renderWithProviders(<LeftRail projectId="project_a" projectName="A" selectedTaskId={null} onSelectTask={select} />, { client: api });
    const badge = await screen.findByRole("button", { name: "2 pending approvals" });
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter tasks" }), "Ordinary");
    await userEvent.click(badge);
    expect(select).toHaveBeenCalledWith(first.id);
    expect(screen.getByRole("searchbox", { name: "Filter tasks" })).toHaveValue("");
    expect(screen.getByText(first.title)).toBeInTheDocument();
    expect(screen.getByText(second.title)).toBeInTheDocument();
    expect(screen.queryByText(ordinary.title)).not.toBeInTheDocument();
    expect(badge).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Show all tasks" }));
    expect(screen.getByText(ordinary.title)).toBeInTheDocument();
    expect(api.listTasks).toHaveBeenCalledTimes(1);
  });

  it("does not show another project's count while its tasks are loading", async () => {
    const api = client();
    api.listTasks = () => new Promise(() => undefined);
    renderWithProviders(<LeftRail projectId="unloaded" projectName="Loading" selectedTaskId={null} onSelectTask={vi.fn()} />, { client: api });
    expect(await screen.findByRole("status", { name: "Loading tasks" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pending approvals/ })).not.toBeInTheDocument();
  });

  it("recounts from project tasks when switching projects and clears the approval view", async () => {
    function Projects() {
      const [project, setProject] = useState("project_a");
      return <><button onClick={() => setProject("project_b")}>Switch project</button>
        <LeftRail projectId={project} projectName={project} selectedTaskId={null} onSelectTask={vi.fn()} /></>;
    }
    renderWithProviders(<Projects />, { client: client() });
    await userEvent.click(await screen.findByRole("button", { name: "2 pending approvals" }));
    await userEvent.click(screen.getByRole("button", { name: "Switch project" }));
    expect(await screen.findByRole("button", { name: "1 pending approvals" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Other project")).toBeInTheDocument();
    expect(screen.queryByText(first.title)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show all tasks" })).not.toBeInTheDocument();
  });

  it("updates the count and empty filter when the last approval resolves", async () => {
    const query = createTestQueryClient();
    renderWithProviders(<LeftRail projectId="project_a" projectName="A" selectedTaskId={null} onSelectTask={vi.fn()} />, { client: client(), queryClient: query });
    await userEvent.click(await screen.findByRole("button", { name: "2 pending approvals" }));
    act(() => {
      query.setQueryData(queryKeys.approvals("pending"), { approvals: [] });
      query.setQueryData(queryKeys.approvals("needs_more_info"), { approvals: [] });
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /pending approvals/ })).not.toBeInTheDocument());
    expect(await screen.findByText("No tasks have pending approvals.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show all tasks" }));
    expect(screen.getByText(ordinary.title)).toBeInTheDocument();
  });
});
