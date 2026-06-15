import { computers } from "@artoo/db";
import { afterEach, describe, expect, it } from "vitest";

import { recordHeartbeatRuntimes } from "./services/runtime-registry-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

/** A fresh computer with no seeded runtimes, so assertions see only what we add. */
async function freshComputer(server: TestServer): Promise<string> {
  const id = "computer_test";
  await server.db.db.insert(computers).values({
    id,
    organizationId: "org_default",
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
  return res.json().runtimes as {
    runtime: string;
    status: string;
    version: string | null;
    capabilities: string[];
    computer_id: string;
    last_seen_at: string | null;
  }[];
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
});
