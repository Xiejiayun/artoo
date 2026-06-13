import { loadMigrationStatements, seed } from "@artoo/db";
import type { Clock, IdGen } from "@artoo/domain";
import { PgliteDbClient } from "@artoo/storage";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import type { ServerContext } from "./context.js";
import { createNodeRegistry, type NodeRegistry } from "./ws/node-registry.js";

const FIXED_ISO = "2026-06-13T00:00:00.000Z";

/** Deterministic clock (Gate 0) — every test sees the same timestamp. */
export function fixedClock(iso: string = FIXED_ISO): Clock {
  const date = new Date(iso);
  return { now: () => date, nowIso: () => iso };
}

/** Deterministic, per-prefix counter IdGen so ids are stable/asserts-friendly. */
export function sequentialIdGen(): IdGen {
  const counters = new Map<string, number>();
  return {
    generate: (prefix: string): string => {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}_${String(next).padStart(6, "0")}`;
    },
  };
}

export interface TestServer {
  app: FastifyInstance;
  ctx: ServerContext;
  db: PgliteDbClient;
  nodeRegistry: NodeRegistry;
  close: () => Promise<void>;
}

/** A fully wired server over an embedded, migrated, seeded database. */
export async function buildTestServer(): Promise<TestServer> {
  const db = await PgliteDbClient.create();
  await db.migrate(await loadMigrationStatements());
  await seed(db, FIXED_ISO);
  const ctx: ServerContext = {
    db,
    clock: fixedClock(),
    idGen: sequentialIdGen(),
    organizationId: "org_default",
    actorUserId: "user_owner",
  };
  const nodeRegistry = createNodeRegistry();
  const app = buildApp(ctx, { nodeRegistry });
  await app.ready();
  return {
    app,
    ctx,
    db,
    nodeRegistry,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
