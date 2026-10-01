import { tasks } from "@artoo/db";
import type { DrizzleDb } from "@artoo/storage";
import { afterEach, describe, expect, it } from "vitest";

import { getTaskSnapshot } from "./services/task-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("task snapshot version consistency", () => {
  let server: TestServer | undefined;
  afterEach(async () => { await server?.close(); });

  it("cannot label an old task/review/artifact snapshot with a concurrent review's new version", async () => {
    server = await buildTestServer();
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Snapshot boundary", acceptance_criteria: ["Reviewed"], required_capabilities: ["code.modify"],
    } });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
    expect(assigned.statusCode).toBe(200);
    const completed = await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${assigned.json().run.id}/mock-execute` });
    expect(completed.statusCode).toBe(200);
    const before = await getTaskSnapshot(server.ctx, taskId);
    expect(before.task.status).toBe("review");
    expect(before.artifacts).toHaveLength(1);

    const taskRead = signal(), continueRead = signal(), mutationQueued = signal();
    let paused = false;
    // Intercept only this snapshot's real Drizzle query, both with and without
    // its transaction. No row, event, version or query result is fabricated.
    const wrap = (db: DrizzleDb): DrizzleDb => new Proxy(db, {
      get(target, key) {
        if (key === "select") return (...args: unknown[]) => {
          const builder = Reflect.apply(target.select, target, args);
          const from = builder.from.bind(builder);
          builder.from = (table: unknown) => {
            const query = from(table);
            if (table === tasks && !paused) {
              const execute = query.execute.bind(query);
              query.execute = async () => {
                const rows = await execute();
                if (!paused) {
                  paused = true;
                  taskRead.resolve();
                  await continueRead.promise;
                }
                return rows;
              };
            }
            return query;
          };
          return builder;
        };
        if (key === "transaction") return (fn: (tx: DrizzleDb) => Promise<unknown>, ...args: unknown[]) =>
          Reflect.apply(target.transaction, target, [(tx: DrizzleDb) => fn(wrap(tx)), ...args]);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const originalClient = server.ctx.db;
    server.ctx.db = new Proxy(originalClient, {
      get(target, key) {
        if (key === "transaction") return (...args: unknown[]) => {
          const pending = Reflect.apply(target.transaction, target, args);
          mutationQueued.resolve();
          return pending;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const snapshotClient = new Proxy(originalClient, {
      get(target, key) {
        if (key === "db") return wrap(target.db);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const inFlight = getTaskSnapshot({ ...server.ctx, db: snapshotClient }, taskId);
    await taskRead.promise;
    const write = server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/review`,
      payload: { outcome: "changes_requested", comment: "Concurrent correction", base_version: before.version_cursor } }).then((value) => value);
    await mutationQueued.promise;
    continueRead.resolve();
    const [during, reviewed] = await Promise.all([inFlight, write]);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const after = await getTaskSnapshot(server.ctx, taskId);
    expect(after.task.status).toBe("ready");
    expect(after.version_cursor).toBeGreaterThan(before.version_cursor);
    // PGlite has one connection: a snapshot transaction queues the actual
    // review write until all snapshot reads finish. This is not a claim that
    // a multi-connection Postgres concurrency test ran here.
    expect(during).toEqual(before);
  });
});
