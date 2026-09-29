import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("preserves data across disk reopen and applies only appended migrations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artoo-migration-test-"));
    const initial = "create table durable (id text primary key)";
    try {
      client = await PgliteDbClient.create({ dataDir: directory });
      await client.migrate([initial]);
      await client.db.execute(sql`insert into durable (id) values ('kept')`);
      await client.close();
      client = await PgliteDbClient.create({ dataDir: directory });
      await client.migrate([initial, "alter table durable add column title text default 'upgraded'"]);
      await client.migrate([initial, "alter table durable add column title text default 'upgraded'"]);
      const result = await client.db.execute(sql`select id, title from durable`);
      expect(result.rows).toEqual([{ id: "kept", title: "upgraded" }]);
    } finally {
      await client?.close();
      client = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a failed upgrade and allows a corrected retry", async () => {
    client = await PgliteDbClient.create();
    const initial = "create table original (id text primary key)";
    await client.migrate([initial]);
    await client.db.execute(sql`insert into original values ('survives')`);
    await expect(client.migrate([initial, "create table added (id int)", "invalid SQL"])).rejects.toThrow();
    const result = await client.db.execute(sql`select to_regclass('public.added') as name`);
    expect(result.rows).toEqual([{ name: null }]);
    await client.migrate([initial, "create table added (id int)"]);
    expect((await client.db.execute(sql`select * from original`)).rows).toEqual([{ id: "survives" }]);
  });

  it("refuses history edits and downgrades without changing existing data", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(["create table original (id text primary key)"]);
    await expect(client.migrate(["create table different (id text)"])).rejects.toThrow("Migration history changed");
    await expect(client.migrate([])).rejects.toThrow("Migration history changed");
    expect(await client.healthCheck()).toBe(true);
  });

  it("restores a backup with both user data and migration history", async () => {
    client = await PgliteDbClient.create();
    const statements = ["create table documents (id text primary key, body text)"];
    await client.migrate(statements);
    await client.db.execute(sql`insert into documents values ('doc', 'important work')`);
    const archive = await client.backup();
    await client.close();
    client = await PgliteDbClient.create({ archive });
    await client.migrate(statements);
    expect((await client.db.execute(sql`select * from documents`)).rows).toEqual([{ id: "doc", body: "important work" }]);
  });

  it("adopts only an exactly matching legacy schema and keeps its data", async () => {
    client = await PgliteDbClient.create();
    await client.db.execute(sql`create table legacy (id text primary key)`);
    await client.db.execute(sql`insert into legacy values ('saved')`);
    await expect(client.migrate(["create table legacy (id text primary key)"])).rejects.toThrow("untracked legacy schema");
    await expect(client.adoptLegacyMigrations(["create table legacy (id integer primary key)"])).rejects.toThrow("Adoption refused");
    const statements = ["create table legacy (id text primary key)"];
    await client.adoptLegacyMigrations(statements);
    await client.migrate(statements);
    expect((await client.db.execute(sql`select * from legacy`)).rows).toEqual([{ id: "saved" }]);
  });
});
