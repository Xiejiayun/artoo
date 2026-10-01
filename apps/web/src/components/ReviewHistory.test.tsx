// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TaskReview } from "@artoo/domain";
import { ApiClientError, type ApiClient } from "../api/client.js";
import type { TaskSnapshot } from "../api/types.js";
import { queryKeys } from "../app/queryKeys.js";
import { artifactFixture, bootstrapFixture, createTestQueryClient, fakeApi, renderWithProviders, runFixture, taskFixture } from "../test/utils.js";
import { ArtifactReview } from "./ArtifactReview.js";
import { TaskDetailPanel } from "./TaskDetailPanel.js";

const exactComment = "  Correct the report.\n\nKeep the original evidence.  \n";
const initial = taskFixture({ id: "task_review", title: "Correct the report", status: "review" });
const runA = runFixture({ id: "run_original", task_id: initial.id, status: "completed", created_at: "2026-10-01T01:00:00Z" });
const runB = runFixture({ id: "run_corrected", task_id: initial.id, status: "completed", created_at: "2026-10-01T02:00:00Z" });
const artifactA = artifactFixture({ id: "artifact_original", task_id: initial.id, run_id: runA.id, type: "report", uri: "/api/v1/artifacts/artifact_original/content", metadata: { filename: "execution-report.txt" }, created_at: "2026-10-01T01:01:00Z" });
const artifactB = artifactFixture({ id: "artifact_corrected", task_id: initial.id, run_id: runB.id, type: "report", uri: "/api/v1/artifacts/artifact_corrected/content", metadata: { filename: "execution-report.txt" }, created_at: "2026-10-01T02:01:00Z" });
const review: TaskReview = { event_id: "review_changes", position: 12, task_id: initial.id, outcome: "changes_requested", comment: exactComment,
  actor: { type: "user", id: "reviewer" }, actor_name: "Casey Reviewer", occurred_at: "2026-10-01T01:02:00Z", artifact_ids: [artifactA.id] };

function snapshot(patch: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return { task: initial, room: null, runs: [runA], artifacts: [artifactA], approvals: [], version_cursor: 11, ...patch };
}
function panelApi(getTask: ApiClient["getTask"], extra: Partial<ApiClient> = {}): ApiClient {
  return fakeApi({ getTask, bootstrap: async () => bootstrapFixture(), listDependencies: async () => ({ dependencies: [] }), listTasks: async () => ({ tasks: [] }), listLeases: async () => ({ leases: [] }), ...extra });
}

