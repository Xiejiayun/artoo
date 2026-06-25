// @vitest-environment node
import { agentInstances, agentRuntimes, devices } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * #113 slice 5 — scheduler eligibility regression. Covers the INTENTIONAL
 * behavior change (capacity replaces idle gate; device-revoked exclusion) and
 * locks the preserved behaviors (admin guard, stale status not busy, no-device
 * legacy still eligible, missing-runtime fallback). Does NOT depend on the gated
 * #111 smoke.
 */
describe("scheduler eligibility #113 slice 5", () => {
  let srv: TestServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  async function readyTask(caps: string[] = ["code.modify"]): Promise<string> {
    const r = await srv!.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { project_id: "proj_artoo", title: "t", acceptance_criteria: ["a"], required_capabilities: caps },
    });
    const id = r.json().task.id as string;
    await srv!.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` });
    return id;
  }
  const assign = (taskId: string) =>
    srv!.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });

  it("capacity available: a fresh idle instance is eligible", async () => {
    srv = await buildTestServer();
    expect((await assign(await readyTask())).statusCode).toBeLessThan(300);
  });

  it("capacity full: a second assign is rejected (1 active run >= limit 1)", async () => {
    srv = await buildTestServer();
    expect((await assign(await readyTask())).statusCode).toBeLessThan(300); // run1 queued (non-terminal)
    const second = await assign(await readyTask());
    expect(second.statusCode).toBe(409);
  });

  it("admin status disabled/stopping/failed excludes the instance", async () => {
    for (const status of ["disabled", "stopping", "failed"]) {
      srv = await buildTestServer();
      await srv.db.db.update(agentInstances).set({ status }).where(eq(agentInstances.id, "instance_mock_coder"));
      expect((await assign(await readyTask())).statusCode).toBe(409);
      await srv.close();
      srv = undefined;
    }
  });

  it("stale 'running' instance status is NOT busy by itself (capacity decides) — still eligible", async () => {
    srv = await buildTestServer();
    await srv.db.db.update(agentInstances).set({ status: "running" }).where(eq(agentInstances.id, "instance_mock_coder"));
    expect((await assign(await readyTask())).statusCode).toBeLessThan(300); // 0 active runs => eligible
  });

  it("a bound REVOKED device excludes the candidate", async () => {
    srv = await buildTestServer();
    await srv.db.db.insert(devices).values({
      id: "device_revoked",
      organizationId: "org_default",
      displayName: "old",
      platform: "windows",
      appVersion: "2.0.0",
      computerId: "computer_local_mock",
      enrolledByUserId: "user_owner",
      trust: "revoked",
      lastSeenAt: null,
      createdAt: "2026-06-13T00:00:00.000Z",
      revokedAt: "2026-06-13T00:00:00.000Z",
    });
    expect((await assign(await readyTask())).statusCode).toBe(409);
  });

  it("no bound device (legacy seed) stays eligible", async () => {
    srv = await buildTestServer();
    const devs = await srv.db.db.select().from(devices).where(eq(devices.computerId, "computer_local_mock"));
    expect(devs.length).toBe(0); // seed has no device bound
    expect((await assign(await readyTask())).statusCode).toBeLessThan(300);
  });

  it("missing-runtime-row fallback unchanged: absent runtime still permits non-runtime caps", async () => {
    srv = await buildTestServer();
    await srv.db.db
      .delete(agentRuntimes)
      .where(and(eq(agentRuntimes.computerId, "computer_local_mock"), eq(agentRuntimes.runtime, "mock")));
    // code.modify is an agent/computer cap (not runtime-only) -> fallback eligible.
    expect((await assign(await readyTask(["code.modify"]))).statusCode).toBeLessThan(300);
  });
});
