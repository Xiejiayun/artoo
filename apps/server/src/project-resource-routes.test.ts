import { agentRuntimes, projects } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("preview project and execution resource setup", () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  it("creates and updates a project idempotently and exposes it through bootstrap", async () => {
    server = await buildTestServer();
    const create = { method: "POST" as const, url: "/api/v1/projects", headers: { "Idempotency-Key": "new-project" }, payload: { name: " Team tools ", default_workspace: "C:/team" } };
    const first = await server.app.inject(create);
    expect(first.statusCode).toBe(201);
    const { project } = first.json();
    expect((await server.app.inject(create)).json()).toEqual(first.json());
    const patch = { method: "PATCH" as const, url: `/api/v1/projects/${project.id}`, headers: { "Idempotency-Key": "edit-project" }, payload: { name: "Renamed" } };
    expect((await server.app.inject(patch)).statusCode).toBe(200);
    expect((await server.app.inject(patch)).json().project.name).toBe("Renamed");
    const bootstrap = (await server.app.inject("/api/v1/bootstrap")).json();
    expect(bootstrap.projects).toContainEqual({ id: project.id, name: "Renamed", default_workspace: "C:/team" });
    expect((await server.db.db.select().from(projects).where(eq(projects.id, project.id))).length).toBe(1);
    expect((await server.app.inject({ method: "PATCH", url: "/api/v1/projects/unknown", payload: { name: "Hidden" } })).statusCode).toBe(404);
  });

  it("configures an advertised runtime and refuses unsupported capabilities or relative roots", async () => {
    server = await buildTestServer();
    await server.db.db.update(agentRuntimes).set({ capabilities: ["code.modify"] }).where(eq(agentRuntimes.id, "runtime_mock"));
    const url = "/api/v1/computers/computer_local_mock/instances";
    expect((await server.app.inject({ method: "POST", url, payload: { runtime: "mock", workspace_root: "../escape" } })).statusCode).toBe(400);
    expect((await server.app.inject({ method: "POST", url, payload: { runtime: "mock", workspace_root: "C:/team", capabilities: ["host.admin"] } })).statusCode).toBe(400);
    const created = await server.app.inject({ method: "POST", url, payload: { runtime: "mock", workspace_root: "C:/team", display_name: "Team coder" } });
    expect(created.statusCode).toBe(201);
    const instance = created.json().agent_instance;
    expect(instance.workspace_root).toBe("C:/team");
    expect(created.json().agent.capabilities).toEqual(["code.modify"]);
    expect((await server.app.inject({ method: "PATCH", url: `/api/v1/agent-instances/${instance.id}`, payload: { enabled: false } })).json().agent_instance.status).toBe("disabled");
    expect((await server.app.inject({ method: "PATCH", url: `/api/v1/agent-instances/${instance.id}`, payload: { enabled: true } })).json().agent_instance.status).toBe("idle");
  });
});
