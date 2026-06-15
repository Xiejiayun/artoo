import type { PgliteDbClient } from "@artoo/storage";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { memories } from "./schema.js";
import { createMigratedClient, TEST_NOW, TEST_ORG } from "./test-support.js";

describe("memories table (#21)", () => {
  let client: PgliteDbClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("inserts and reads back a memory row", async () => {
    client = await createMigratedClient();
    await client.db.insert(memories).values({
      id: "mem_1",
      organizationId: TEST_ORG,
      status: "proposed",
      scope: "project",
      authorType: "user",
      authorId: "user_1",
      confidence: "0.80",
      text: "prefer async/await",
      tags: ["coding"],
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
    });
    const [row] = await client.db.select().from(memories).where(eq(memories.id, "mem_1"));
    expect(row?.status).toBe("proposed");
    expect(row?.scope).toBe("project");
    expect(Number(row?.confidence)).toBe(0.8);
    expect(row?.tags).toEqual(["coding"]);
  });

  it("enforces the status check constraint", async () => {
    client = await createMigratedClient();
    await expect(
      client.db.insert(memories).values({
        id: "mem_bad",
        organizationId: TEST_ORG,
        status: "weird",
        scope: "project",
        authorType: "user",
        authorId: "u",
        confidence: "1",
        text: "x",
        tags: [],
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      }),
    ).rejects.toThrow();
  });
});
