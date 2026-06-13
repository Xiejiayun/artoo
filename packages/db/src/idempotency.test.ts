import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import type { EventInput } from "./event-writer.js";
import { runIdempotent } from "./idempotency.js";
import { createMigratedClient, TEST_NOW, TEST_ORG } from "./test-support.js";

function eventInput(id: string, type: string): EventInput {
  return {
    id,
    organizationId: TEST_ORG,
    type,
    schemaVersion: "2026-06-11",
    actorType: "system",
    actorId: "sys",
    correlationId: "corr",
    occurredAt: TEST_NOW,
  };
}

async function countEvents(client: PgliteDbClient): Promise<number> {
  const res = await client.db.execute(sql`select count(*)::int as c from event_log`);
  return (res.rows[0] as { c: number }).c;
}

describe("runIdempotent", () => {
  let client: PgliteDbClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("first call runs fn and persists its events + response", async () => {
    client = await createMigratedClient();
    const result = await runIdempotent(
      client,
      { scope: "task:t1:assign:run_1", key: "run_1", requestHash: "h1", now: TEST_NOW },
      async () => ({ response: { runId: "run_1" }, events: [eventInput("evt_1", "task.assigned")] }),
    );
    expect(result.replayed).toBe(false);
    expect(result.response).toEqual({ runId: "run_1" });
    expect(result.eventIds).toEqual(["evt_1"]);
    expect(await countEvents(client)).toBe(1);
  });

  it("replay returns the original response and writes no new events", async () => {
    client = await createMigratedClient();
    const params = { scope: "task:t1:assign:run_1", key: "run_1", requestHash: "h1", now: TEST_NOW };
    const first = await runIdempotent(client, params, async () => ({
      response: { runId: "run_1" },
      events: [eventInput("evt_1", "task.assigned")],
    }));

    let secondFnRan = false;
    const second = await runIdempotent(client, params, async () => {
      secondFnRan = true;
      return { response: { runId: "DIFFERENT" }, events: [eventInput("evt_2", "task.assigned")] };
    });

    expect(second.replayed).toBe(true);
    expect(secondFnRan).toBe(false);
    expect(second.response).toEqual(first.response);
    expect(await countEvents(client)).toBe(1);
  });

  it("attempt-scoped: a retry under a new run scope is independent (Round 17 trap)", async () => {
    client = await createMigratedClient();
    await runIdempotent(
      client,
      { scope: "task:t1:assign:run_1", key: "run_1", requestHash: "h", now: TEST_NOW },
      async () => ({ response: {}, events: [eventInput("evt_a", "task.assigned")] }),
    );
    // retry creates run_2 -> different attempt scope -> NOT deduped against run_1
    const retry = await runIdempotent(
      client,
      { scope: "task:t1:assign:run_2", key: "run_2", requestHash: "h", now: TEST_NOW },
      async () => ({ response: {}, events: [eventInput("evt_b", "task.assigned")] }),
    );
    expect(retry.replayed).toBe(false);
    // both task.assigned events survive — the bug a task-scoped key would cause
    expect(await countEvents(client)).toBe(2);
  });

  it("rejects key reuse with a different request hash", async () => {
    client = await createMigratedClient();
    const params = { scope: "s", key: "k", requestHash: "h1", now: TEST_NOW };
    await runIdempotent(client, params, async () => ({ response: {}, events: [] }));
    await expect(
      runIdempotent(client, { ...params, requestHash: "h2" }, async () => ({
        response: {},
        events: [],
      })),
    ).rejects.toThrow();
  });
});
