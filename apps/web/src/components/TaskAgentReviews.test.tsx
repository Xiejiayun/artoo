// @vitest-environment jsdom
import type { TaskAgentReviewV1, TaskAgentReviewViewV1 } from "@artoo/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { artifactFixture, bootstrapFixture, fakeApi, renderWithProviders, runFixture, taskFixture } from "../test/utils.js";
import { TaskAgentReviews } from "./TaskAgentReviews.js";

const task = taskFixture({ id: "task_author", title: "Author candidate", status: "review" });
const source = runFixture({ id: "run_author", task_id: task.id, status: "completed", agent_instance_id: "instance_mock_coder" });
const checksum = `sha256:${"a".repeat(64)}`;
const artifact = artifactFixture({ id: "artifact_candidate", task_id: task.id, run_id: source.id, type: "report", uri: "/api/v1/artifacts/artifact_candidate/content", checksum, metadata: { filename: "candidate.txt" } });
const base = bootstrapFixture();
const author = base.agents[0]!;
const peer = { ...author, id: "agent_peer", display_name: "Peer reviewer" };
const foreign = { ...author, id: "agent_foreign", display_name: "Other project only" };
const bootstrap = bootstrapFixture({ agents: [author, peer, foreign], agent_instances: [base.agent_instances[0]!,
  { ...base.agent_instances[0]!, id: "instance_author_alias" },
  { ...base.agent_instances[0]!, id: "instance_peer", agent_id: peer.id, project_id: null },
  { ...base.agent_instances[0]!, id: "instance_foreign", agent_id: foreign.id, project_id: "proj_other" },
] });
const review: TaskAgentReviewV1 = {
  version: 1, id: "feedback_1", project_id: task.project_id, source_task_id: task.id, source_run_id: source.id,
  source_agent_id: author.id, review_task_id: "task_peer", reviewer_agent_id: peer.id,
  artifacts: [{ id: artifact.id, type: artifact.type, run_id: source.id, checksum }],
  requested_by_user_id: base.user.id, created_at: "2026-11-16T00:00:00Z",
};
const completed: TaskAgentReviewViewV1 = {
  ...review, review_task_status: "review", review_run_id: "run_peer", review_run_status: "completed",
  report: "Add the missing failure case before accepting this candidate.", report_message_id: "message_report",
  report_artifact_ids: ["artifact_peer_report"], stale: false, stale_reason: null, applied_at: null, applied_event_id: null,
};
function client(overrides: Partial<ApiClient> = {}) {
  return fakeApi({ bootstrap: async () => bootstrap,
    getProjectSquad: async () => ({ squad: { version: 1, project_id: task.project_id, revision: 1, source: "configured", agent_ids: [author.id, peer.id, foreign.id] } }),
    listTaskAgentReviews: async () => ({ reviews: [] }), ...overrides });
}

