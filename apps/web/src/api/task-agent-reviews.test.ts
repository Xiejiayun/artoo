import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { ApiClient } from "./client.js";

const baseUrl = "http://localhost/api/v1";
const server = setupServer();
const client = new ApiClient({ baseUrl });
const taskId = "task / &";
const review = {
  version: 1, id: "feedback / &", project_id: "proj_artoo", source_task_id: taskId,
  source_run_id: "run_source", source_agent_id: "agent_author", review_task_id: "task_feedback", reviewer_agent_id: "agent_peer",
  artifacts: [{ id: "artifact_source", type: "report", run_id: "run_source", checksum: `sha256:${"a".repeat(64)}` }],
  requested_by_user_id: "user_1", created_at: "2026-11-16T00:00:00Z",
};
const view = { ...review, review_task_status: "ready", review_run_id: null, review_run_status: null,
  report: null, report_message_id: null, report_artifact_ids: [], stale: false, stale_reason: null, applied_at: null, applied_event_id: null };

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it("creates an exact pinned feedback request and keeps its idempotency identity on the wire", async () => {
  const body = { version: 1 as const, source_run_id: "run_source", reviewer_agent_id: "agent_peer", artifact_ids: ["artifact_source"] };
  server.use(http.post(`${baseUrl}/tasks/:id/agent-reviews`, async ({ params, request }) => {
    expect(params.id).toBe(taskId);
    expect(request.headers.get("Idempotency-Key")).toBe("request-feedback");
    expect(await request.json()).toEqual(body);
    return HttpResponse.json({ review });
  }));
  expect(await client.createTaskAgentReview(taskId, body, "request-feedback")).toEqual({ review });
});

it("rejects unsupported or misbound feedback observations", async () => {
  server.use(http.get(`${baseUrl}/tasks/:id/agent-reviews`, ({ params }) => {
    expect(params.id).toBe(taskId);
    return HttpResponse.json({ reviews: [view] });
  }));
  expect(await client.listTaskAgentReviews(taskId)).toEqual({ reviews: [view] });
  server.use(http.get(`${baseUrl}/tasks/:id/agent-reviews`, () => HttpResponse.json({ reviews: [{ ...view, version: 2 }] })));
  await expect(client.listTaskAgentReviews(taskId)).rejects.toThrow();
  server.use(http.get(`${baseUrl}/tasks/:id/agent-reviews`, () => HttpResponse.json({ reviews: [{ ...view, source_task_id: "another_task" }] })));
  await expect(client.listTaskAgentReviews(taskId)).rejects.toThrow("another source task");
});

it("sends an explicit user return action bound to the exact feedback execution", async () => {
  const body = { version: 1 as const, review_run_id: "run_peer", comment: "Include the missing case" };
  server.use(http.post(`${baseUrl}/tasks/:id/agent-reviews/:reviewId/request-changes`, async ({ params, request }) => {
    expect(params.id).toBe(taskId);
    expect(params.reviewId).toBe(review.id);
    expect(request.headers.get("Idempotency-Key")).toBe("return-feedback");
    expect(await request.json()).toEqual(body);
    return HttpResponse.json({ task: { id: taskId, status: "ready" } });
  }));
  expect(await client.requestTaskAgentReviewChanges(taskId, review.id, body, "return-feedback")).toEqual({ task: { id: taskId, status: "ready" } });
});
