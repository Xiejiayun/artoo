import { projects } from "@artoo/db";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

const PROJECT = "proj_artoo";

function researchSkill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api_version: "v1alpha1",
    id: "web-research",
    name: "Web Research",
    version: "1.0.0",
    capabilities: ["research.web"],
    compatible_runtimes: ["mock"],
    permissions: { network: { outbound: ["search.example.com"] } },
    ...overrides,
  };
}

async function installSkill(
  server: TestServer,
  payload: Record<string, unknown>,
) {
  return server.app.inject({
    method: "POST",
    url: "/api/v1/skills/install",
    payload,
  });
}

async function createReadyTask(server: TestServer, requiredCapabilities: string[]): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: PROJECT,
      title: "skill routed task",
      acceptance_criteria: ["done"],
      required_capabilities: requiredCapabilities,
    },
  });
  const id = created.json().task.id as string;
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` });
  return id;
}

async function assign(server: TestServer, taskId: string) {
  return server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`,
    payload: { mode: "auto" },
  });
}

async function createOtherProject(server: TestServer): Promise<string> {
  const id = "proj_other";
  await server.db.db.insert(projects).values({
    id,
    organizationId: "org_default",
    name: "other",
    defaultWorkspace: "C:/workspace/other",
    createdAt: server.ctx.clock.nowIso(),
  });
  return id;
}

describe("skill install API (#24)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("installs a validated manifest and exposes derived read-model fields", async () => {
    server = await buildTestServer();

    const created = await installSkill(server, {
      manifest: researchSkill(),
      enabled: true,
    });

    expect(created.statusCode).toBe(201);
    const skill = created.json().skill;
    expect(skill.id).toBe("skill_000001");
    expect(skill.skill_id).toBe("web-research");
    expect(skill.capabilities).toEqual(["research.web"]);
    expect(skill.compatible_runtimes).toEqual(["mock"]);
    expect(skill.permission_summary.categories).toEqual(["network"]);
    expect(skill.permission_summary.risk).toBe("medium");
    expect(skill.installed_by_type).toBe("user");

    const list = await server.app.inject({ method: "GET", url: "/api/v1/skills" });
    expect(list.statusCode).toBe(200);
    expect(list.json().skills.map((entry: { id: string }) => entry.id)).toEqual([skill.id]);

    const get = await server.app.inject({ method: "GET", url: `/api/v1/skills/${skill.id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().skill.id).toBe(skill.id);
  });

  it("rejects invalid manifests and unknown project scopes", async () => {
    server = await buildTestServer();

    const invalid = await installSkill(server, {
      manifest: researchSkill({ compatible_runtimes: [] }),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("validation_error");

    const unknownProject = await installSkill(server, {
      project_id: "proj_missing",
      manifest: researchSkill(),
    });
    expect(unknownProject.statusCode).toBe(404);
    expect(unknownProject.json().error.code).toBe("not_found");
  });

  it("lists by enabled state and effective project scope", async () => {
    server = await buildTestServer();
    const otherProject = await createOtherProject(server);

    const orgWide = (
      await installSkill(server, { manifest: researchSkill({ id: "org-wide", name: "Org Wide" }) })
    ).json().skill;
    const projectScoped = (
      await installSkill(server, {
        project_id: PROJECT,
        manifest: researchSkill({ id: "project", name: "Project" }),
        enabled: false,
      })
    ).json().skill;
    await installSkill(server, {
      project_id: otherProject,
      manifest: researchSkill({ id: "other", name: "Other" }),
    });

    const effective = await server.app.inject({
      method: "GET",
      url: `/api/v1/skills?project_id=${PROJECT}`,
    });
    expect(effective.json().skills.map((entry: { id: string }) => entry.id)).toEqual([
      orgWide.id,
      projectScoped.id,
    ]);

    const enabledOnly = await server.app.inject({
      method: "GET",
      url: "/api/v1/skills?enabled=true",
    });
    expect(enabledOnly.json().skills.map((entry: { skill_id: string }) => entry.skill_id)).toEqual([
      "org-wide",
      "other",
    ]);

    const badFilter = await server.app.inject({
      method: "GET",
      url: "/api/v1/skills?enabled=yes",
    });
    expect(badFilter.statusCode).toBe(400);
  });

  it("404s an unknown install", async () => {
    server = await buildTestServer();
    const res = await server.app.inject({ method: "GET", url: "/api/v1/skills/skill_missing" });
    expect(res.statusCode).toBe(404);
  });
});

describe("scheduler skill capability contribution (#24)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("uses enabled skills compatible with the candidate runtime to satisfy required capabilities", async () => {
    server = await buildTestServer();
    await installSkill(server, { manifest: researchSkill() });

    const task = await createReadyTask(server, ["research.web"]);
    const res = await assign(server, task);

    expect(res.statusCode).toBe(200);
    expect(res.json().run.runtime_id).toBe("mock");
  });

  it("does not use disabled skills or runtime-incompatible skills", async () => {
    server = await buildTestServer();
    await installSkill(server, { manifest: researchSkill({ id: "disabled" }), enabled: false });
    const disabledTask = await createReadyTask(server, ["research.web"]);
    expect((await assign(server, disabledTask)).statusCode).toBe(409);

    await installSkill(server, {
      manifest: researchSkill({ id: "claude-only", compatible_runtimes: ["claude-code"] }),
    });
    const mismatchTask = await createReadyTask(server, ["research.web"]);
    expect((await assign(server, mismatchTask)).statusCode).toBe(409);
  });

  it("does not let a skill scoped to another project satisfy this project's task", async () => {
    server = await buildTestServer();
    const otherProject = await createOtherProject(server);
    await installSkill(server, {
      project_id: otherProject,
      manifest: researchSkill({ id: "other-project" }),
    });

    const task = await createReadyTask(server, ["research.web"]);
    const res = await assign(server, task);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("runtime_unavailable");
  });
});
