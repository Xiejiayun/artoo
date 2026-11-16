// @vitest-environment jsdom
import type { TaskReview } from "@artoo/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { controlViewFixture } from "../test/controlViewFixture.js";
import {
  artifactFixture,
  bootstrapFixture,
  fakeApi,
  renderWithProviders,
  runFixture,
  taskFixture,
} from "../test/utils.js";
import { ReviewPage } from "./ReviewPage.js";

const pending = taskFixture({
  id: "task_1",
  title: "Review the shared output",
  status: "review",
  acceptance_criteria: ["Result is reproducible"],
});
const run = runFixture({ id: "run_review", task_id: pending.id, status: "completed" });
function client(overrides: Partial<ApiClient> = {}) {
  return fakeApi({
    bootstrap: async () => bootstrapFixture(),
    listGoals: async () => ({ goals: [] }),
    getProjectControlView: async () =>
      controlViewFixture({
        tasks: [
          {
            task: pending,
            latest_run: run,
            execution_lease: null,
            execution_request: null,
            queue_metadata: null,
            last_assignment: null,
          },
        ],
      }),
    getTask: async () => ({
      task: pending,
      room: null,
      runs: [run],
      artifacts: [],
      approvals: [],
      reviews: [],
      version_cursor: 12,
    }),
    listTasks: async () => ({ tasks: [pending] }),
    listDependencies: async () => ({ dependencies: [] }),
    listLeases: async () => ({ leases: [] }),
    ...overrides,
  });
}
describe("ReviewPage", () => {
  it("keeps acceptance pending until the server persists its versioned decision", async () => {
    let task = pending;
    let reviews: TaskReview[] = [];
    let release!: () => void;
    const saved = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reviewTask = vi.fn<ApiClient["reviewTask"]>().mockImplementation(async (_id, body) => {
      await saved;
      task = { ...task, status: "done" };
      reviews = [
        {
          event_id: "review_event",
          position: 13,
          task_id: task.id,
          outcome: body.outcome,
          comment: body.comment ?? null,
          actor: { type: "user", id: "user_1" },
          actor_name: "J",
          occurred_at: "2026-11-16T00:00:00Z",
          artifact_ids: [],
        },
      ];
      return { task };
    });
    renderWithProviders(<ReviewPage />, {
      route: "/review?task=task_1&project=proj_artoo",
      client: client({
        reviewTask,
        getTask: async () => ({
          task,
          room: null,
          runs: [run],
          artifacts: [],
          approvals: [],
          reviews,
          version_cursor: 12,
        }),
      }),
    });
    const accept = await screen.findByRole("button", { name: "Accept" });
    await userEvent.type(screen.getByLabelText("Review comment"), "Output checked");
    await userEvent.click(accept);
    expect(accept).toBeDisabled();
    expect(screen.queryByText("Accepted")).not.toBeInTheDocument();
    expect(reviewTask).toHaveBeenCalledWith(
      "task_1",
      { outcome: "accepted", comment: "Output checked", base_version: 12 },
      expect.any(String),
    );
    release();
    expect(await screen.findByText("Accepted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });
  it("requests changes through the existing review owner and retains the execution evidence link", async () => {
    const reviewTask = vi.fn<ApiClient["reviewTask"]>().mockResolvedValue({ task: { ...pending, status: "ready" } });
    const assignTask = vi.fn<ApiClient["assignTask"]>();
    renderWithProviders(<ReviewPage />, {
      route: "/review?task=task_1&project=proj_artoo",
      client: client({
        reviewTask,
        assignTask,
        getTask: async () => ({
          task: pending,
          room: null,
          runs: [run],
          approvals: [],
          artifacts: [artifactFixture({ id: "artifact_1", type: "patch", uri: "legacy/fix.patch", run_id: run.id })],
          reviews: [],
          version_cursor: 12,
        }),
      }),
    });
    await userEvent.type(await screen.findByLabelText("Review comment"), "Include the missing dependency case");
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() =>
      expect(reviewTask).toHaveBeenCalledWith(
        "task_1",
        { outcome: "changes_requested", comment: "Include the missing dependency case", base_version: 12 },
        expect.any(String),
      ),
    );
    expect(assignTask).not.toHaveBeenCalled();
    const artifacts = screen.getByRole("region", { name: "Artifacts" });
    expect(within(artifacts).getByRole("link", { name: run.id })).toHaveAttribute(
      "href",
      "/runs?task=task_1&run=run_review&project=proj_artoo",
    );
    expect(screen.getByRole("link", { name: "Release evidence" })).toHaveAttribute("href", "/release");
    expect(screen.queryByRole("button", { name: /Publish|Deploy/ })).not.toBeInTheDocument();
  });
  it("does not offer decisions for a task outside the requested project", async () => {
    renderWithProviders(<ReviewPage />, {
      route: "/review?task=task_1&project=proj_artoo",
      client: client({
        getTask: async () => ({
          task: { ...pending, project_id: "foreign_project" },
          room: null,
          runs: [],
          artifacts: [],
          approvals: [],
        }),
      }),
    });
    expect(await screen.findByText("Linked review task unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });
});
