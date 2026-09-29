// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiClientError } from "../api/client.js";
import { approvalFixture, bootstrapFixture, createTestQueryClient, fakeApi, messageFixture, renderWithProviders, roomFixture, runFixture, taskFixture } from "../test/utils.js";
import { CancelRun } from "./CancelRun.js";
import { TaskActions } from "./TaskActions.js";
import { TaskRoom } from "./TaskRoom.js";
import { ArtifactReview } from "./ArtifactReview.js";
import { ApprovalInbox } from "./ApprovalInbox.js";
import { AuthGate } from "./AuthGate.js";

afterEach(() => { Reflect.deleteProperty(window, "artooDesktop"); });

describe("trusted preview controls", () => {
  it("routes a revoked native credential to device pairing without a browser OAuth link", async () => {
    Object.defineProperty(window, "artooDesktop", { configurable: true, value: { serverUrl: "https://example.test", platform: "win32", electronVersion: "40", pairDevice: vi.fn() } });
    renderWithProviders(<AuthGate enabled><p>Protected workspace</p></AuthGate>, { client: fakeApi({ getSession: async () => { throw new ApiClientError("unknown", "revoked", 401); } }) });
    expect(await screen.findByRole("form", { name: "Connect desktop" })).toBeInTheDocument();
    expect(screen.getByLabelText("Pairing code")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    expect(screen.queryByText("Protected workspace")).toBeNull();
  });

  it("keeps needs-more-info approvals resolvable and records a decision comment", async () => {
    const resolveApproval = vi.fn().mockResolvedValue({ approval: approvalFixture({ id: "approval_1", status: "approved" }) });
    renderWithProviders(<ApprovalInbox taskId="task_1" approvals={[approvalFixture({ id: "approval_1", status: "needs_more_info", summary: "Publish release" })]} />, { client: fakeApi({ resolveApproval }) });
    expect(screen.getByText("Waiting for more information")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Need info" })).toBeNull();
    expect(screen.getByText(/Execution approvals gate task assignment/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Approval comment for Publish release"), "Verified release evidence");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(resolveApproval).toHaveBeenCalledWith("approval_1", { decision: "approved", comment: "Verified release evidence" }, expect.any(String));
  });

  it("sends the observed version for review and refreshes a stale task without replaying acceptance", async () => {
    const reviewTask = vi.fn().mockRejectedValue(new ApiClientError("conflict", "task changed since base_version; refetch and retry", 409, { reason: "stale_base_version", base_version: 12, current_version: 13 }));
    const query = createTestQueryClient();
    const invalidate = vi.spyOn(query, "invalidateQueries");
    renderWithProviders(<ArtifactReview task={taskFixture({ id: "task_1", title: "Task", status: "review" })} artifacts={[]} versionCursor={12} />, { client: fakeApi({ reviewTask }), queryClient: query });
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(reviewTask).toHaveBeenCalledWith("task_1", { outcome: "accepted", base_version: 12 }, expect.any(String));
    expect(await screen.findByRole("status")).toHaveTextContent("Review the refreshed details");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["task", "task_1"] });
    expect(reviewTask).toHaveBeenCalledTimes(1);
  });
  it("requires an explicit stop confirmation and preserves server failure feedback", async () => {
    const cancelRun = vi.fn().mockRejectedValue(new ApiClientError("conflict", "Execution computer is offline; stopping is unconfirmed", 409));
    renderWithProviders(<CancelRun runs={[runFixture({ id: "run_1", status: "running" })]} taskId="task_1" projectId="proj_artoo" />, { client: fakeApi({ cancelRun }) });
    await userEvent.click(screen.getByRole("button", { name: "Stop run" }));
    expect(cancelRun).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Keep running" }));
    expect(cancelRun).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Stop run" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("stopping is unconfirmed");
    expect(cancelRun).toHaveBeenCalledWith("run_1", expect.any(String));
  });

  it("surfaces a ready conflict without pretending the task advanced", async () => {
    renderWithProviders(<TaskActions task={taskFixture({ id: "task_1", title: "Task", status: "backlog" })} />, { client: fakeApi({ markReady: async () => { throw new ApiClientError("conflict", "A prerequisite has not completed", 409); } }) });
    await userEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("prerequisite");
    expect(screen.getByRole("button", { name: "Mark ready" })).toBeEnabled();
  });

  it("retains a rejected message draft and clears it only after a successful retry", async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(new ApiClientError("validation_error", "Message was rejected", 400)).mockResolvedValueOnce({ message: messageFixture({ id: "message_1", kind: "text", body: "Keep this context" }) });
    const listMessages = vi.fn().mockResolvedValue({ messages: [] });
    renderWithProviders(<TaskRoom taskId="task_1" />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), getTask: async () => ({ task: taskFixture({ id: "task_1", title: "Task", status: "ready" }), room: roomFixture({ id: "room_1" }), runs: [], approvals: [], artifacts: [] }), listMessages, sendMessage, listDecisions: async () => ({ decisions: [] }), listHandoffs: async () => ({ handoffs: [] }), listBlockers: async () => ({ blockers: [] }) }) });
    await userEvent.type(await screen.findByLabelText("Message"), "Keep this context");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Message was rejected");
    expect(screen.getByLabelText("Message")).toHaveValue("Keep this context");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(""));
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(listMessages.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not expose legacy local files as downloadable links", () => {
    renderWithProviders(<ArtifactReview task={taskFixture({ id: "task_1", title: "Task", status: "done" })} artifacts={[{ id: "art_1", organization_id: "org_default", task_id: "task_1", type: "report", uri: "file:///private/report.txt", metadata: {}, created_at: "2026-01-01" }]} />, { client: fakeApi({}) });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Unavailable remotely/)).toBeInTheDocument();
  });

  it("uses the secure token provider for REST, session and binary downloads", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{"projects":[]}')).mockResolvedValueOnce(new Response('{"user":{"id":"u"}}')).mockResolvedValueOnce(new Response("report"));
    const api = new ApiClient({ baseUrl: "https://example.test/api/v1", credentials: "omit", tokenProvider: async () => "sk_device_test_secret", fetch });
    await api.bootstrap(); await api.getSession(); await api.downloadArtifact("art_1");
    expect(fetch.mock.calls).toHaveLength(3);
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ credentials: "omit", headers: { Authorization: "Bearer sk_device_test_secret" } });
    expect(fetch.mock.calls[1]?.[0]).toBe("https://example.test/auth/session");
    expect(fetch.mock.calls[2]?.[0]).toBe("https://example.test/api/v1/artifacts/art_1/content");
  });
});
