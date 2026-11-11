import { once } from "node:events";
import { PgliteDbClient, PostgresDbClient, type PostgresDbClientOptions } from "@artoo/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "./main.js";
import * as publishers from "./ws/event-publisher.js";

// Controlled lifecycle integration. Actual network PostgreSQL/locking is tested
// separately by storage's explicit PostgreSQL suite, not by these doubles.
describe("remote database server lifecycle", () => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(async () => { await server?.close(); server = undefined; vi.restoreAllMocks(); });
  const env = {
    NODE_ENV: "production", ARTOO_HOST: "127.0.0.1", PORT: "0",
    ARTOO_DATABASE_URL: "postgresql://controlled.test/artoo",
    ARTOO_PAIRING_PEPPER: "controlled-pairing-pepper", GOOGLE_CLIENT_ID: "controlled-client",
    GOOGLE_CLIENT_SECRET: "controlled-secret", GOOGLE_REDIRECT_URI: "https://artoo.example.test/auth/google/callback",
    AUTH_ALLOWED_EMAILS: "owner@example.test", AUTH_OWNER_EMAILS: "owner@example.test",
  };

  it("selects PostgreSQL, honors platform PORT, and keeps production authentication", async () => {
    const database = await PgliteDbClient.create();
    const close = vi.spyOn(database, "close");
    const create = vi.spyOn(PostgresDbClient, "create").mockResolvedValue(database as unknown as PostgresDbClient);
    server = await startServer(env);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ connectionString: env.ARTOO_DATABASE_URL, onFatal: expect.any(Function) }));
    expect(server.persistent).toBe(true);
    expect(server.app.server.address()).toMatchObject({ address: "127.0.0.1" });
    expect((await server.app.inject({ url: "/health/ready" })).statusCode).toBe(200);
    expect((await server.app.inject({ url: "/api/v1/bootstrap" })).statusCode).toBe(401);
    await server.close();
    await server.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the live server and its database after a fatal ownership event", async () => {
    const database = await PgliteDbClient.create();
    const close = vi.spyOn(database, "close");
    let driverOptions: PostgresDbClientOptions | undefined;
    vi.spyOn(PostgresDbClient, "create").mockImplementation(async options => {
      driverOptions = options;
      return database as unknown as PostgresDbClient;
    });
    const onFatal = vi.fn();
    server = await startServer(env, { onFatal });
    const closed = once(server.app.server, "close");
    driverOptions!.onFatal!(new Error("controlled session loss"));
    await closed;
    await server.close();
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(server.app.server.listening).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(database.healthCheck()).rejects.toThrow();
  });

  it("stops a publisher timer installed after shutdown began during startup", async () => {
    const database = await PgliteDbClient.create();
    let driverOptions: PostgresDbClientOptions | undefined;
    vi.spyOn(PostgresDbClient, "create").mockImplementation(async options => {
      driverOptions = options;
      return database as unknown as PostgresDbClient;
    });
    let started!: () => void, resume!: () => void;
    const starting = new Promise<void>(resolve => { started = resolve; });
    const paused = new Promise<void>(resolve => { resume = resolve; });
    let timer: ReturnType<typeof setInterval> | undefined;
    vi.spyOn(publishers, "createEventPublisher").mockReturnValue({
      pumpOnce: async () => {},
      start: async () => { started(); await paused; timer = setInterval(() => {}, 1000); },
      stop: () => { clearInterval(timer); timer = undefined; },
    });
    const startup = startServer(env).then(result => { server = result; return undefined; }, error => error as Error);
    try {
      await Promise.race([starting, startup.then(error => { if (error) throw error; })]);
      driverOptions!.onFatal!(new Error("controlled startup session loss"));
      resume();
      expect((await startup)?.message).toContain("Database ownership was lost during startup");
      expect(timer).toBeUndefined();
    } finally { resume(); await startup; clearInterval(timer); }
  });
});
