import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CreateTaskRequest } from "@artoo/domain";

import { ApiClient, ApiClientError } from "./client.js";

const BASE = "http://localhost/api/v1";
const server = setupServer();
const client = new ApiClient({ baseUrl: BASE });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const createReq: CreateTaskRequest = {
  project_id: "proj_1",
  title: "Build inbox",
  description: "",
  priority: "p2",
  acceptance_criteria: [],
  required_capabilities: [],
};

describe("ApiClient", () => {
  it("createTask posts the body with an Idempotency-Key header and returns the task", async () => {
    let seenKey: string | null = null;
    let seenBody: { title?: string } = {};
    server.use(
      http.post(`${BASE}/tasks`, async ({ request }) => {
        seenKey = request.headers.get("Idempotency-Key");
        seenBody = (await request.json()) as { title?: string };
        return HttpResponse.json(
          { task: { id: "task_1", status: "backlog" }, room: { id: "room_1" } },
          { status: 201 },
        );
      }),
    );

    const res = await client.createTask(createReq, "idem-1");

    expect(seenKey).toBe("idem-1");
    expect(seenBody.title).toBe("Build inbox");
    expect(res.task.id).toBe("task_1");
    expect(res.room.id).toBe("room_1");
  });

  it("maps the error envelope to ApiClientError with code + status", async () => {
    server.use(
      http.post(`${BASE}/tasks/task_1/ready`, () =>
        HttpResponse.json(
          { error: { code: "invalid_state", message: "not ready", details: { from: "backlog" } } },
          { status: 409 },
        ),
      ),
    );

    await expect(client.markReady("task_1", "idem-2")).rejects.toMatchObject({
      name: "ApiClientError",
      code: "invalid_state",
      status: 409,
      details: { from: "backlog" },
    });
  });

  it("resolveApproval sends decision + idempotency key (platform-gated action)", async () => {
    let key: string | null = null;
    server.use(
      http.post(`${BASE}/approvals/approval_1/resolve`, async ({ request }) => {
        key = request.headers.get("Idempotency-Key");
        const body = (await request.json()) as { decision: string };
        return HttpResponse.json({ approval: { id: "approval_1", status: body.decision } });
      }),
    );

    const res = await client.resolveApproval("approval_1", { decision: "approved" }, "idem-3");

    expect(key).toBe("idem-3");
    expect(res.approval.status).toBe("approved");
  });

  it("reviewTask sends the outcome (accepted | changes_requested)", async () => {
    let body: { outcome?: string } = {};
    server.use(
      http.post(`${BASE}/tasks/task_1/review`, async ({ request }) => {
        body = (await request.json()) as { outcome?: string };
        return HttpResponse.json({ task: { id: "task_1", status: "ready" } });
      }),
    );

    const res = await client.reviewTask("task_1", { outcome: "changes_requested" }, "idem-4");

    expect(body.outcome).toBe("changes_requested");
    expect(res.task.status).toBe("ready");
  });

  it("getTask returns an aggregated snapshot (multi-run)", async () => {
    server.use(
      http.get(`${BASE}/tasks/task_1`, () =>
        HttpResponse.json({
          task: { id: "task_1", status: "review" },
          room: { id: "room_1" },
          runs: [{ id: "run_1" }, { id: "run_2" }],
          approvals: [],
          artifacts: [{ id: "artifact_1" }],
        }),
      ),
    );

    const snap = await client.getTask("task_1");

    expect(snap.runs).toHaveLength(2);
    expect(snap.artifacts[0]?.id).toBe("artifact_1");
  });

  it("listTasks consumes the project task-list array from the server", async () => {
    server.use(
      http.get(`${BASE}/tasks`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("project_id")).toBe("proj_1");
        return HttpResponse.json([{ id: "task_1", status: "ready" }]);
      }),
    );

    const tasks = await client.listTasks("proj_1");

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("task_1");
  });

  it("bootstrap consumes the projects array from the server", async () => {
    server.use(
      http.get(`${BASE}/bootstrap`, () =>
        HttpResponse.json({
          organization: { id: "org_default", name: "Org" },
          user: { id: "user_1", email: "jeremy@example.com", display_name: "Jeremy", role: "owner" },
          projects: [{ id: "proj_artoo", name: "artoo", default_workspace: null }],
          actor: { type: "user", id: "user_1" },
        }),
      ),
    );

    const bootstrap = await client.bootstrap();

    expect(bootstrap.projects[0]?.id).toBe("proj_artoo");
  });

  it("throws ApiClientError('network_error') when fetch rejects", async () => {
    const offline = new ApiClient({
      baseUrl: BASE,
      fetch: () => Promise.reject(new Error("offline")),
    });
    await expect(offline.bootstrap()).rejects.toBeInstanceOf(ApiClientError);
    await expect(offline.bootstrap()).rejects.toMatchObject({ code: "network_error" });
  });
});
