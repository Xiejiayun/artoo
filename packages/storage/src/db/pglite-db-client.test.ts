import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { PgliteDbClient } from "./pglite-db-client.js";

interface CountRow {
  c: number;
}

describe("PgliteDbClient", () => {
  let client: PgliteDbClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("migrates, then executes and queries", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(["create table t (id text primary key, n int not null)"]);
    await client.db.execute(sql`insert into t (id, n) values ('a', 1)`);
    const res = await client.db.execute(sql`select n from t where id = 'a'`);
    expect((res.rows[0] as { n: number }).n).toBe(1);
  });

  it("healthCheck returns true on a live db", async () => {
    client = await PgliteDbClient.create();
    expect(await client.healthCheck()).toBe(true);
  });

  it("rolls back the whole transaction when fn throws", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(["create table t (id text primary key)"]);
    await expect(
      client.transaction(async (tx) => {
        await tx.execute(sql`insert into t (id) values ('x')`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const res = await client.db.execute(sql`select count(*)::int as c from t`);
    expect((res.rows[0] as CountRow).c).toBe(0);
  });

  it("commits a successful transaction", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(["create table t (id text primary key)"]);
    await client.transaction(async (tx) => {
      await tx.execute(sql`insert into t (id) values ('y')`);
    });
    const res = await client.db.execute(sql`select count(*)::int as c from t`);
    expect((res.rows[0] as CountRow).c).toBe(1);
  });
});
