import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { appendEvent, type EventInput } from "./event-writer.js";
import { createMigratedClient, TEST_NOW, TEST_ORG } from "./test-support.js";

function eventInput(id: string, type: string): EventInput {
  return {
    id,
    organizationId: TEST_ORG,
    type,
    schemaVersion: "2026-06-11",
    actorType: "system",
    actorId: "sys",
    correlationId: "corr_1",
    occurredAt: TEST_NOW,
  };
}

async function countEvents(client: PgliteDbClient): Promise<number> {
  const res = await client.db.execute(sql`select count(*)::int as c from event_log`);
  return (res.rows[0] as { c: number }).c;
}

describe("appendEvent", () => {
  let client: PgliteDbClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("assigns a globally monotonic position across appends", async () => {
    client = await createMigratedClient();
    const a = await client.transaction((tx) => appendEvent(tx, eventInput("evt_1", "task.created")));
    const b = await client.transaction((tx) => appendEvent(tx, eventInput("evt_2", "task.updated")));
    const c = await client.transaction((tx) => appendEvent(tx, eventInput("evt_3", "run.started")));
    expect(a.position).toBeLessThan(b.position);
    expect(b.position).toBeLessThan(c.position);
  });

  it("rolls back the event when the surrounding transaction throws", async () => {
    client = await createMigratedClient();
    await expect(
      client.transaction(async (tx) => {
        await appendEvent(tx, eventInput("evt_x", "task.created"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await countEvents(client)).toBe(0);
  });
});
