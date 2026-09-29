import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrationStatements, organizations, seed } from "@artoo/db";
import { createSystemClock, createUlidIdGen } from "@artoo/domain";
import { PgliteDbClient } from "@artoo/storage";
import { buildApp, type DesktopCorsOptions } from "./app.js";
import { loadAuthConfig, type AuthConfig, type AuthConfigEnv } from "./auth/auth-config.js";
import { createFetchOidcHttp } from "./auth/oidc-client.js";
import { loadDeviceAuthConfig } from "./config/device-auth.js";
import type { ServerContext } from "./context.js";
import { createEventPublisher } from "./ws/event-publisher.js";
import { createWsHub } from "./ws/ws-hub.js";

function resolveAuthConfig(env: AuthConfigEnv, origin: string): AuthConfig {
  if (env.NODE_ENV === "production") return loadAuthConfig(env);
  return loadAuthConfig({
    ...env,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? "dev-client-id",
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ?? "dev-client-secret",
    GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI ?? `${origin}/auth/google/callback`,
  });
}

function desktopCors(env: NodeJS.ProcessEnv): DesktopCorsOptions | undefined {
  if (env.ARTOO_DESKTOP_CORS !== "1") return undefined;
  const allowedOrigins = (env.ARTOO_DESKTOP_CORS_ORIGINS ?? "null").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowedOrigins.includes("*")) throw new Error("Desktop CORS requires explicit allowed origins");
  return { allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ["null"] };
}

/** Production owns a durable data directory. Tests/dev may use an ephemeral
 * database. Validate credentials before opening or changing persistent data. */
export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === "production";
  const port = Number(env.ARTOO_PORT ?? "4000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid ARTOO_PORT");
  const host = env.ARTOO_HOST ?? "127.0.0.1";
  const authConfig = resolveAuthConfig(env, `http://${host}:${port}`);
  const deviceAuth = loadDeviceAuthConfig(env);
  if (!authConfig.enforceApiAuth && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Authentication is required when listening beyond loopback");
  }
  const cors = desktopCors(env);
  const dataRoot = resolve(env.ARTOO_DATA_DIR?.trim() || ".artoo");
  const dbDir = env.ARTOO_DB_DIR?.trim() || (production ? join(dataRoot, "db") : undefined);
  const artifactDir = env.ARTOO_ARTIFACT_DIR?.trim() || join(dataRoot, "artifacts");
  const workspaceRoot = env.ARTOO_WORKSPACE_ROOT?.trim() || (production ? join(dataRoot, "workspaces") : join(tmpdir(), "artoo-workspace"));
  const db = await PgliteDbClient.create(dbDir === undefined ? {} : { dataDir: resolve(dbDir) });
  try {
    await db.migrate(await loadMigrationStatements());
    if ((await db.db.select().from(organizations)).length === 0) {
      await seed(db, createSystemClock().nowIso(), {
        workspaceRoot, demoResources: !production,
        ownerEmail: authConfig.ownerEmails?.[0],
      });
    }
    const ctx: ServerContext = {
      db, clock: createSystemClock(), idGen: createUlidIdGen(),
      organizationId: "org_default", actorUserId: "user_owner",
      deviceAuth, authConfig, oidcHttp: createFetchOidcHttp(),
    };
    const wsHub = createWsHub();
    const app = buildApp(ctx, {
      wsHub, webDistDir: env.ARTOO_WEB_DIST, desktopCors: cors,
      enableDevRoutes: !production && env.ARTOO_ENABLE_DEV_ROUTES === "1",
      artifactDir: resolve(artifactDir),
    });
    const publisher = createEventPublisher(ctx, wsHub);
    try {
      await app.listen({ port, host });
      await publisher.start();
    } catch (error) {
      publisher.stop();
      await app.close();
      throw error;
    }
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      publisher.stop();
      await app.close();
      await db.close();
    })();
    return { app, ctx, close, dataRoot, persistent: dbDir !== undefined };
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const server = await startServer();
  const address = server.app.server.address();
  console.log(`Artoo server ready on ${typeof address === "object" && address ? address.port : address}; storage=${server.persistent ? "persistent" : "ephemeral"}`);
  const shutdown = (): void => { void server.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // Only a parent that deliberately created an IPC child can use this channel.
  // Windows service/package tests use the same graceful shutdown path.
  if (process.send !== undefined) {
    process.on("message", (message: unknown) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === "shutdown") {
        void server.close().finally(() => process.disconnect?.());
      }
    });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Server startup failed");
    process.exitCode = 1;
  });
}
