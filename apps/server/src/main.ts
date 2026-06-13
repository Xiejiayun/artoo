import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadMigrationStatements, organizations, seed } from "@artoo/db";
import { createSystemClock, createUlidIdGen } from "@artoo/domain";
import { PgliteDbClient } from "@artoo/storage";

import { buildApp } from "./app.js";
import type { ServerContext } from "./context.js";
import { createEventPublisher } from "./ws/event-publisher.js";
import { createWsHub } from "./ws/ws-hub.js";

/**
 * Dev server bootstrap: embedded PGlite + migrate + seed + Fastify listen, in one
 * command. Used for the cross-process node loop (artood connects to /api/v1/node)
 * and the web Playwright E2E.
 *
 *   ARTOO_PORT (default 4000), ARTOO_HOST (default 127.0.0.1),
 *   ARTOO_DB_DIR (default in-memory, fresh each run),
 *   ARTOO_WORKSPACE_ROOT (default os tmpdir/artoo-workspace).
 */
const PORT = Number(process.env.ARTOO_PORT ?? "4000");
const HOST = process.env.ARTOO_HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  const dbDir = process.env.ARTOO_DB_DIR;
  const db = await PgliteDbClient.create(dbDir !== undefined ? { dataDir: dbDir } : {});
  await db.migrate(await loadMigrationStatements());

  // Isolated workspace so a real ProcessAdapter never writes into the live repo.
  const configuredWorkspaceRoot = process.env.ARTOO_WORKSPACE_ROOT;
  const workspaceRoot =
    configuredWorkspaceRoot !== undefined && configuredWorkspaceRoot.trim() !== ""
      ? configuredWorkspaceRoot
      : join(tmpdir(), "artoo-workspace");
  const existing = await db.db.select().from(organizations);
  if (existing.length === 0) {
    await seed(db, createSystemClock().nowIso(), { workspaceRoot });
  }

  const ctx: ServerContext = {
    db,
    clock: createSystemClock(),
    idGen: createUlidIdGen(),
    organizationId: "org_default",
    actorUserId: "user_owner",
  };
  const wsHub = createWsHub();
  const app = buildApp(ctx, { wsHub });
  await app.listen({ port: PORT, host: HOST });

  // Begin streaming committed events to subscribed realtime clients.
  const publisher = createEventPublisher(ctx, wsHub);
  await publisher.start();

  // eslint-disable-next-line no-console
  console.log(
    [
      `artoo server listening on http://${HOST}:${PORT}`,
      `  REST:      http://${HOST}:${PORT}/api/v1/bootstrap`,
      `  node WS:   ws://${HOST}:${PORT}/api/v1/node?token=dev`,
      `  client WS: ws://${HOST}:${PORT}/api/v1/ws`,
      `  workspace: ${workspaceRoot}`,
    ].join("\n"),
  );
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
