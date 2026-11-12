import { agentRuntimes, computers, organizations } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { listComputerRuntimes, recordHeartbeatRuntimes } from "./services/runtime-registry-service.js";
import { buildTestServer, fixedClock, type TestServer } from "./test-support.js";

/** A fresh computer with no seeded runtimes, so assertions see only what we add. */
async function freshComputer(server: TestServer, id = "computer_test", organizationId = "org_default"): Promise<string> {
  await server.db.db.insert(computers).values({
    id,
    organizationId,
    displayName: "Test Box",
    hostname: "test-host",
    os: "windows",
    arch: "x64",
    status: "online",
    createdAt: "2026-06-13T00:00:00.000Z",
  });
  return id;
}

async function getRuntimes(server: TestServer, computerId: string) {
  const res = await server.app.inject({
    method: "GET",
    url: `/api/v1/computers/${computerId}/runtimes`,
  });
  return (res.json().runtimes as {
    runtime: string;
    status: string;
    version: string | null;
    capabilities: string[];
    computer_id: string;
    last_seen_at: string | null;
  }[]).sort((a, b) => a.runtime.localeCompare(b.runtime));
}

describe("runtime registry (#15 Part 2)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("persists heartbeat runtimes and exposes status + last_seen_at + capabilities", async () => {
    server = await buildTestServer();
    const computerId = await freshComputer(server);
    await recordHeartbeatRuntimes(server.ctx, computerId, [
      { runtime: "codex", status: "available", capabilities: ["code.read", "code.modify"] },
      { runtime: "claude-code", status: "available", version: "2.1.0", capabilities: [] },
    ]);

    const runtimes = await getRuntimes(server, computerId);
    expect(runtimes).toHaveLength(2);

    const codex = runtimes.find((r) => r.runtime === "codex");
    expect(codex).toMatchObject({
      computer_id: computerId,
      status: "available",
      capabilities: ["code.read", "code.modify"],
    });
    // last_seen_at is stamped with the SERVER clock (heartbeats carry no timestamp);
    // compare the instant, not the timestamptz string format.
    expect(codex).toBeDefined();
    expect(new Date(codex!.last_seen_at as string).toISOString()).toBe("2026-06-13T00:00:00.000Z");

    const cc = runtimes.find((r) => r.runtime === "claude-code");
    expect(cc?.capabilities).toEqual([]); // empty caps stay a stable []
    expect(cc?.version).toBe("2.1.0");
  });

  it("upserts by (computer_id, runtime) on re-heartbeat (no duplicate rows)", async () => {
    server = await buildTestServer();
    const computerId = await freshComputer(server);
    await recordHeartbeatRuntimes(server.ctx, computerId, [
      { runtime: "codex", status: "available", capabilities: ["a"] },
    ]);
    await recordHeartbeatRuntimes(server.ctx, computerId, [
      { runtime: "codex", status: "disabled", capabilities: ["a", "b"] },
    ]);

    const runtimes = await getRuntimes(server, computerId);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]).toMatchObject({ status: "disabled", capabilities: ["a", "b"] });
  });

  it("returns [] for a computer with no advertised runtimes", async () => {
    server = await buildTestServer();
    const computerId = await freshComputer(server);
    expect(await getRuntimes(server, computerId)).toEqual([]);
  });

  it("projects native inventories through HTTP, replaces snapshots and preserves unrelated metadata", async () => {
    server = await buildTestServer();
    const computerId = await freshComputer(server);
    const native = { version: 1 as const, observed_at: "2026-11-12T00:00:00Z", skills: [{ id: "testing", name: "Testing", description: "Run tests", path: "/skills/testing/SKILL.md", scope: "user" as const }], truncated: false, unreadable_count: 0 };
    const runtime = { runtime: "codex", status: "available" as const, capabilities: [] };
    await recordHeartbeatRuntimes(server.ctx, computerId, [{ ...runtime, native_skills: native }]);
    const response = await server.app.inject({ method: "GET", url: `/api/v1/computers/${computerId}/runtimes` });
    expect(response.statusCode).toBe(200);
    expect(response.json().runtimes[0].native_skills).toEqual(native);
    await server.db.db.update(agentRuntimes).set({ metadata: { native_skills: native, existing: "retained" } }).where(eq(agentRuntimes.computerId, computerId));
    await recordHeartbeatRuntimes(server.ctx, computerId, [{ ...runtime, native_skills: { ...native, skills: [] } }]);
    expect((await listComputerRuntimes(server.ctx, computerId))[0]?.native_skills?.skills).toEqual([]);
    await recordHeartbeatRuntimes(server.ctx, computerId, [runtime]);
    expect((await listComputerRuntimes(server.ctx, computerId))[0]?.native_skills).toBeUndefined();
    const [stored] = await server.db.db.select().from(agentRuntimes).where(eq(agentRuntimes.computerId, computerId));
    expect(stored?.metadata).toEqual({ existing: "retained" });
  });

  it("reconciles omitted and empty runtime snapshots without refreshing historical observations", async () => {
    server = await buildTestServer();
    const computerId = await freshComputer(server);
    await recordHeartbeatRuntimes(server.ctx, computerId, [
      { runtime: "codex", status: "available", version: "1", capabilities: ["code.read"] },
      { runtime: "claude-code", status: "available", version: "2", capabilities: ["code.modify"] },
    ]);
    const before = await getRuntimes(server, computerId);
    const later = { ...server.ctx, clock: fixedClock("2026-06-13T00:01:00.000Z") };
    await recordHeartbeatRuntimes(later, computerId, [{ runtime: "codex", status: "available", version: "1", capabilities: ["code.read"] }]);
    const partial = await getRuntimes(server, computerId);
    expect(partial.find((runtime) => runtime.runtime === "claude-code")).toEqual({ ...before.find((runtime) => runtime.runtime === "claude-code"), status: "missing" });
    expect(new Date(partial.find((runtime) => runtime.runtime === "codex")!.last_seen_at!).toISOString()).toBe(later.clock.nowIso());

    await recordHeartbeatRuntimes({ ...server.ctx, clock: fixedClock("2026-06-13T00:02:00.000Z") }, computerId, []);
    expect(await getRuntimes(server, computerId)).toEqual(partial.map((runtime) => ({ ...runtime, status: "missing" })));
    const registration = await server.app.inject({ method: "POST", url: `/api/v1/computers/${computerId}/instances`,
      payload: { runtime: "codex", workspace_root: "/workspace" } });
    expect(registration.statusCode).toBe(409);
    expect(registration.body).toContain("advertise an available runtime");

    await recordHeartbeatRuntimes({ ...server.ctx, clock: fixedClock("2026-06-13T00:03:00.000Z") }, computerId,
      [{ runtime: "codex", status: "available", version: "3", capabilities: ["code.read", "code.modify"] }]);
    const restored = await getRuntimes(server, computerId);
    expect(restored).toHaveLength(2);
    expect(restored.find((runtime) => runtime.runtime === "codex")).toMatchObject({ status: "available", version: "3", capabilities: ["code.read", "code.modify"] });
    expect(restored.find((runtime) => runtime.runtime === "claude-code")).toEqual(partial.find((runtime) => runtime.runtime === "claude-code"));
  });

  it("scopes snapshot reconciliation to its organization and authenticated computer", async () => {
    server = await buildTestServer();
    const target = await freshComputer(server), sibling = await freshComputer(server, "computer_sibling");
    await server.db.db.insert(organizations).values({ id: "org_other", name: "Other", createdAt: server.ctx.clock.nowIso() });
    const foreign = await freshComputer(server, "computer_foreign", "org_other");
    const foreignContext = { ...server.ctx, organizationId: "org_other" };
    const snapshot = [{ runtime: "codex", status: "available" as const, capabilities: ["code.read"] }];
    for (const id of [target, sibling]) await recordHeartbeatRuntimes(server.ctx, id, snapshot);
    await recordHeartbeatRuntimes(foreignContext, foreign, snapshot);
    const siblingBefore = await listComputerRuntimes(server.ctx, sibling), foreignBefore = await listComputerRuntimes(foreignContext, foreign);
    await recordHeartbeatRuntimes(server.ctx, target, []);
    await expect(recordHeartbeatRuntimes(server.ctx, foreign, [])).rejects.toMatchObject({ httpStatus: 404 });
    await expect(recordHeartbeatRuntimes(server.ctx, foreign, [{ ...snapshot[0]!, status: "disabled" }])).rejects.toMatchObject({ httpStatus: 404 });
    expect(await listComputerRuntimes(server.ctx, target)).toEqual([expect.objectContaining({ status: "missing" })]);
    expect(await listComputerRuntimes(server.ctx, sibling)).toEqual(siblingBefore);
    expect(await listComputerRuntimes(foreignContext, foreign)).toEqual(foreignBefore);
  });
});
