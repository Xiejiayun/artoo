import { agentRuntimes } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

/** The seed's runtime row for the mock instance's runtime ("mock"). */
const RUNTIME_MOCK = "runtime_mock";

async function createReadyTask(server: TestServer, requiredCapabilities: string[]): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "t",
      acceptance_criteria: ["x"],
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

async function patchRuntimeMock(server: TestServer, patch: Record<string, unknown>): Promise<void> {
  await server.db.db.update(agentRuntimes).set(patch).where(eq(agentRuntimes.id, RUNTIME_MOCK));
}

describe("#15 Part 3 scheduler runtime eligibility", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("seeded fresh runtime row keeps existing mock flows schedulable (regression)", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server, ["code.modify"]);
    expect((await assign(server, task)).statusCode).toBe(200);
  });

  it("routes a runtime-only required capability only when a fresh row reports it", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server, ["browser.navigate"]);
    // Default: neither agent nor computer nor runtime caps include browser.navigate.
    const before = await assign(server, task);
    expect(before.statusCode).toBe(409);
    expect(before.json().error.code).toBe("runtime_unavailable");

    // Grant it via the runtime row -> now in the matching pool.
    await patchRuntimeMock(server, { capabilities: ["browser.navigate"] });
    const after = await assign(server, task);
    expect(after.statusCode).toBe(200);
    expect(after.json().run.runtime_id).toBe("mock");
  });

  it("excludes an instance whose runtime row is disabled", async () => {
    server = await buildTestServer();
    await patchRuntimeMock(server, { status: "disabled" });
    const task = await createReadyTask(server, ["code.modify"]);
    const res = await assign(server, task);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("runtime_unavailable");
  });

  it("excludes an instance whose runtime row is stale or has no last_seen_at", async () => {
    server = await buildTestServer();
    await patchRuntimeMock(server, { lastSeenAt: "2026-06-12T00:00:00.000Z" }); // ~1 day old
    const stale = await createReadyTask(server, ["code.modify"]);
    expect((await assign(server, stale)).statusCode).toBe(409);

    await patchRuntimeMock(server, { lastSeenAt: null }); // present row, no timestamp -> bad
    const nullSeen = await createReadyTask(server, ["code.modify"]);
    expect((await assign(server, nullSeen)).statusCode).toBe(409);
  });

  it("falls back when the runtime row is missing (no gating), but cannot grant runtime-only caps", async () => {
    server = await buildTestServer();
    await server.db.db.delete(agentRuntimes).where(eq(agentRuntimes.id, RUNTIME_MOCK));

    // agent/computer caps still satisfy a non-runtime-only capability.
    const ok = await createReadyTask(server, ["code.modify"]);
    expect((await assign(server, ok)).statusCode).toBe(200);

    // but a runtime-only capability cannot be satisfied without a row.
    const blocked = await createReadyTask(server, ["browser.navigate"]);
    expect((await assign(server, blocked)).statusCode).toBe(409);
  });
});
