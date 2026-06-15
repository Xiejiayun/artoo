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

  it("listTasks consumes the wrapped project task-list from the server", async () => {
    server.use(
      http.get(`${BASE}/tasks`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("project_id")).toBe("proj_1");
        return HttpResponse.json({ tasks: [{ id: "task_1", status: "ready" }] });
      }),
    );

    const tasks = await client.listTasks("proj_1");

    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0]?.id).toBe("task_1");
  });

  it("bootstrap consumes the projects array from the server", async () => {
    server.use(
      http.get(`${BASE}/bootstrap`, () =>
        HttpResponse.json({
          organization: { id: "org_default", name: "Org" },
          user: { id: "user_1", email: "jeremy@example.com", display_name: "Jeremy", role: "owner" },
          projects: [{ id: "proj_artoo", name: "artoo", default_workspace: null }],
          computers: [{ id: "computer_local_mock", display_name: "Local Mock" }],
          agents: [{ id: "agent_mock_coder", display_name: "Mock Coder" }],
          agent_instances: [{ id: "instance_mock_coder", runtime: "mock" }],
          model_profiles: [{ id: "model_standard_coding", name: "standard_coding" }],
          effort_profiles: [{ id: "effort_standard_coding", name: "standard_coding" }],
          actor: { type: "user", id: "user_1" },
        }),
      ),
    );

    const bootstrap = await client.bootstrap();

    expect(bootstrap.projects[0]?.id).toBe("proj_artoo");
    expect(bootstrap.computers[0]?.id).toBe("computer_local_mock");
    expect(bootstrap.agent_instances[0]?.runtime).toBe("mock");
  });

  it("listComputerRuntimes fetches heartbeat-backed runtime rows", async () => {
    server.use(
      http.get(`${BASE}/computers/computer_local_mock/runtimes`, () =>
        HttpResponse.json({
          runtimes: [
            {
              id: "runtime_mock",
              computer_id: "computer_local_mock",
              runtime: "mock",
              status: "available",
              capabilities: ["code.modify"],
            },
          ],
        }),
      ),
    );

    const res = await client.listComputerRuntimes("computer_local_mock");

    expect(res.runtimes[0]?.runtime).toBe("mock");
    expect(res.runtimes[0]?.capabilities).toEqual(["code.modify"]);
  });

  it("listSkillInstalls fetches durable installed skill rows", async () => {
    server.use(
      http.get(`${BASE}/skills`, () =>
        HttpResponse.json({
          skills: [
            {
              id: "skill_1",
              name: "Web Research",
              skill_id: "web-research",
              enabled: true,
              capabilities: ["research.web"],
              compatible_runtimes: ["mock"],
              permission_summary: { risk: "medium", categories: ["network"] },
            },
          ],
        }),
      ),
    );

    const res = await client.listSkillInstalls();

    expect(res.skills[0]?.name).toBe("Web Research");
    expect(res.skills[0]?.capabilities).toEqual(["research.web"]);
  });

  it("getTaskAuditBundle fetches the read-only task evidence bundle", async () => {
    server.use(
      http.get(`${BASE}/tasks/task_1/audit-bundle`, () =>
        HttpResponse.json({
          bundle: {
            task: { id: "task_1", status: "review" },
            room: null,
            messages: [],
            runs: [{ id: "run_1" }],
            artifacts: [],
            approvals: [],
            scheduler_decisions: [],
            events: [{ id: "evt_1", type: "task.assigned", position: 1 }],
          },
        }),
      ),
    );

    const res = await client.getTaskAuditBundle("task_1");

    expect(res.bundle.task.id).toBe("task_1");
    expect(res.bundle.runs[0]?.id).toBe("run_1");
    expect(res.bundle.events[0]?.position).toBe(1);
  });

  it("getTaskAuditBundleExport fetches the shareable audit proof envelope", async () => {
    server.use(
      http.get(`${BASE}/tasks/task_1/audit-bundle/export`, () =>
        HttpResponse.json({
          export: {
            schema_version: "v1alpha1",
            exported_at: "2026-06-13T00:00:00.000Z",
            bundle_sha256: `sha256:${"a".repeat(64)}`,
            bundle: {
              task: { id: "task_1", status: "review" },
              room: null,
              messages: [],
              runs: [],
              artifacts: [],
              approvals: [],
              scheduler_decisions: [],
              events: [],
            },
            signature: null,
            signing: {
              status: "deferred",
              reason: "v1 does not manage signing keys yet",
            },
          },
        }),
      ),
    );

    const res = await client.getTaskAuditBundleExport("task_1");

    expect(res.export.schema_version).toBe("v1alpha1");
    expect(res.export.bundle.task.id).toBe("task_1");
    expect(res.export.signing.status).toBe("deferred");
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