describe("TaskAgentReviews", () => {
  it("creates a pinned feedback task for another scoped logical Agent without starting execution", async () => {
    let finish!: (value: { review: TaskAgentReviewV1 }) => void;
    const createTaskAgentReview = vi.fn<ApiClient["createTaskAgentReview"]>(() => new Promise((resolve) => { finish = resolve; }));
    const assignTask = vi.fn<ApiClient["assignTask"]>(), reviewTask = vi.fn<ApiClient["reviewTask"]>();
    renderWithProviders(<TaskAgentReviews task={task} runs={[source]} artifacts={[artifact]} />, { client: client({ createTaskAgentReview, assignTask, reviewTask }) });
    await userEvent.click(await screen.findByText("Request another Agent's feedback"));
    const form = screen.getByRole("form", { name: "Request Agent artifact feedback" });
    expect(within(form).queryByRole("option", { name: author.display_name })).not.toBeInTheDocument();
    expect(within(form).queryByRole("option", { name: foreign.display_name })).not.toBeInTheDocument();
    await userEvent.selectOptions(within(form).getByLabelText("Feedback reviewer"), peer.id);
    await userEvent.click(within(form).getByRole("button", { name: "Create Agent feedback task" }));
    expect(createTaskAgentReview).toHaveBeenCalledWith(task.id, { version: 1, source_run_id: source.id, reviewer_agent_id: peer.id, artifact_ids: [artifact.id] }, expect.any(String));
    expect(screen.queryByText(/Feedback task created/)).not.toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Create Agent feedback task" })).toBeDisabled();
    finish({ review });
    expect(await screen.findByRole("link", { name: "Open feedback task and assign it ↗" })).toHaveAttribute("href", `/board?task=${review.review_task_id}&project=${task.project_id}`);
    expect(assignTask).not.toHaveBeenCalled();
    expect(reviewTask).not.toHaveBeenCalled();
    expect(screen.getByText(/Execution has not started automatically/)).toBeInTheDocument();
  });

  it("excludes old-run artifacts and requires at least one selected current stored artifact", async () => {
    const old = artifactFixture({ ...artifact, id: "artifact_old", run_id: "run_old", metadata: { filename: "old.txt" } });
    renderWithProviders(<TaskAgentReviews task={task} runs={[source]} artifacts={[old, artifact]} />, { client: client() });
    await userEvent.click(await screen.findByText("Request another Agent's feedback"));
    const form = screen.getByRole("form", { name: "Request Agent artifact feedback" });
    expect(within(form).queryByRole("checkbox", { name: /old.txt/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(within(form).getByLabelText("Feedback reviewer"), peer.id);
    await userEvent.click(within(form).getByRole("checkbox", { name: /candidate.txt/ }));
    expect(within(form).getByRole("button", { name: "Create Agent feedback task" })).toBeDisabled();
  });

  it("retains the selected reviewer and reuses the same creation identity after an uncertain response", async () => {
    const createTaskAgentReview = vi.fn<ApiClient["createTaskAgentReview"]>()
      .mockRejectedValueOnce(new Error("Feedback response was interrupted"))
      .mockResolvedValue({ review });
    renderWithProviders(<TaskAgentReviews task={task} runs={[source]} artifacts={[artifact]} />, { client: client({ createTaskAgentReview }) });
    await userEvent.click(await screen.findByText("Request another Agent's feedback"));
    const form = screen.getByRole("form", { name: "Request Agent artifact feedback" });
    await userEvent.selectOptions(within(form).getByLabelText("Feedback reviewer"), peer.id);
    await userEvent.click(within(form).getByRole("button", { name: "Create Agent feedback task" }));
    expect(await within(form).findByText("Feedback response was interrupted")).toBeInTheDocument();
    expect(within(form).getByLabelText("Feedback reviewer")).toHaveValue(peer.id);
    await userEvent.click(within(form).getByRole("button", { name: "Create Agent feedback task" }));
    await waitFor(() => expect(createTaskAgentReview).toHaveBeenCalledTimes(2));
    expect(createTaskAgentReview.mock.calls[0]![2]).toBe(createTaskAgentReview.mock.calls[1]![2]);
  });

  it("does not reuse an old successful attempt when the latest author attempt failed", async () => {
    renderWithProviders(<TaskAgentReviews task={task} runs={[source, { ...source, id: "run_failed", status: "failed", created_at: "2099-01-01T00:00:00Z" }]} artifacts={[artifact]} />, { client: client() });
    expect(await screen.findByText("The latest author execution must complete before requesting feedback.")).toBeInTheDocument();
    expect(screen.queryByText("Request another Agent's feedback")).not.toBeInTheDocument();
  });

  it("returns the bound completed report only after the user explicitly requests changes", async () => {
    let current = completed;
    const requestTaskAgentReviewChanges = vi.fn<ApiClient["requestTaskAgentReviewChanges"]>().mockImplementation(async () => {
      current = { ...completed, applied_at: "2026-11-16T01:00:00Z", applied_event_id: "event_returned" };
      return { task: { ...task, status: "ready" } };
    });
    const reviewTask = vi.fn<ApiClient["reviewTask"]>();
    renderWithProviders(<TaskAgentReviews task={task} runs={[source]} artifacts={[artifact]} />, { client: client({ listTaskAgentReviews: async () => ({ reviews: [current] }), requestTaskAgentReviewChanges, reviewTask }) });
    const record = await screen.findByRole("article", { name: `Artifact feedback from ${peer.display_name}` });
    expect(within(record).getByLabelText("Recorded Agent feedback report")).toHaveTextContent(completed.report!);
    expect(within(record).getByRole("link", { name: source.id })).toHaveAttribute("href", `/runs?task=${task.id}&run=${source.id}&project=${task.project_id}`);
    expect(requestTaskAgentReviewChanges).not.toHaveBeenCalled();
    expect(reviewTask).not.toHaveBeenCalled();
    await userEvent.type(within(record).getByLabelText("Additional return comment"), "Include a regression case");
    await userEvent.click(within(record).getByRole("button", { name: "Send report back for changes" }));
    await waitFor(() => expect(requestTaskAgentReviewChanges).toHaveBeenCalledWith(task.id, review.id, { version: 1, review_run_id: "run_peer", comment: "Include a regression case" }, expect.any(String)));
    expect(await within(record).findByText("Returned to author")).toBeInTheDocument();
    expect(within(record).queryByRole("button", { name: "Send report back for changes" })).not.toBeInTheDocument();
    expect(reviewTask).not.toHaveBeenCalled();
  });

  it.each<TaskAgentReviewViewV1>([
    { ...completed, stale: true, stale_reason: "A newer source execution replaced this candidate." },
    { ...completed, review_run_status: "running" },
    { ...completed, applied_at: "2026-11-16T01:00:00Z" },
  ])("retains report evidence without offering changes for a stale, unfinished or applied review", async (view) => {
    renderWithProviders(<TaskAgentReviews task={task} runs={[source]} artifacts={[artifact]} />, { client: client({ listTaskAgentReviews: async () => ({ reviews: [view] }) }) });
    const record = await screen.findByRole("article", { name: `Artifact feedback from ${peer.display_name}` });
    expect(within(record).getByLabelText("Recorded Agent feedback report")).toHaveTextContent(completed.report!);
    expect(within(record).queryByRole("button", { name: "Send report back for changes" })).not.toBeInTheDocument();
  });
});