describe("durable task reviews", () => {
  it("keeps older task snapshots readable when review history is absent", async () => {
    renderWithProviders(<TaskDetailPanel taskId={initial.id} />, { client: panelApi(async () => snapshot()) });
    expect(await screen.findByRole("heading", { name: initial.title, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Review history" })).toHaveTextContent("Review history is unavailable from this server.");
    expect(screen.getByLabelText("Review comment")).toHaveValue("");
  });

  it.each(["ready", "blocked", "review", "cancelled"] as const)("loads submitted history after remount while task is %s", async (status) => {
    const client = panelApi(async () => snapshot({ task: { ...initial, status }, reviews: [review] }));
    const first = renderWithProviders(<TaskDetailPanel taskId={initial.id} />, { client });
    const history = await screen.findByRole("region", { name: "Review history" });
    expect(within(history).getByText(exactComment, { exact: true, normalizer: (value) => value }).textContent).toBe(exactComment);
    expect(history).toHaveTextContent("Changes requested");
    expect(history).toHaveTextContent("Casey Reviewer");
    first.unmount();
    renderWithProviders(<TaskDetailPanel taskId={initial.id} />, { client });
    const restored = await screen.findByRole("region", { name: "Review history" });
    expect(within(restored).getByText(exactComment, { exact: true, normalizer: (value) => value }).textContent).toBe(exactComment);
    if (status === "review") expect(screen.getByLabelText("Review comment")).toHaveValue("");
    else expect(screen.queryByLabelText("Review comment")).not.toBeInTheDocument();
  });

  it("preserves comment bytes, clears only after successful submission, and then reads the stored decision", async () => {
    let stored = snapshot();
    let resolveReview!: (value: { task: typeof initial }) => void;
    const pending = new Promise<{ task: typeof initial }>((resolve) => { resolveReview = resolve; });
    const reviewTask = vi.fn<ApiClient["reviewTask"]>().mockImplementation(async () => {
      const response = await pending;
      stored = snapshot({ task: response.task, reviews: [review], version_cursor: 12 });
      return response;
    });
    renderWithProviders(<TaskDetailPanel taskId={initial.id} />, { client: panelApi(async () => stored, { reviewTask }) });
    const input = await screen.findByLabelText("Review comment");
    await userEvent.type(input, exactComment);
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    expect(input).toHaveValue(exactComment);
    expect(input).toBeDisabled();
    expect(reviewTask).toHaveBeenCalledWith(initial.id, { outcome: "changes_requested", comment: exactComment, base_version: 11 }, expect.any(String));
    await act(async () => resolveReview({ task: { ...initial, status: "ready" } }));
    const history = await screen.findByRole("region", { name: "Review history" });
    await waitFor(() => expect(within(history).getByText(exactComment, { exact: true, normalizer: (value) => value })).toBeInTheDocument());
    expect(screen.queryByLabelText("Review comment")).not.toBeInTheDocument();
  });

  it.each([400, 409])("keeps the exact failed draft after HTTP %s and a refreshed version", async (status) => {
    let version = 11;
    const query = createTestQueryClient();
    const reviewTask = vi.fn<ApiClient["reviewTask"]>().mockImplementation(async () => {
      version = 15;
      throw new ApiClientError("conflict", "Review was not accepted", status, { reason: status === 409 ? "stale_base_version" : "validation" });
    });
    renderWithProviders(<TaskDetailPanel taskId={initial.id} />, { queryClient: query, client: panelApi(async () => snapshot({ version_cursor: version }), { reviewTask }) });
    await userEvent.type(await screen.findByLabelText("Review comment"), exactComment);
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review was not accepted");
    await act(async () => { await query.invalidateQueries({ queryKey: queryKeys.task(initial.id) }); });
    expect(screen.getByLabelText("Review comment")).toHaveValue(exactComment);
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(reviewTask).toHaveBeenCalledTimes(2));
    expect(reviewTask).toHaveBeenLastCalledWith(initial.id, { outcome: "changes_requested", comment: exactComment, base_version: 15 }, expect.any(String));
  });

  it("does not carry successfully submitted feedback into a newer review of the same task", async () => {
    const reviewTask = vi.fn<ApiClient["reviewTask"]>().mockResolvedValue({ task: { ...initial, status: "ready" } });
    function UpdatingReview() {
      const [next, setNext] = useState(false);
      return <><button onClick={() => setNext(true)}>New execution completed</button><ArtifactReview task={initial}
        artifacts={next ? [artifactB, artifactA] : [artifactA]}
        reviews={next ? [review] : []} versionCursor={next ? 30 : 11} /></>;
    }
    renderWithProviders(<UpdatingReview />, { client: fakeApi({ reviewTask }) });
    await userEvent.type(screen.getByLabelText("Review comment"), exactComment);
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(screen.getByLabelText("Review comment")).toHaveValue(""));
    await userEvent.click(screen.getByRole("button", { name: "New execution completed" }));
    expect(screen.getByLabelText("Review comment")).toHaveValue("");
    expect(screen.getByRole("region", { name: "Review history" })).toHaveTextContent("Correct the report.");
    await userEvent.type(screen.getByLabelText("Review comment"), "Second-round feedback");
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(screen.getByLabelText("Review comment")).toHaveValue(""));
    expect(reviewTask).toHaveBeenCalledWith(initial.id, { outcome: "changes_requested", comment: "Second-round feedback", base_version: 30 }, expect.any(String));
  });

  it("preserves a rejected draft and its error when a 409 refresh reveals another review and a later execution", async () => {
    const peerReview: TaskReview = { ...review, event_id: "peer_review", position: 15, comment: "A peer requested another attempt.", actor: { type: "user", id: "peer" }, actor_name: "Another reviewer" };
    let stored = snapshot();
    const query = createTestQueryClient();
    const reviewTask = vi.fn<ApiClient["reviewTask"]>().mockImplementationOnce(async () => {
      stored = snapshot({ task: { ...initial, status: "ready" }, reviews: [peerReview], version_cursor: 15 });
      throw new ApiClientError("conflict", "A different review was already submitted", 409, { reason: "stale_base_version" });
    }).mockResolvedValue({ task: { ...initial, status: "ready" } });
    renderWithProviders(<TaskDetailPanel taskId={initial.id} />, { queryClient: query, client: panelApi(async () => stored, { reviewTask }) });
    await userEvent.type(await screen.findByLabelText("Review comment"), exactComment);
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Review history" })).toHaveTextContent(peerReview.comment!));
    expect(screen.getByRole("alert")).toHaveTextContent("A different review was already submitted");
    expect(screen.queryByLabelText("Review comment")).not.toBeInTheDocument();
    stored = snapshot({ runs: [runB, runA], artifacts: [artifactB, artifactA], reviews: [peerReview], version_cursor: 30 });
    await act(async () => { await query.invalidateQueries({ queryKey: queryKeys.task(initial.id) }); });
    expect(await screen.findByLabelText("Review comment")).toHaveValue(exactComment);
    expect(screen.getByRole("alert")).toHaveTextContent("A different review was already submitted");
    expect(reviewTask).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(screen.getByLabelText("Review comment")).toHaveValue(""));
    expect(reviewTask).toHaveBeenLastCalledWith(initial.id, { outcome: "changes_requested", comment: exactComment, base_version: 30 }, expect.any(String));
  });

  it("does not send whitespace-only comments", async () => {
    const reviewTask = vi.fn<ApiClient["reviewTask"]>().mockResolvedValue({ task: { ...initial, status: "done" } });
    renderWithProviders(<ArtifactReview task={initial} artifacts={[]} />, { client: fakeApi({ reviewTask }) });
    await userEvent.type(screen.getByLabelText("Review comment"), "  \n  ");
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(reviewTask).toHaveBeenCalledWith(initial.id, { outcome: "accepted" }, expect.any(String));
    await waitFor(() => expect(screen.getByLabelText("Review comment")).toHaveValue(""));
  });

  it("never carries another task's failed draft or error into the selected task", async () => {
    const reviewTask = vi.fn<ApiClient["reviewTask"]>().mockRejectedValue(new ApiClientError("conflict", "First task review failed", 400));
    function SelectedReview() {
      const [task, setTask] = useState(initial);
      return <><button onClick={() => setTask({ ...initial, id: "another_task", title: "Another task" })}>Select another task</button><ArtifactReview task={task} artifacts={[]} /></>;
    }
    renderWithProviders(<SelectedReview />, { client: fakeApi({ reviewTask }) });
    await userEvent.type(screen.getByLabelText("Review comment"), exactComment);
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("First task review failed");
    await userEvent.click(screen.getByRole("button", { name: "Select another task" }));
    expect(screen.getByLabelText("Review comment")).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(reviewTask).toHaveBeenCalledTimes(1);
  });

  it("retains loaded history when a background snapshot refresh fails", async () => {
    const query = createTestQueryClient();
    const getTask = vi.fn<ApiClient["getTask"]>().mockResolvedValueOnce(snapshot({ reviews: [review] }))
      .mockRejectedValue(new ApiClientError("network_error", "Could not refresh review history", 0));
    renderWithProviders(<TaskDetailPanel taskId={initial.id} />, { queryClient: query, client: panelApi(getTask) });
    const history = await screen.findByRole("region", { name: "Review history" });
    await act(async () => { await query.invalidateQueries({ queryKey: queryKeys.task(initial.id) }); });
    expect(history).toHaveTextContent("Correct the report.");
    expect(await screen.findByRole("button", { name: "Retry loading task details" })).toBeInTheDocument();
  });
});

