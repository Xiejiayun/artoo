import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadMigrationStatements, organizations, seed } from "@artoo/db";
import { createSystemClock, createUlidIdGen } from "@artoo/domain";
import { PgliteDbClient, PostgresDbClient, SupabaseContentAddressedBlobStore } from "@artoo/storage";
import type { DesktopCorsOptions } from "./app.js";
import { createFetchOidcHttp } from "./auth/oidc-client.js";
import type { ServerAccessConfig } from "./server-access-config.js";
import { loadAiDataSharingPolicy } from "./config/ai-data-sharing.js";
import { closePreparedGoalSubmission, loadGoalEntryConfig } from "./config/goal-entry.js";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import { loadTrustedProxies } from "./config/trusted-proxies.js";
import { loadStorageConfig } from "./config/storage.js";
import { loadAuditSignerV1 } from "./config/audit-signing.js";
import type { ServerContext } from "./context.js";
import { createEventPublisher } from "./ws/event-publisher.js";
import { createWsHub } from "./ws/ws-hub.js";

function desktopCors(env: NodeJS.ProcessEnv): DesktopCorsOptions | undefined {
  if (env.ARTOO_DESKTOP_CORS !== "1") return undefined;
  const allowedOrigins = (env.ARTOO_DESKTOP_CORS_ORIGINS ?? "null")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedOrigins.includes("*")) throw new Error("Desktop CORS requires explicit allowed origins");
  return { allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ["null"] };
}

/** Production owns a durable data directory. Tests/dev may use an ephemeral
 * database. Validate credentials before opening or changing persistent data. */
export async function startServerRuntime(
  env: NodeJS.ProcessEnv,
  options: { onFatal?: () => void },
  access: ServerAccessConfig,
) {
  const { production, port, host, authConfig, deviceAuth } = access;
  const cors = desktopCors(env);
  const trustedProxies = loadTrustedProxies(env);
  const aiDataSharingPolicy = loadAiDataSharingPolicy(env);
  const goalEntry = loadGoalEntryConfig(env);
  const schedulerRollout = loadSchedulerRollout(env);
  const storage = loadStorageConfig(env);
  const auditSigner = await loadAuditSignerV1(env);
  const dataRoot = resolve(env.ARTOO_DATA_DIR?.trim() || ".artoo");
  const dbDir = env.ARTOO_DB_DIR?.trim() || (production ? join(dataRoot, "db") : undefined);
  const artifactDir = env.ARTOO_ARTIFACT_DIR?.trim() || join(dataRoot, "artifacts");
  const workspaceRoot =
    env.ARTOO_WORKSPACE_ROOT?.trim() || (production ? join(dataRoot, "workspaces") : join(tmpdir(), "artoo-workspace"));
  const artifactStore = storage.supabase ? await SupabaseContentAddressedBlobStore.create(storage.supabase) : undefined;
  const sslCa = storage.databaseCaFile ? await readFile(storage.databaseCaFile, "utf8") : undefined;
  let databaseFailed = false;
  let stopAfterFailure: (() => void) | undefined;
  // Both operations are independent after configuration validation. Observe both
  // outcomes before returning, so a failed import cannot orphan a later-opened DB.
  const [database, application] = await Promise.allSettled([
    storage.databaseUrl
      ? PostgresDbClient.create({
          connectionString: storage.databaseUrl,
          ...(sslCa ? { sslCa } : {}),
          onFatal: () => {
            databaseFailed = true;
            stopAfterFailure?.();
          },
        })
      : PgliteDbClient.create(dbDir === undefined ? {} : { dataDir: resolve(dbDir) }),
    import("./app.js"),
  ]);
  if (database.status === "rejected") {
    if (application.status === "rejected")
      throw new AggregateError([database.reason, application.reason], "Database and application loading failed", {
        cause: database.reason,
      });
    throw database.reason;
  }
  const db = database.value;
  let databaseClosing: Promise<void> | undefined;
  const closeDatabase = (): Promise<void> => (databaseClosing ??= db.close());
  try {
    if (application.status === "rejected") throw application.reason;
    const { buildApp } = application.value;
    await db.migrate(await loadMigrationStatements());
    if ((await db.db.select().from(organizations)).length === 0) {
      await seed(db, createSystemClock().nowIso(), {
        workspaceRoot,
        demoResources: !production,
        ownerEmail: authConfig.ownerEmails?.[0],
      });
    }
    const ctx: ServerContext = {
      db,
      clock: createSystemClock(),
      idGen: createUlidIdGen(),
      organizationId: "org_default",
      actorUserId: "user_owner",
      deviceAuth,
      authConfig,
      aiDataSharingPolicy,
      goalEntry,
      schedulerRollout,
      auditSigner,
      oidcHttp: createFetchOidcHttp(),
    };
    const wsHub = createWsHub();
    const app = buildApp(ctx, {
      wsHub,
      webDistDir: env.ARTOO_WEB_DIST,
      desktopCors: cors,
      trustedProxies,
      enableDevRoutes: !production && env.ARTOO_ENABLE_DEV_ROUTES === "1",
      artifactDir: resolve(artifactDir),
      ...(artifactStore ? { artifactStore } : {}),
    });
    const publisher = createEventPublisher(ctx, wsHub);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      // A pending publisher.start() may install its timer after an earlier
      // close. Startup's failure path calls close again to stop that late timer.
      publisher.stop();
      return (closing ??= (async () => {
        try {
          await app.close();
        } finally {
          await closeDatabase();
        }
      })());
    };
    stopAfterFailure = () => {
      options.onFatal?.();
      // The database has permanently fenced queries. Stop all dispatchers and
      // sockets too; a new container must acquire its own ownership session.
      void close().catch(() => {
        options.onFatal?.();
      });
    };
    try {
      if (databaseFailed) throw new Error("Database ownership was lost during startup");
      await app.listen({ port, host });
      await publisher.start(storage.eventPollMs);
      if (databaseFailed) throw new Error("Database ownership was lost during startup");
    } catch (error) {
      await close();
      throw error;
    }
    return {
      app,
      ctx,
      close,
      dataRoot,
      persistent: storage.databaseUrl !== undefined || dbDir !== undefined,
      closePreparedGoalSubmission: (identity: { session_id: string; request_key: string }) =>
        closePreparedGoalSubmission(ctx, identity),
    };
  } catch (error) {
    try {
      await closeDatabase();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Server startup and database cleanup failed", { cause: error });
    }
    throw error;
  }
}