describe("review and artifact provenance", () => {
  it("distinguishes identical filenames by exact origin and creation time while preserving download IDs", async () => {
    const downloadArtifact = vi.fn<ApiClient["downloadArtifact"]>().mockResolvedValue(new Blob(["report"]));
    const create = vi.fn().mockReturnValue("blob:owned-report");
    const revoke = vi.fn();
    const previousCreate = URL.createObjectURL, previousRevoke = URL.revokeObjectURL;
    URL.createObjectURL = create; URL.revokeObjectURL = revoke;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      renderWithProviders(<ArtifactReview task={{ ...initial, status: "blocked" }} artifacts={[artifactB, artifactA]} />, { client: fakeApi({ downloadArtifact }) });
      const original = screen.getByRole("listitem", { name: `Artifact ${artifactA.id}` });
      const corrected = screen.getByRole("listitem", { name: `Artifact ${artifactB.id}` });
      for (const [row, artifact] of [[original, artifactA], [corrected, artifactB]] as const) {
        expect(row).toHaveTextContent("execution-report.txt");
        expect(row).toHaveTextContent(artifact.run_id!);
        expect(row).toHaveTextContent(artifact.id);
        expect(row.querySelector("time")).toHaveAttribute("datetime", artifact.created_at);
        await userEvent.click(within(row).getByRole("button", { name: "Download artifact" }));
        await waitFor(() => expect(downloadArtifact).toHaveBeenCalledWith(artifact.id));
      }
      expect(downloadArtifact.mock.calls.map(([id]) => id)).toEqual([artifactA.id, artifactB.id]);
      await waitFor(() => expect(revoke).toHaveBeenCalledTimes(2), { timeout: 2000 });
    } finally { click.mockRestore(); URL.createObjectURL = previousCreate; URL.revokeObjectURL = previousRevoke; }
  });

  it("shows recorded task-level inventory only, keeps legacy attribution unknown and handles unavailable artifacts", () => {
    const legacy = artifactFixture({ id: "artifact_legacy", task_id: initial.id, type: "patch", uri: "file:///opaque/pretend-name.patch", metadata: {} });
    const old: TaskReview = { ...review, event_id: "legacy_review", position: 2, actor_name: null, comment: null, artifact_ids: null };
    const absent: TaskReview = { ...review, event_id: "missing_review", position: 20, outcome: "accepted", artifact_ids: ["artifact_gone"] };
    renderWithProviders(<ArtifactReview task={{ ...initial, status: "cancelled" }} artifacts={[artifactB, legacy, artifactA]}
      reviews={[absent, review, old]} />, { client: fakeApi({}) });
    const history = screen.getByRole("region", { name: "Review history" });
    const entries = within(history).getAllByRole("article");
    expect(entries.map((entry) => entry.getAttribute("data-review-id"))).toEqual([old.event_id, review.event_id, absent.event_id]);
    expect(entries[0]).toHaveTextContent("user:reviewer");
    expect(entries[0]).toHaveTextContent("Artifact attribution was not recorded");
    expect(entries[0]).not.toHaveTextContent(artifactA.id);
    expect(entries[1]).toHaveTextContent(artifactA.id);
    expect(entries[1]).toHaveTextContent(runA.id);
    expect(entries[1]).not.toHaveTextContent(artifactB.id);
    expect(entries[2]).toHaveTextContent("artifact_gone");
    expect(entries[2]).toHaveTextContent("Artifact details unavailable");
    const legacyRow = screen.getByRole("listitem", { name: `Artifact ${legacy.id}` });
    expect(legacyRow).toHaveTextContent("Filename unavailable");
    expect(legacyRow).toHaveTextContent("Originating run not recorded");
    expect(legacyRow).toHaveTextContent("Unavailable remotely");
    expect(within(legacyRow).queryByRole("button", { name: "Download artifact" })).not.toBeInTheDocument();
  });
});
